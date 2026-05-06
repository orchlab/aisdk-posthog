/**
 * Factory for the AI SDK PostHog telemetry instance.
 *
 * Builds a dedicated OTel TracerProvider backed by `PostHogAISdkExporter`
 * and exposes the helpers consumers need to thread `experimental_telemetry`
 * through `generateText` / `streamText` calls and to wrap top-level
 * executions in a parent span with a deterministic traceId.
 *
 * Usage:
 * ```ts
 * const telemetry = createAISDKTelemetry({ apiKey: process.env.POSTHOG_API_KEY!, enabled: true });
 *
 * const result = await generateText({
 *   model,
 *   messages,
 *   experimental_telemetry: telemetry.getTelemetry('chat', { executionUid }),
 * });
 * ```
 */

import { createHash } from 'node:crypto';

import type { Context, Tracer } from '@opentelemetry/api';
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  context,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { EXECUTION_SPAN_ATTR, SYNTHETIC_ROOT_SPAN_ID } from './constants';
import { ErrorLoggingSpanProcessor } from './errorLoggingSpanProcessor';
import { consoleLogger } from './logger';
import type { Logger } from './logger';
import { PostHogAISdkExporter } from './posthogExporter';
import type { AISDKTelemetryOptions, AiSdkTelemetryConfig } from './types';

export interface AISDKTelemetryInstance {
  /**
   * Returns an `experimental_telemetry` config to pass to AI SDK calls,
   * or `undefined` when the instance is disabled (so the field can be
   * spread safely).
   */
  getTelemetry(
    functionId: string,
    metadata?: Record<string, string>,
  ): AiSdkTelemetryConfig | undefined;

  /**
   * Wraps a callback in an OTel parent span so all AI SDK spans created
   * inside inherit the same `traceId` (derived deterministically from
   * `executionUid`). Returns `fn()`'s result; rethrows on error.
   *
   * No-op when the instance is disabled — `fn()` runs directly.
   */
  withExecutionTrace<T>(
    executionUid: string,
    operationId: string,
    metadata: Record<string, string>,
    fn: () => Promise<T>,
  ): Promise<T>;

  /**
   * Captures the active OTel context. Use at the top of a tool's
   * `execute` callback to preserve the parent span when async context
   * propagation breaks (e.g., across streaming boundaries).
   */
  captureSpanContext(): Context;

  /**
   * Deterministic OTel-compatible traceId (32 lowercase hex chars) derived
   * from `executionUid` via SHA-256. Stable across calls — admin panels can
   * compute the PostHog trace URL directly from `executionUid`.
   */
  toOtelTraceId(executionUid: string): string;

  /** Flushes the underlying PostHog client and tears down the tracer. */
  shutdown(): Promise<void>;

  /** Forces the underlying PostHog client to flush queued events. */
  flush(): Promise<void>;
}

/**
 * Deterministic OTel-compatible traceId (32 lowercase hex chars) derived
 * from `executionUid` via SHA-256. Pure — usable without a telemetry
 * instance (e.g. for admin panels that just need to compute the PostHog
 * trace URL from an executionUid).
 */
export function toOtelTraceId(executionUid: string): string {
  return createHash('sha256').update(executionUid).digest('hex').slice(0, 32);
}

// Module-level guard so callers that build multiple telemetry instances
// (multi-tenant Cloud Functions, tests) don't allocate a new
// AsyncLocalStorageContextManager on every `createAISDKTelemetry` call.
// OTel's setGlobalContextManager silently no-ops after the first call, but
// each invocation here would still allocate + enable() a manager that's
// then discarded. The guard is process-wide, intentionally — the context
// manager is also process-wide.
let globalContextManagerRegistered = false;

function createNoopInstance(): AISDKTelemetryInstance {
  return {
    getTelemetry: () => undefined,
    withExecutionTrace: (_executionUid, _operationId, _metadata, fn) => fn(),
    captureSpanContext: () => ROOT_CONTEXT,
    toOtelTraceId: toOtelTraceId,
    shutdown: async () => {},
    flush: async () => {},
  };
}

/**
 * Creates a self-contained AI SDK telemetry instance. Each call returns a
 * new instance with its own tracer, exporter, and `traceIdToExecutionUid`
 * map — there is no module-level state.
 */
export function createAISDKTelemetry(
  options: AISDKTelemetryOptions,
): AISDKTelemetryInstance {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return createNoopInstance();
  }

  if (!options.apiKey) {
    const logger = options.logger ?? consoleLogger();
    logger.warn(
      '[aisdk-posthog] No apiKey provided; falling back to no-op instance',
    );
    return createNoopInstance();
  }

  const logger = options.logger ?? consoleLogger();

  // Map traceId → executionUid so child spans (tool calls, etc.) that drop
  // their `ai.telemetry.metadata.executionUid` attribute across streaming
  // boundaries can still resolve context through the precomputed lookup
  // forwarded to the user-supplied resolver.
  const traceIdToExecutionUid = new Map<string, string>();

  const exporter = new PostHogAISdkExporter({
    apiKey: options.apiKey,
    host: options.host,
    debug: options.debug,
    privacyMode: options.privacyMode ?? false,
    flushAt: options.flushAt,
    getContext: options.getContext,
    hasExecutionTrace: (traceId) => traceIdToExecutionUid.has(traceId),
    getExecutionUidByTraceId: (traceId) => traceIdToExecutionUid.get(traceId),
    logger,
  });

  // Register an async context manager so `startActiveSpan()` propagates
  // the parent span across `await` boundaries. Without this, `context.active()`
  // always returns `ROOT_CONTEXT` and AI SDK spans won't nest under the
  // execution span. The module-level guard ensures we only allocate one
  // manager per process, even when multiple instances are created. Hosts
  // that already wire a context manager can opt out via
  // `registerGlobalContextManager: false`.
  if (
    options.registerGlobalContextManager !== false &&
    !globalContextManagerRegistered
  ) {
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    globalContextManagerRegistered = true;
  }

  const provider = new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor(exporter),
      new ErrorLoggingSpanProcessor(logger),
    ],
  });

  const tracer: Tracer = provider.getTracer(
    options.tracerName ?? 'aisdk-posthog',
    options.tracerVersion ?? '1.0.0',
  );

  if (options.debug) {
    logger.info('[aisdk-posthog] initialized', {
      host: options.host || 'https://us.i.posthog.com',
    });
  }

  return {
    toOtelTraceId: toOtelTraceId,

    captureSpanContext: () => context.active(),

    getTelemetry(functionId, metadata) {
      return {
        isEnabled: true,
        functionId,
        metadata: metadata || {},
        tracer,
      };
    },

    async withExecutionTrace(executionUid, operationId, metadata, fn) {
      // Marker attribute lets the exporter recognize this as an execution
      // span without coupling to a specific operationId naming scheme.
      // Caller-supplied metadata keys are stored verbatim — collisions with
      // OTel/AI SDK semconv attributes (`ai.*`, `gen_ai.*`) are the caller's
      // responsibility.
      const attrs: Record<string, string> = {
        'ai.operationId': operationId,
        'ai.telemetry.metadata.executionUid': executionUid,
        [EXECUTION_SPAN_ATTR]: 'true',
      };
      for (const [k, v] of Object.entries(metadata)) {
        attrs[k] = v;
      }

      const traceId = toOtelTraceId(executionUid);

      // If we're already inside a span with the same traceId, create a
      // child span instead of a new root — lets nested executions chain.
      const activeSpan = trace.getSpan(context.active());
      const activeTraceId = activeSpan?.spanContext().traceId;

      if (activeTraceId === traceId) {
        return tracer.startActiveSpan(
          operationId,
          { attributes: attrs },
          async (span) => {
            try {
              return await fn();
            } catch (err) {
              span.recordException(
                err instanceof Error ? err : new Error(String(err)),
              );
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
              });
              throw err;
            } finally {
              span.end();
            }
          },
        );
      }

      // Top-level: force a deterministic traceId derived from executionUid
      // so all spans for the same execution appear in one PostHog trace.
      const parentCtx = trace.setSpanContext(context.active(), {
        traceId,
        spanId: SYNTHETIC_ROOT_SPAN_ID,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });

      // Register traceId → executionUid BEFORE any child spans are exported,
      // so tool call spans can resolve context via their shared traceId.
      traceIdToExecutionUid.set(traceId, executionUid);

      return tracer.startActiveSpan(
        operationId,
        { attributes: attrs },
        parentCtx,
        async (span) => {
          try {
            return await fn();
          } catch (err) {
            span.recordException(
              err instanceof Error ? err : new Error(String(err)),
            );
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            throw err;
          } finally {
            span.end();
            // Late-arriving tool result spans can still need the lookup;
            // wait a bit before deleting the entry.
            setTimeout(
              () => traceIdToExecutionUid.delete(traceId),
              30_000,
            ).unref?.();
          }
        },
      );
    },

    async flush() {
      // Cascades to every processor's forceFlush (SimpleSpanProcessor
      // forwards to the exporter, which flushes the PostHog client).
      await provider.forceFlush();
    },

    async shutdown() {
      // Cascades to every processor's shutdown (SimpleSpanProcessor
      // forwards to the exporter, which shuts down the PostHog client).
      await provider.shutdown();
    },
  };
}

// Re-export Logger here so consumers can import the type alongside the
// factory without reaching into ./logger directly.
export type { Logger };
