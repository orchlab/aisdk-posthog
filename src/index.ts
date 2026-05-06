/**
 * aisdk-posthog
 *
 * OpenTelemetry-based PostHog LLM analytics integration for the Vercel
 * AI SDK. Maps `ai.*` spans to PostHog observability events
 * (`$ai_trace`, `$ai_generation`, `$ai_span`).
 */

export { createAISDKTelemetry, toOtelTraceId } from './factory';
export type { AISDKTelemetryInstance } from './factory';

export { PostHogAISdkExporter } from './posthogExporter';
export type {
  ContextInfo,
  ContextResolver,
  PostHogAISdkExporterOptions,
} from './posthogExporter';

export { getModelCostBreakdown } from './pricing';
export type { CostBreakdown } from './pricing';

export { consoleLogger } from './logger';
export type { Logger } from './logger';

export { SYNTHETIC_ROOT_SPAN_ID } from './constants';

export type { AISDKTelemetryOptions, AiSdkTelemetryConfig } from './types';

// Convenience layer for the drop-in subpath ('aisdk-posthog/ai')
export { setDefaultTelemetry, getDefaultTelemetry } from './defaults';
export { subAgent, currentSubAgentName } from './subAgent';
