/**
 * PostHog Span Exporter for Vercel AI SDK
 *
 * Maps AI SDK OpenTelemetry spans to PostHog LLM analytics events.
 * AI SDK emits spans with `ai.*` prefixed attributes when
 * `experimental_telemetry` is enabled on generateText/streamText calls.
 *
 * Span mapping:
 * - `ai.generateText` / `ai.streamText` (outer)      -> `$ai_trace`
 * - `ai.generateText.doGenerate` / `ai.streamText.doStream` -> `$ai_generation`
 * - `ai.generateObject` / `ai.streamObject` (outer)   -> `$ai_trace`
 * - `ai.generateObject.doGenerate` / `ai.streamObject.doStream` -> `$ai_generation`
 * - `ai.toolCall`                                      -> `$ai_span` (tool)
 * - Other `ai.*` spans                                 -> `$ai_span`
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

/** AI SDK operation IDs that represent outer/trace-level spans */
const TRACE_OPERATIONS = new Set([
  'ai.generateText',
  'ai.streamText',
  'ai.generateObject',
  'ai.streamObject',
]);

/** AI SDK operation IDs that represent inner/generation-level spans */
const GENERATION_OPERATIONS = new Set([
  'ai.generateText.doGenerate',
  'ai.streamText.doStream',
  'ai.generateObject.doGenerate',
  'ai.streamObject.doStream',
]);

const TOOL_OPERATION = 'ai.toolCall';

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

      const operationId = getAttr(span.attributes, 'ai.operationId');
      if (!operationId) {
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

    // Collect TRACE_OPERATIONS spans (ai.streamText, etc.) with time ranges.
    // These are the intermediate parents we want to restore.
    const traceOpSpans: {
      spanId: string;
      startMs: number;
      endMs: number;
    }[] = [];
    const traceOpSpanIds = new Set<string>();

    for (const span of buffered) {
      const opId = getAttr(span.attributes, 'ai.operationId') || '';
      if (TRACE_OPERATIONS.has(opId)) {
        const spanId = span.spanContext().spanId;
        traceOpSpans.push({
          spanId,
          startMs: hrTimeToMilliseconds(span.startTime),
          endMs: hrTimeToMilliseconds(span.endTime),
        });
        traceOpSpanIds.add(spanId);
      }
    }

    // Build a parentId override map for spans whose OTel parent was broken
    // by streaming (TransformStream boundaries lose async context).
    //
    // Trust the actual OTel parent when it points to a known traceOp span —
    // this is critical for parallel sub-agents where temporal containment
    // would match the wrong parent due to overlapping time ranges.
    const parentOverrides = new Map<string, string>();

    for (const span of buffered) {
      const opId = getAttr(span.attributes, 'ai.operationId') || '';
      const isExecSpan =
        getAttr(span.attributes, EXECUTION_SPAN_ATTR) === 'true';
      if (TRACE_OPERATIONS.has(opId) || isExecSpan) {
        continue; // Only re-parent generation / tool / generic spans
      }

      // If the span already has a valid parent pointing to a traceOp span,
      // the OTel context propagation worked — no override needed.
      const actualParentId = span.parentSpanContext?.spanId;
      if (actualParentId && traceOpSpanIds.has(actualParentId)) {
        continue;
      }

      // Temporal containment fallback for broken parents (streaming path)
      const spanStartMs = hrTimeToMilliseconds(span.startTime);
      let bestParent: string | undefined;
      let bestDuration = Infinity;
      for (const top of traceOpSpans) {
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
    const operationId = getAttr(span.attributes, 'ai.operationId');

    // Only process AI SDK spans (those with ai.operationId)
    if (!operationId) {
      return;
    }

    const context = this.getContextForSpan(span);
    const baseProps = this.getBaseProperties(span, context, parentOverrides);
    // Use span start time as event timestamp so PostHog orders events chronologically
    const timestamp = new Date(hrTimeToMilliseconds(span.startTime));

    if (TRACE_OPERATIONS.has(operationId)) {
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
    } else if (GENERATION_OPERATIONS.has(operationId)) {
      this.reportGeneration(span, baseProps, context, timestamp);
    } else if (operationId === TOOL_OPERATION) {
      this.reportTool(span, baseProps, context, timestamp);
    } else if (getAttr(span.attributes, EXECUTION_SPAN_ATTR) === 'true') {
      this.reportExecutionTrace(span, baseProps, context, timestamp);
    } else {
      // Generic AI span (embed, etc.)
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
      $ai_span_name: span.name,
      $ai_latency: durationMs / 1000, // seconds
      $ai_is_error: span.status.code === SpanStatusCode.ERROR,
      ...(span.status.message && { $ai_error: span.status.message }),
      ...(context?.sessionId && { $ai_session_id: context.sessionId }),
      $ai_framework: 'aisdk',
      // Model info (available on most AI SDK spans)
      ...(getAttr(attrs, 'ai.model.id') && {
        $ai_model: getAttr(attrs, 'ai.model.id'),
      }),
      ...(getAttr(attrs, 'ai.model.provider') && {
        $ai_provider: getAttr(attrs, 'ai.model.provider'),
      }),
    };
  }

  // -----------------------------------------------------------------------
  // $ai_trace event (outer generateText/streamText spans)
  // -----------------------------------------------------------------------

  private reportTrace(
    span: ReadableSpan,
    baseProps: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    const attrs = span.attributes;
    const privacy = this.options.privacyMode;

    const inputTokens =
      getNumAttr(attrs, 'ai.usage.promptTokens') ??
      getNumAttr(attrs, 'ai.usage.inputTokens');
    const outputTokens =
      getNumAttr(attrs, 'ai.usage.completionTokens') ??
      getNumAttr(attrs, 'ai.usage.outputTokens');
    const reasoningTokens = getNumAttr(attrs, 'ai.usage.reasoningTokens');
    const cachedInputTokens = getNumAttr(attrs, 'ai.usage.cachedInputTokens');
    const totalTokens = getNumAttr(attrs, 'ai.usage.totalTokens');

    const properties: Record<string, unknown> = {
      ...baseProps,
      ...(inputTokens !== undefined && { $ai_input_tokens: inputTokens }),
      ...(outputTokens !== undefined && { $ai_output_tokens: outputTokens }),
      ...(totalTokens !== undefined && { $ai_total_tokens: totalTokens }),
      ...(reasoningTokens !== undefined && {
        $ai_reasoning_tokens: reasoningTokens,
      }),
      ...(cachedInputTokens !== undefined && {
        $ai_cache_read_input_tokens: cachedInputTokens,
      }),
      ...(getAttr(attrs, 'ai.response.finishReason') && {
        $ai_output_finish_reason: getAttr(attrs, 'ai.response.finishReason'),
      }),
    };

    // Input/output for traces
    if (!privacy) {
      const prompt = getAttr(attrs, 'ai.prompt');
      if (prompt) {
        const parsed = safeParse(prompt);
        if (Array.isArray(parsed)) {
          properties.$ai_input = parsed;
        } else {
          properties.$ai_input = truncate(prompt);
        }
      }
      const responseText = getAttr(attrs, 'ai.response.text');
      if (responseText) {
        properties.$ai_output_choices = [
          { role: 'assistant', content: responseText },
        ];
      }
    } else {
      properties.$ai_input = REDACTED;
      properties.$ai_output_choices = REDACTED;
    }

    this.capture('$ai_trace', properties, context, timestamp);
  }

  // -----------------------------------------------------------------------
  // $ai_generation event (inner doGenerate/doStream spans)
  // -----------------------------------------------------------------------

  private reportGeneration(
    span: ReadableSpan,
    baseProps: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    const attrs = span.attributes;
    const privacy = this.options.privacyMode;

    // Token usage (prefer gen_ai.* semconv, fall back to ai.*)
    const inputTokens =
      getNumAttr(attrs, 'gen_ai.usage.input_tokens') ??
      getNumAttr(attrs, 'ai.usage.promptTokens') ??
      getNumAttr(attrs, 'ai.usage.inputTokens');
    const outputTokens =
      getNumAttr(attrs, 'gen_ai.usage.output_tokens') ??
      getNumAttr(attrs, 'ai.usage.completionTokens') ??
      getNumAttr(attrs, 'ai.usage.outputTokens');
    const reasoningTokens = getNumAttr(attrs, 'ai.usage.reasoningTokens');
    const cachedInputTokens = getNumAttr(attrs, 'ai.usage.cachedInputTokens');
    const totalTokens = getNumAttr(attrs, 'ai.usage.totalTokens');

    // Model parameters
    const temperature =
      getNumAttr(attrs, 'gen_ai.request.temperature') ??
      getNumAttr(attrs, 'ai.settings.temperature');
    const maxTokens =
      getNumAttr(attrs, 'gen_ai.request.max_tokens') ??
      getNumAttr(attrs, 'ai.settings.maxOutputTokens');

    // Streaming detection
    const operationId = getAttr(attrs, 'ai.operationId') || '';
    const isStream =
      operationId.includes('stream') || operationId.includes('Stream');

    // Model ID for cost calculation
    const modelId =
      getAttr(attrs, 'ai.response.model') ??
      getAttr(attrs, 'gen_ai.response.model') ??
      getAttr(attrs, 'ai.model.id');

    // Cost calculation. In `'server'` mode (default) we omit the cost fields
    // and let PostHog enrich server-side from `$ai_model` + token counts.
    // Per-event overrides are still possible via `context.properties` because
    // `capture()` merges them in last and so wins over what we set here.
    const cost =
      this.options.costCalculation === 'client'
        ? getModelCostBreakdown(modelId, inputTokens, outputTokens)
        : {};

    // Streaming metrics
    const msToFirstChunk = getNumAttr(attrs, 'ai.response.msToFirstChunk');

    const properties: Record<string, unknown> = {
      ...baseProps,
      ...(inputTokens !== undefined && { $ai_input_tokens: inputTokens }),
      ...(outputTokens !== undefined && { $ai_output_tokens: outputTokens }),
      ...(totalTokens !== undefined && { $ai_total_tokens: totalTokens }),
      ...(reasoningTokens !== undefined && {
        $ai_reasoning_tokens: reasoningTokens,
      }),
      ...(cachedInputTokens !== undefined && {
        $ai_cache_read_input_tokens: cachedInputTokens,
      }),
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
      ...(msToFirstChunk !== undefined && {
        $ai_time_to_first_token: msToFirstChunk / 1000,
      }),
      ...(getAttr(attrs, 'ai.response.finishReason') && {
        $ai_output_finish_reason: getAttr(attrs, 'ai.response.finishReason'),
      }),
      ...(getAttr(attrs, 'ai.response.id') && {
        $ai_response_id: getAttr(attrs, 'ai.response.id'),
      }),
    };

    // Input: messages and tools
    if (!privacy) {
      const messages = getAttr(attrs, 'ai.prompt.messages');
      if (messages) {
        const parsed = safeParse(messages);
        if (Array.isArray(parsed)) {
          // Strip providerOptions/providerMetadata from each message — large and not useful
          for (const msg of parsed) {
            if (msg && typeof msg === 'object') {
              delete (msg as Record<string, unknown>).providerOptions;
              delete (msg as Record<string, unknown>).providerMetadata;
            }
          }
          properties.$ai_input = parsed;
        } else {
          properties.$ai_input = truncate(messages);
        }
      }
      // ai.prompt.tools is a string[] (each element is a JSON-stringified tool)
      const rawTools = attrs['ai.prompt.tools'];
      if (Array.isArray(rawTools)) {
        const parsed = rawTools
          .map((t) => safeParse(String(t)))
          .filter(Boolean) as { name?: string; description?: string }[];
        if (parsed.length > 0) {
          properties.$ai_tools = parsed.map((t) => ({
            name: t.name,
            description: t.description,
          }));
        }
      }
    } else {
      properties.$ai_input = REDACTED;
    }

    // Output: response text, object, or tool calls
    if (!privacy) {
      const responseText = getAttr(attrs, 'ai.response.text');
      const responseObject = getAttr(attrs, 'ai.response.object');
      const toolCallsRaw = getAttr(attrs, 'ai.response.toolCalls');

      if (responseText) {
        properties.$ai_output_choices = [
          { role: 'assistant', content: truncate(responseText) },
        ];
      } else if (responseObject) {
        properties.$ai_output_choices = [
          { role: 'assistant', content: truncate(responseObject) },
        ];
      }

      // When the LLM responds with tool calls (no text), format them
      // as $ai_output_choices so PostHog can extract $ai_tools_called
      // and display them in the Tools tab.
      if (toolCallsRaw) {
        properties.$ai_response_tool_calls = truncate(toolCallsRaw);

        if (!properties.$ai_output_choices) {
          const parsed = safeParse(toolCallsRaw);
          if (Array.isArray(parsed)) {
            const contentBlocks = parsed.map(
              (tc: { toolName?: string; toolCallId?: string }) => ({
                type: 'tool-call',
                function: { name: tc.toolName ?? 'unknown' },
                id: tc.toolCallId ?? '',
              }),
            );
            properties.$ai_output_choices = [
              { role: 'assistant', content: contentBlocks },
            ];
          }
        }
      }
    } else {
      properties.$ai_output_choices = REDACTED;
    }

    // Model parameters object
    const modelParams: Record<string, unknown> = {};
    const topP =
      getNumAttr(attrs, 'gen_ai.request.top_p') ??
      getNumAttr(attrs, 'ai.settings.topP');
    const topK =
      getNumAttr(attrs, 'gen_ai.request.top_k') ??
      getNumAttr(attrs, 'ai.settings.topK');
    const frequencyPenalty =
      getNumAttr(attrs, 'gen_ai.request.frequency_penalty') ??
      getNumAttr(attrs, 'ai.settings.frequencyPenalty');
    const presencePenalty =
      getNumAttr(attrs, 'gen_ai.request.presence_penalty') ??
      getNumAttr(attrs, 'ai.settings.presencePenalty');

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
  // $ai_span event (tool calls)
  // -----------------------------------------------------------------------

  private reportTool(
    span: ReadableSpan,
    baseProps: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    const attrs = span.attributes;
    const privacy = this.options.privacyMode;
    const toolName = getAttr(attrs, 'ai.toolCall.name');

    const properties: Record<string, unknown> = {
      ...baseProps,
      $ai_span_name: toolName ? `tool: ${toolName}` : span.name,
    };

    if (!privacy) {
      const args = getAttr(attrs, 'ai.toolCall.args');
      if (args) {
        properties.$ai_input_state = safeParse(args) ?? args;
      }
      const result = getAttr(attrs, 'ai.toolCall.result');
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
    _span: ReadableSpan,
    baseProps: Record<string, unknown>,
    context: ContextInfo | undefined,
    timestamp?: Date,
  ): void {
    this.capture('$ai_span', baseProps, context, timestamp);
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
