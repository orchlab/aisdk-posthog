import { SpanStatusCode } from '@opentelemetry/api';
import type {
  ReadableSpan,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import type { Logger } from './logger';

/**
 * Lightweight span processor that logs error spans to the configured logger.
 *
 * When a tool call inside a sub-agent throws, the AI SDK catches the error
 * internally and marks the OTel span as ERROR. PostHog picks this up, but
 * the error never reaches application code — this processor bridges that
 * gap by logging error spans as they complete.
 */
export class ErrorLoggingSpanProcessor implements SpanProcessor {
  constructor(private readonly logger: Logger) {}

  onStart(): void {
    // no-op
  }

  onEnd(span: ReadableSpan): void {
    if (span.status.code !== SpanStatusCode.ERROR) {
      return;
    }

    // v7 spans carry `gen_ai.operation.name`; spans from withExecutionTrace
    // carry `ai.operationId`.
    const operationId = (span.attributes['gen_ai.operation.name'] ??
      span.attributes['ai.operationId']) as string | undefined;
    if (!operationId) {
      return;
    }

    const toolName = span.attributes['gen_ai.tool.name'] as string | undefined;
    const errorMessage = span.status.message || 'Unknown error';

    if (toolName) {
      this.logger.error(`[OTel] Tool "${toolName}" failed: ${errorMessage}`, {
        operationId,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
      });
    } else {
      this.logger.error(
        `[OTel] Span "${operationId}" failed: ${errorMessage}`,
        {
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
        },
      );
    }
  }

  async shutdown(): Promise<void> {
    // no-op
  }

  async forceFlush(): Promise<void> {
    // no-op
  }
}
