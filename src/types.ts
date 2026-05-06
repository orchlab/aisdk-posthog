import type { Tracer } from '@opentelemetry/api';

import type { Logger } from './logger';
import type { ContextResolver } from './posthogExporter';

/**
 * Telemetry config shape matching the Vercel AI SDK's `experimental_telemetry`
 * option. Pass the return value of `instance.getTelemetry()` directly to
 * `generateText` / `streamText` / `generateObject` / `streamObject` calls.
 */
export interface AiSdkTelemetryConfig {
  isEnabled: true;
  functionId: string;
  metadata: Record<string, string>;
  tracer: Tracer;
}

export interface AISDKTelemetryOptions {
  /** PostHog project API key. Required. */
  apiKey: string;
  /** PostHog host (default: https://us.i.posthog.com). */
  host?: string;
  /**
   * Master switch. When false, the factory returns a no-op instance:
   * - `getTelemetry()` returns undefined
   * - `withExecutionTrace(_, _, _, fn)` runs `fn()` directly
   * - `captureSpanContext()` returns `ROOT_CONTEXT`
   * - `toOtelTraceId()` is still pure and works
   *
   * Defaults to true. Consumers are expected to compute this from their own
   * environment (e.g. `NODE_ENV === 'production'`) — the package does not
   * read environment variables itself.
   */
  enabled?: boolean;
  /** Verbose internal logging. */
  debug?: boolean;
  /** Redact prompt text and tool inputs/outputs in emitted events. */
  privacyMode?: boolean;
  /** PostHog client `flushAt` (default 1, suitable for serverless). */
  flushAt?: number;
  /**
   * Resolves the user / workspace / session context for an emitted span.
   * Receives the span's traceId, attribute map, and a precomputed lookup
   * of the executionUid bound to that traceId via `withExecutionTrace`.
   * Returning undefined causes the event to be attributed to `'system'`
   * (and dropped if the consumer's resolver chooses to).
   */
  getContext?: ContextResolver;
  /** Optional logger (defaults to `console`). */
  logger?: Logger;
  /**
   * Whether to install an `AsyncLocalStorageContextManager` as the global
   * OTel context manager. Required for parent-child span propagation across
   * `await` boundaries. Default: true. Set to false if your application
   * already registers a context manager — this call is process-wide and
   * subsequent calls are silent no-ops.
   */
  registerGlobalContextManager?: boolean;
  /** Tracer name surfaced via the OTel API (default: 'aisdk-posthog'). */
  tracerName?: string;
  /** Tracer version surfaced via the OTel API (default: '1.0.0'). */
  tracerVersion?: string;
}
