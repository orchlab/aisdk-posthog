/**
 * PostHog Span Exporter for Vercel AI SDK (v7+)
 *
 * Maps the OpenTelemetry spans emitted by `@ai-sdk/otel` (the `OpenTelemetry`
 * telemetry integration of `ai` v7) to PostHog LLM analytics events. Spans
 * carry OTel GenAI semantic-convention attributes (`gen_ai.*`), plus a few
 * `ai.*` extras when the integration enables supplemental attributes.
 *
 * Span mapping (keyed on `gen_ai.operation.name`):
 * - `invoke_agent`  (generateText / streamText / generateObject / ToolLoopAgent
 *   root span)                                      -> `$ai_trace`
 * - `chat`          (one model call, per step)      -> `$ai_generation`
 * - `execute_tool`  (tool execution)                -> `$ai_span` (tool)
 * - `agent_step` and everything else (embeddings…)  -> `$ai_span`
 * - spans created by `withExecutionTrace`           -> `$ai_trace` / `$ai_span`
 *
 * Custom metadata passed to `getTelemetry(fnId, metadata)` is stamped on every
 * span as `ai.telemetry.metadata.<key>` (same keys as AI SDK v6), so
 * `getContext` resolvers keep working unchanged.
 */

import type { Attributes } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode, hrTimeToMilliseconds } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { PostHog } from 'posthog-node';

import { EXECUTION_SPAN_ATTR, SYNTHETIC_ROOT_SPAN_ID } from './constants';
import type { Logger } from './logger';
import { consoleLogger } from './logger';
import { getModelCostBreakdown } from './pricing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextInfo {
  /** The distinct user ID for PostHog */
  distinctId: string;
  /** Workspace/group ID */
  groupId?: string;
  /** Group type (e.g., 'workspace') */
  groupType?: string;
  /** Session ID (e.g., chat UID) */
  sessionId?: string;
  /** Additional properties to merge into every event */
  properties?: Record<string, unknown>;
}

/**
 * Resolves user/workspace/session context for an emitted span. The `traceId`
 * and `spanAttributes` come straight from the OTel span. The optional
 * `executionUidByTraceId` is a precomputed lookup the factory provides when
 * `withExecutionTrace` registered an execution UID for this trace — without
 * it, child spans (tool calls, generations) that lose their `ai.telemetry.metadata.executionUid`
 * attribute across streaming boundaries would resolve no context.
 */
export type ContextResolver = (info: {
  traceId: string;
  spanAttributes: Record<string, unknown>;
  executionUidByTraceId?: string;
}) => ContextInfo | undefined;

export interface PostHogAISdkExporterOptions {
  /** PostHog project API key */
  apiKey: string;
  /** PostHog host (default: https://us.i.posthog.com) */
  host?: string;
  /** Enable privacy mode: redact inputs/outputs */
  privacyMode?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Resolve user context from span attributes */
  getContext?: ContextResolver;
  /** Flush threshold (default: 1 for serverless) */
  flushAt?: number;
  /**
   * Where cost is computed. `'server'` omits cost fields and lets PostHog
   * fill them in. `'client'` computes via `llm-info`. Default: `'server'`.
   */
  costCalculation?: 'server' | 'client';
  /**
   * Returns true when the given traceId belongs to an execution span
   * (created by `withExecutionTrace`). Used to demote AI SDK outer
   * trace spans (`ai.streamText`) so they don't replace the execution
   * root in PostHog.
   */
  hasExecutionTrace?: (traceId: string) => boolean;
  /**
   * Returns the executionUid registered for the given traceId by
   * `withExecutionTrace`, if any. Forwarded to the context resolver as
   * `executionUidByTraceId` so consumers can recover context for
   * streaming-orphaned child spans without sharing internal state.
   */
  getExecutionUidByTraceId?: (traceId: string) => string | undefined;
  /** Optional logger (defaults to console). */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REDACTED = '[REDACTED]';

type SpanKindName =
  'execution' | 'trace' | 'step' | 'generation' | 'tool' | 'other';

/**
 * Classifies a span. Returns undefined for spans that are not AI SDK /
 * execution spans (they are ignored).
 */
function classifySpan(attrs: Attributes): SpanKindName | undefined {
  if (getAttr(attrs, EXECUTION_SPAN_ATTR) === 'true') {
    return 'execution';
  }
  switch (getAttr(attrs, 'gen_ai.operation.name')) {
    case undefined:
      return undefined;
    case 'invoke_agent':
      return 'trace';
    case 'agent_step':
      return 'step';
    case 'chat':
      return 'generation';
    case 'execute_tool':
      return 'tool';
    default:
      return 'other';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAttr(attrs: Attributes, key: string): string | undefined {
  const val = attrs[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  return String(val);
}

function getNumAttr(attrs: Attributes, key: string): number | undefined {
  const val = attrs[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  const num = Number(val);
  return Number.isNaN(num) ? undefined : num;
}

function safeParse(json: string | undefined): unknown {
  if (!json) {
    return undefined;
  }
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** A part of a `gen_ai.*.messages` message (OTel GenAI semconv). */
interface GenAiPart {
  type?: string;
  content?: unknown;
  id?: string | null;
  name?: string;
  arguments?: unknown;
  response?: unknown;
  mime_type?: string;
  modality?: string;
  uri?: string;
}

interface GenAiMessage {
  role?: string;
  parts?: GenAiPart[];
}

function parseMessages(raw: string | undefined): GenAiMessage[] | undefined {
  const parsed = safeParse(raw);
  return Array.isArray(parsed) ? (parsed as GenAiMessage[]) : undefined;
}

function textOf(parts: GenAiPart[] | undefined): string {
  return (parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => String(p.content ?? ''))
    .join('');
}

/**
 * Converts one GenAI-semconv part into a PostHog content block. Binary
 * payloads are dropped (large and not useful in analytics).
 */
function convertPart(part: GenAiPart): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.content };
    case 'reasoning':
      return { type: 'reasoning', text: part.content };
    case 'tool_call':
      return {
        type: 'tool-call',
        id: part.id ?? '',
        function: { name: part.name ?? 'unknown', arguments: part.arguments },
      };
    case 'tool_call_response':
      return {
        type: 'tool-result',
        id: part.id ?? '',
        result: part.response,
      };
    case 'blob':
      return {
        type: 'blob',
        mime_type: part.mime_type,
        modality: part.modality,
      };
    case 'uri':
      return { type: 'uri', uri: part.uri, mime_type: part.mime_type };
    default:
      return { type: String(part.type) };
  }
}

/**
 * Converts GenAI-semconv messages to PostHog `{ role, content }` messages.
 * Text-only messages collapse to a plain string; anything else becomes an
 * array of content blocks.
 */
function convertMessages(messages: GenAiMessage[]): unknown[] {
  return messages.map((msg) => {
    const parts = msg.parts ?? [];
    const textOnly = parts.every((p) => p.type === 'text');
    return {
      role: msg.role ?? 'user',
      content: textOnly ? textOf(parts) : parts.map(convertPart),
    };
  });
}

function numAttrSum(attrs: Attributes, ...keys: string[]): number | undefined {
  const values = keys.map((k) => getNumAttr(attrs, k));
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length > 0 ? defined.reduce((a, b) => a + b, 0) : undefined;
}

/** Token usage shared by `invoke_agent` and `chat` spans. */
function usageProps(attrs: Attributes): Record<string, unknown> {
  const inputTokens = getNumAttr(attrs, 'gen_ai.usage.input_tokens');
  const outputTokens = getNumAttr(attrs, 'gen_ai.usage.output_tokens');
  const reasoningTokens = getNumAttr(
    attrs,
    'ai.usage.outputTokenDetails.reasoningTokens',
  );
  const cachedInputTokens = getNumAttr(
    attrs,
    'gen_ai.usage.cache_read.input_tokens',
  );
  const cacheWriteTokens = getNumAttr(
    attrs,
    'gen_ai.usage.cache_creation.input_tokens',
  );
  const totalTokens = numAttrSum(
    attrs,
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
  );
  return {
    ...(inputTokens !== undefined && { $ai_input_tokens: inputTokens }),
    ...(outputTokens !== undefined && { $ai_output_tokens: outputTokens }),
    ...(totalTokens !== undefined && { $ai_total_tokens: totalTokens }),
    ...(reasoningTokens !== undefined && {
      $ai_reasoning_tokens: reasoningTokens,
    }),
    ...(cachedInputTokens !== undefined && {
      $ai_cache_read_input_tokens: cachedInputTokens,
    }),
    ...(cacheWriteTokens !== undefined && {
      $ai_cache_creation_input_tokens: cacheWriteTokens,
    }),
  };
}

/** First entry of `gen_ai.response.finish_reasons` (a string array). */
function finishReason(attrs: Attributes): string | undefined {
  const raw = attrs['gen_ai.response.finish_reasons'];
  if (Array.isArray(raw)) {
    return raw.length > 0 ? String(raw[0]) : undefined;
  }
  return raw === undefined || raw === null ? undefined : String(raw);
}

/**
 * Truncates large JSON string values for storage efficiency.
 * PostHog has limits on property sizes; truncate to a reasonable threshold.
 */
function truncate(
  value: string | undefined,
  maxLen = 50_000,
): string | undefined {
  if (!value) {
    return value;
  }
  if (value.length <= maxLen) {
    return value;
  }
  return value.substring(0, maxLen) + '... [truncated]';
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

export class PostHogAISdkExporter implements SpanExporter {
  private client: PostHog;
  private options: PostHogAISdkExporterOptions;
  private logger: Logger;
  private traceContextCache = new Map<string, ContextInfo>();
  private exportCount = 0;

  /** Cache TTL: 5 minutes */
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;
  private lastCacheCleanup = Date.now();

  /**
   * Spans buffered per traceId while waiting for the execution root span.
   * Streaming breaks OTel context propagation inside the AI SDK, so child
   * spans (doStream, toolCall) lose their `ai.streamText` parent and become
   * flat siblings. Buffering lets us fix the hierarchy via temporal
   * containment before emitting to PostHog.
   */
  private pendingSpans = new Map<string, ReadableSpan[]>();

  constructor(options: PostHogAISdkExporterOptions) {
    this.options = options;
    this.logger = options.logger ?? consoleLogger();
    this.client = new PostHog(options.apiKey, {
      host: options.host || 'https://us.i.posthog.com',
      flushAt: options.flushAt ?? 1,
    });

    if (options.debug) {
      this.logger.info(
        '[PostHogAISdk] Initialized',
        `host=${options.host || 'https://us.i.posthog.com'}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // SpanExporter interface
  // -----------------------------------------------------------------------

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.exportCount++;

    // Periodic cache cleanup
    const now = Date.now();
    if (now - this.lastCacheCleanup > this.CACHE_TTL_MS) {
      this.traceContextCache.clear();
      this.lastCacheCleanup = now;
    }

    for (const span of spans) {
      this.extractAndCacheContext(span);

      if (!classifySpan(span.attributes)) {
        continue;
      }

      const traceId = span.spanContext().traceId;
      const rawParentId = span.parentSpanContext?.spanId || undefined;
      const isExecutionSpan =
        getAttr(span.attributes, EXECUTION_SPAN_ATTR) === 'true';
      // Only the outermost execution span (whose parent is the synthetic
      // SYNTHETIC_ROOT_SPAN_ID context) is the execution root that triggers
      // flush. Nested execution spans inside the same trace inherit a real
      // parent and are buffered like any other child span.
      const isExecutionRoot =
        isExecutionSpan &&
        (!rawParentId || rawParentId === SYNTHETIC_ROOT_SPAN_ID);
      const underExecution = this.options.hasExecutionTrace?.(traceId);

      if (isExecutionRoot) {
        // Outermost execution span arrived (ends last) — flush buffer.
        this.flushPendingSpans(traceId, span);
      } else if (underExecution) {
        // Buffer child spans until the execution root arrives so we can
        // fix parent-child relationships broken by streaming.
        let buf = this.pendingSpans.get(traceId);
        if (!buf) {
          buf = [];
          this.pendingSpans.set(traceId, buf);
        }
        buf.push(span);
      } else {
        // Standalone span (not under an execution) — process immediately.
        try {
          this.processSpan(span);
        } catch (err) {
          if (this.options.debug) {
            this.logger.error('[PostHogAISdk] Error processing span:', err);
          }
        }
      }
    }

    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this.client.flush();
  }

  // -----------------------------------------------------------------------
  // Execution trace flush — fix parent-child relationships
  // -----------------------------------------------------------------------

  /**
   * Called when the execution root span arrives. Re-parents buffered child
   * spans under their enclosing `ai.streamText` / `ai.generateText` span
   * using temporal containment (start/end time overlap).
   */
  private flushPendingSpans(
    traceId: string,
    executionSpan: ReadableSpan,
  ): void {
    const buffered = this.pendingSpans.get(traceId) || [];
    this.pendingSpans.delete(traceId);

    // Collect container spans (invoke_agent + agent_step) with time ranges.
    // These are the intermediate parents we want to restore.
    const containers: {
      spanId: string;
      startMs: number;
      endMs: number;
    }[] = [];
    // Spans whose OTel parent link is trustworthy: containers, and generic
    // spans (e.g. an `embeddings` root with child spans).
    const trustedParentIds = new Set<string>();

    for (const span of buffered) {
      const spanId = span.spanContext().spanId;
      const kind = classifySpan(span.attributes);
      if (kind === 'trace' || kind === 'step' || kind === 'other') {
        trustedParentIds.add(spanId);
      }
      if (kind === 'trace' || kind === 'step') {
        containers.push({
          spanId,
          startMs: hrTimeToMilliseconds(span.startTime),
          endMs: hrTimeToMilliseconds(span.endTime),
        });
      }
    }

    // Build a parentId override map for spans whose OTel parent was broken
    // by streaming (TransformStream boundaries lose async context).
    //
    // Trust the actual OTel parent when it points to a container (or generic)
    // span — this is critical for parallel sub-agents where temporal containment would
    // match the wrong parent due to overlapping time ranges.
    const parentOverrides = new Map<string, string>();

    for (const span of buffered) {
      const kind = classifySpan(span.attributes);
      if (kind === 'trace' || kind === 'step' || kind === 'execution') {
        continue; // Only re-parent generation / tool / generic spans
      }

      // If the span already has a valid parent pointing to a trusted span,
      // the OTel context propagation worked — no override needed.
      const actualParentId = span.parentSpanContext?.spanId;
      if (actualParentId && trustedParentIds.has(actualParentId)) {
        continue;
      }

      // Temporal containment fallback for broken parents (streaming path)
      const spanStartMs = hrTimeToMilliseconds(span.startTime);
      let bestParent: string | undefined;
      let bestDuration = Infinity;
      for (const top of containers) {
        if (spanStartMs >= top.startMs && spanStartMs <= top.endMs) {
          const duration = top.endMs - top.startMs;
          if (duration < bestDuration) {
            bestDuration = duration;
            bestParent = top.spanId;
          }
        }
      }
      if (bestParent) {
        parentOverrides.set(span.spanContext().spanId, bestParent);
      }
    }

    // Process all spans (buffered children + execution root), sorted
    // chronologically so PostHog renders them in the correct order.
    const allSpans = [...buffered, executionSpan];
    allSpans.sort(
      (a, b) =>
        hrTimeToMilliseconds(a.startTime) - hrTimeToMilliseconds(b.startTime),
    );
    for (const span of allSpans) {
      try {
        this.processSpan(span, parentOverrides);
      } catch (err) {
        if (this.options.debug) {
          this.logger.error('[PostHogAISdk] Error processing span:', err);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Context resolution
  // -----------------------------------------------------------------------

  private extractAndCacheContext(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    if (this.traceContextCache.has(traceId)) {
      return;
    }

    const ctx = this.resolveContext(span);
    if (ctx) {
      this.traceContextCache.set(traceId, ctx);
    }
  }

  private resolveContext(span: ReadableSpan): ContextInfo | undefined {
    if (!this.options.getContext) {
      return undefined;
    }

    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(span.attributes)) {
      attrs[key] = value;
    }

    const traceId = span.spanContext().traceId;
    return this.options.getContext({
      traceId,
      spanAttributes: attrs,
      executionUidByTraceId: this.options.getExecutionUidByTraceId?.(traceId),
    });
  }

  private getContextForSpan(span: ReadableSpan): ContextInfo | undefined {
    // Try direct resolution first
    const direct = this.resolveContext(span);
    if (direct) {
      return direct;
    }

    // Fall back to cached trace context
    return this.traceContextCache.get(span.spanContext().traceId);
  }

  // -----------------------------------------------------------------------
  // Span classification & dispatch
  // -----------------------------------------------------------------------

  private processSpan(
    span: ReadableSpan,
    parentOverrides?: Map<string, string>,
  ): void {
    const kind = classifySpan(span.attributes);

    // Only process AI SDK / execution spans
    if (!kind) {
      return;
    }

    const context = this.getContextForSpan(span);
    const baseProps = this.getBaseProperties(span, context, parentOverrides);
    // Use span start time as event timestamp so PostHog orders events chronologically
    const timestamp = new Date(hrTimeToMilliseconds(span.startTime));

    switch (kind) {
      case 'execution':
        this.reportExecutionTrace(span, baseProps, context, timestamp);
        break;
      case 'trace': {
        const underExecution = this.options.hasExecutionTrace?.(
          span.spanContext().traceId,
        );
        if (underExecution) {
          // Already nested under a withExecutionTrace — demote to a plain
          // span so it doesn't create a duplicate $ai_trace.
          this.reportSpan(span, baseProps, context, timestamp);
        } else {
          // Standalone AI SDK call (no execution wrapper) — keep as trace.
          this.reportTrace(span, baseProps, context, timestamp);
        }
        break;
      }
      case 'generation':
        this.reportGeneration(span, baseProps, context, timestamp);
        break;
      case 'tool':
        this.reportTool(span, baseProps, context, timestamp);
        break;
      default:
        // agent_step, embeddings, other AI spans
        this.reportSpan(span, baseProps, context, timestamp);
    }
  }

  // -----------------------------------------------------------------------
  // Base properties (common to all events)
  // -----------------------------------------------------------------------

  private getBaseProperties(
    span: ReadableSpan,
    context: ContextInfo | undefined,
    parentOverrides?: Map<string, string>,
  ): Record<string, unknown> {
    const attrs = span.attributes;
    const durationMs =
      hrTimeToMilliseconds(span.endTime) - hrTimeToMilliseconds(span.startTime);

    const spanId = span.spanContext().spanId;
    const rawParentId = span.parentSpanContext?.spanId || undefined;

    return {
      $ai_trace_id: span.spanContext().traceId,
      $ai_span_id: spanId,
      $ai_parent_id: parentOverrides?.get(spanId) ?? rawParentId,
      $ai_span_name:
        (getAttr(attrs, 'gen_ai.operation.name') === 'invoke_agent' &&
          getAttr(attrs, 'gen_ai.agent.name')) ||
        span.name,
      $ai_latency: durationMs / 1000, // seconds
      $ai_is_error: span.status.code === SpanStatusCode.ERROR,
      ...(span.status.message && { $ai_error: span.status.message }),
      ...(context?.sessionId && { $ai_session_id: context.sessionId }),
      $ai_framework: 'aisdk',
      // Model info (available on most AI SDK spans)
      ...(getAttr(attrs, 'gen_ai.request.model') && {
        $ai_model: getAttr(attrs, 'gen_ai.request.model'),
      }),
      ...(getAttr(attrs, 'gen_ai.provider.name') && {
        $ai_provider: getAttr(attrs, 'gen_ai.provider.name'),
      }),
    };
  }

  // -----------------------------------------------------------------------
  // $ai_trace event (outer invoke_agent spans)
  // -----------------------------------------------------------------------

  private reportTrace(
    span: ReadableSpan,
    baseProps: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    const attrs = span.attributes;
    const privacy = this.options.privacyMode;

    const reason = finishReason(attrs);
    const properties: Record<string, unknown> = {
      ...baseProps,
      ...usageProps(attrs),
      ...(reason && { $ai_output_finish_reason: reason }),
    };

    // Input/output for traces
    if (!privacy) {
      const input = this.buildInput(attrs);
      if (input !== undefined) {
        properties.$ai_input = input;
      }
      const outputMessages = parseMessages(
        getAttr(attrs, 'gen_ai.output.messages'),
      );
      // The agent root span's output also carries tool calls/results; the
      // trace output is the text of the final assistant message.
      const responseText = textOf(outputMessages?.at(-1)?.parts);
      if (responseText) {
        properties.$ai_output_choices = [
          { role: 'assistant', content: truncate(responseText) },
        ];
      }
    } else {
      properties.$ai_input = REDACTED;
      properties.$ai_output_choices = REDACTED;
    }

    this.capture('$ai_trace', properties, context, timestamp);
  }

  /**
   * Builds `$ai_input` from `gen_ai.system_instructions` +
   * `gen_ai.input.messages`. Returns undefined when neither is recorded.
   */
  private buildInput(attrs: Attributes): unknown[] | undefined {
    const input: unknown[] = [];
    const system = safeParse(getAttr(attrs, 'gen_ai.system_instructions'));
    if (Array.isArray(system) && system.length > 0) {
      input.push({
        role: 'system',
        content: textOf(system as GenAiPart[]),
      });
    }
    const messages = parseMessages(getAttr(attrs, 'gen_ai.input.messages'));
    if (messages) {
      input.push(...convertMessages(messages));
    }
    return input.length > 0 ? input : undefined;
  }

  // -----------------------------------------------------------------------
  // $ai_generation event (chat spans: one model call per step)
  // -----------------------------------------------------------------------

  private reportGeneration(
    span: ReadableSpan,
    baseProps: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    const attrs = span.attributes;
    const privacy = this.options.privacyMode;

    const inputTokens = getNumAttr(attrs, 'gen_ai.usage.input_tokens');
    const outputTokens = getNumAttr(attrs, 'gen_ai.usage.output_tokens');

    // Model parameters
    const temperature = getNumAttr(attrs, 'gen_ai.request.temperature');
    const maxTokens = getNumAttr(attrs, 'gen_ai.request.max_tokens');

    // Only streaming calls report a time to first chunk (seconds).
    const timeToFirstChunk = getNumAttr(
      attrs,
      'gen_ai.client.operation.time_to_first_chunk',
    );
    const isStream = timeToFirstChunk !== undefined;

    // Model ID for cost calculation
    const modelId =
      getAttr(attrs, 'gen_ai.response.model') ??
      getAttr(attrs, 'gen_ai.request.model');

    // Cost calculation. In `'server'` mode (default) we omit the cost fields
    // and let PostHog enrich server-side from `$ai_model` + token counts.
    // Per-event overrides are still possible via `context.properties` because
    // `capture()` merges them in last and so wins over what we set here.
    const cost =
      this.options.costCalculation === 'client'
        ? getModelCostBreakdown(modelId, inputTokens, outputTokens)
        : {};

    const reason = finishReason(attrs);
    const properties: Record<string, unknown> = {
      ...baseProps,
      ...usageProps(attrs),
      ...(cost.inputCostUsd !== undefined && {
        $ai_input_cost_usd: cost.inputCostUsd,
      }),
      ...(cost.outputCostUsd !== undefined && {
        $ai_output_cost_usd: cost.outputCostUsd,
      }),
      ...(cost.totalCostUsd !== undefined && {
        $ai_total_cost_usd: cost.totalCostUsd,
      }),
      ...(temperature !== undefined && { $ai_temperature: temperature }),
      ...(maxTokens !== undefined && { $ai_max_tokens: maxTokens }),
      $ai_stream: isStream,
      ...(timeToFirstChunk !== undefined && {
        $ai_time_to_first_token: timeToFirstChunk,
      }),
      ...(reason && { $ai_output_finish_reason: reason }),
      ...(getAttr(attrs, 'gen_ai.response.id') && {
        $ai_response_id: getAttr(attrs, 'gen_ai.response.id'),
      }),
    };

    // Input: messages and tools
    if (!privacy) {
      const input = this.buildInput(attrs);
      if (input !== undefined) {
        properties.$ai_input = input;
      }
      // gen_ai.tool.definitions is a JSON array of { name, description, … }
      const tools = safeParse(getAttr(attrs, 'gen_ai.tool.definitions'));
      if (Array.isArray(tools) && tools.length > 0) {
        properties.$ai_tools = (
          tools as { name?: string; description?: string }[]
        ).map((t) => ({
          name: t.name,
          description: t.description,
        }));
      }
    } else {
      properties.$ai_input = REDACTED;
    }

    // Output: response text / tool calls
    if (!privacy) {
      const outputMessages = parseMessages(
        getAttr(attrs, 'gen_ai.output.messages'),
      );
      if (outputMessages) {
        const parts = outputMessages.flatMap((m) => m.parts ?? []);
        const toolCalls = parts.filter((p) => p.type === 'tool_call');
        const responseText = textOf(parts);

        if (responseText) {
          properties.$ai_output_choices = [
            { role: 'assistant', content: truncate(responseText) },
          ];
        }

        // When the LLM responds with tool calls (no text), format them
        // as $ai_output_choices so PostHog can extract $ai_tools_called
        // and display them in the Tools tab.
        if (toolCalls.length > 0) {
          properties.$ai_response_tool_calls = truncate(
            JSON.stringify(
              toolCalls.map((tc) => ({
                toolCallId: tc.id ?? '',
                toolName: tc.name ?? 'unknown',
                input: tc.arguments,
              })),
            ),
          );

          if (!properties.$ai_output_choices) {
            properties.$ai_output_choices = [
              {
                role: 'assistant',
                content: toolCalls.map((tc) => ({
                  type: 'tool-call',
                  function: { name: tc.name ?? 'unknown' },
                  id: tc.id ?? '',
                })),
              },
            ];
          }
        }
      }
    } else {
      properties.$ai_output_choices = REDACTED;
    }

    // Model parameters object
    const modelParams: Record<string, unknown> = {};
    const topP = getNumAttr(attrs, 'gen_ai.request.top_p');
    const topK = getNumAttr(attrs, 'gen_ai.request.top_k');
    const frequencyPenalty = getNumAttr(
      attrs,
      'gen_ai.request.frequency_penalty',
    );
    const presencePenalty = getNumAttr(
      attrs,
      'gen_ai.request.presence_penalty',
    );

    if (topP !== undefined) {
      modelParams.top_p = topP;
    }
    if (topK !== undefined) {
      modelParams.top_k = topK;
    }
    if (frequencyPenalty !== undefined) {
      modelParams.frequency_penalty = frequencyPenalty;
    }
    if (presencePenalty !== undefined) {
      modelParams.presence_penalty = presencePenalty;
    }

    if (Object.keys(modelParams).length > 0) {
      properties.$ai_model_parameters = modelParams;
    }

    this.capture('$ai_generation', properties, context, timestamp);
  }

  // -----------------------------------------------------------------------
  // $ai_span event (execute_tool spans)
  // -----------------------------------------------------------------------

  private reportTool(
    span: ReadableSpan,
    baseProps: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    const attrs = span.attributes;
    const privacy = this.options.privacyMode;
    const toolName = getAttr(attrs, 'gen_ai.tool.name');

    const properties: Record<string, unknown> = {
      ...baseProps,
      $ai_span_name: toolName ? `tool: ${toolName}` : span.name,
    };

    if (!privacy) {
      const args = getAttr(attrs, 'gen_ai.tool.call.arguments');
      if (args) {
        properties.$ai_input_state = safeParse(args) ?? args;
      }
      const result = getAttr(attrs, 'gen_ai.tool.call.result');
      if (result) {
        properties.$ai_output_state = safeParse(result) ?? result;
      }
    } else {
      properties.$ai_input_state = REDACTED;
      properties.$ai_output_state = REDACTED;
    }

    this.capture('$ai_span', properties, context, timestamp);
  }

  // -----------------------------------------------------------------------
  // $ai_trace event (execution-level parent span from withExecutionTrace)
  // -----------------------------------------------------------------------

  private reportExecutionTrace(
    span: ReadableSpan,
    baseProps: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    // Only the root execution span (whose parent is the synthetic
    // SYNTHETIC_ROOT_SPAN_ID context) should be a $ai_trace. Nested
    // execution spans keep their parent and are reported as $ai_span so
    // PostHog doesn't deduplicate them.
    const rawParentId = span.parentSpanContext?.spanId || undefined;
    const isRoot = !rawParentId || rawParentId === SYNTHETIC_ROOT_SPAN_ID;
    const properties: Record<string, unknown> = { ...baseProps };

    if (isRoot) {
      delete properties.$ai_parent_id;
      this.capture('$ai_trace', properties, context, timestamp);
    } else {
      this.capture('$ai_span', properties, context, timestamp);
    }
  }

  // -----------------------------------------------------------------------
  // $ai_span event (generic / embed / other)
  // -----------------------------------------------------------------------

  private reportSpan(
    span: ReadableSpan,
    baseProps: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    // Token usage is only present on spans that report it (e.g. embeddings);
    // `agent_step` spans don't carry gen_ai.usage.*, so this adds nothing.
    this.capture(
      '$ai_span',
      { ...baseProps, ...usageProps(span.attributes) },
      context,
      timestamp,
    );
  }

  // -----------------------------------------------------------------------
  // PostHog capture
  // -----------------------------------------------------------------------

  private capture(
    event: string,
    properties: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    const distinctId = context?.distinctId || 'system';

    // Merge context properties
    if (context?.properties) {
      Object.assign(properties, context.properties);
    }

    const captureParams: {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
      groups?: Record<string, string>;
      timestamp?: Date;
    } = {
      distinctId,
      event,
      properties,
      ...(timestamp && { timestamp }),
    };

    if (context?.groupType && context?.groupId) {
      captureParams.groups = { [context.groupType]: context.groupId };
    }

    if (this.options.debug) {
      this.logger.debug(`[PostHogAISdk] Capturing ${event}`, {
        distinctId,
        model: properties.$ai_model,
        traceId: properties.$ai_trace_id,
      });
    }

    this.client.capture(captureParams);
  }
}
