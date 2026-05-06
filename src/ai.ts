/**
 * Drop-in `'ai'` replacement that auto-injects `experimental_telemetry`
 * from the registered default telemetry instance.
 *
 * Use:
 *   import { generateText, streamText, ToolLoopAgent, tool } from 'aisdk-posthog/ai';
 *
 * Wired wrappers cover every supported AI SDK entry point that accepts
 * `experimental_telemetry`:
 *   - functions: generateText, streamText, embed, embedMany
 *   - class: ToolLoopAgent
 *
 * `generateObject` and `streamObject` are deprecated in `ai` v6 — use
 * `generateText({ output })` / `streamText({ output })` instead. If you
 * need the deprecated names, import them from `'ai'` directly and thread
 * `experimental_telemetry` manually.
 *
 * Pass-throughs (no telemetry concern, exported for import-source parity):
 *   - tool, wrapLanguageModel, stepCountIs, hasToolCall, toolModelMessageSchema
 *
 * Behavior:
 *   - If the caller supplies `experimental_telemetry`, it wins. The wrapper
 *     never overrides an explicit value.
 *   - If absent, the wrapper looks up the default instance via
 *     `getDefaultTelemetry()` and injects its config.
 *   - The functionId defaults in priority order:
 *       1. innermost `subAgent('<name>', ...)` ALS frame
 *       2. the AI SDK function's own name (e.g. 'generateText')
 *
 * If no default telemetry is registered, the wrapper forwards untouched —
 * AI SDK calls behave exactly as if you'd imported from 'ai' directly.
 */

import {
  ToolLoopAgent as AIToolLoopAgent,
  embed as aiEmbed,
  embedMany as aiEmbedMany,
  generateText as aiGenerateText,
  streamText as aiStreamText,
} from 'ai';
import type { TelemetrySettings, ToolLoopAgentSettings, ToolSet } from 'ai';

import { getDefaultTelemetry } from './defaults';
import { currentSubAgentName } from './subAgent';

/**
 * Common shape: every AI SDK call settings object that accepts telemetry.
 * Used by the resolver below so we don't have to redeclare the field per
 * call site.
 */
interface MaybeTelemetry {
  experimental_telemetry?: TelemetrySettings;
}

/**
 * Resolves the telemetry config for an AI SDK call. If the caller already
 * supplied a value (any defined value, including an explicit
 * `{ isEnabled: false }`), we never override. The instance's
 * `getTelemetry()` returns an `AiSdkTelemetryConfig` which is structurally
 * a `TelemetrySettings` — TS widens automatically.
 */
function resolveTelemetry(
  opts: MaybeTelemetry,
  fallbackFnId: string,
): TelemetrySettings | undefined {
  if (opts.experimental_telemetry !== undefined) {
    return opts.experimental_telemetry;
  }
  const inst = getDefaultTelemetry();
  if (!inst) {
    return undefined;
  }
  const fnId = currentSubAgentName() ?? fallbackFnId;
  return inst.getTelemetry(fnId);
}

// ---------------------------------------------------------------------------
// Function wrappers
// ---------------------------------------------------------------------------

export const generateText: typeof aiGenerateText = ((opts) =>
  aiGenerateText({
    ...opts,
    experimental_telemetry: resolveTelemetry(opts, 'generateText'),
  })) as typeof aiGenerateText;

export const streamText: typeof aiStreamText = ((opts) =>
  aiStreamText({
    ...opts,
    experimental_telemetry: resolveTelemetry(opts, 'streamText'),
  })) as typeof aiStreamText;

// Note: `generateObject` and `streamObject` are deprecated in `ai` v6
// (use `generateText` / `streamText` with the `output` option). They are
// not re-exported here. If you still need them, import from `'ai'`
// directly and pass `experimental_telemetry: telemetry.getTelemetry(...)`
// manually.

export const embed: typeof aiEmbed = ((opts) =>
  aiEmbed({
    ...opts,
    experimental_telemetry: resolveTelemetry(opts, 'embed'),
  })) as typeof aiEmbed;

export const embedMany: typeof aiEmbedMany = ((opts) =>
  aiEmbedMany({
    ...opts,
    experimental_telemetry: resolveTelemetry(opts, 'embedMany'),
  })) as typeof aiEmbedMany;

// ---------------------------------------------------------------------------
// ToolLoopAgent class
// ---------------------------------------------------------------------------

/**
 * `ToolLoopAgent` — drop-in replacement for `'ai'`'s class. The runtime
 * constructor auto-injects `experimental_telemetry` from the registered
 * default; if the caller already supplied one, that value wins.
 *
 * Type preservation: the exported value is typed as `typeof AIToolLoopAgent`
 * so `new ToolLoopAgent<MyOpts, MyTools>(...)` keeps user-side generics.
 * Subclassing a generic class while preserving the generic surface
 * requires the final `as typeof AIToolLoopAgent` cast — TypeScript has no
 * way to express "subclass that preserves all generic parameters" without
 * it. The cast is safe because the runtime contract is identical (same
 * constructor signature, same instance shape) — only telemetry injection
 * is added.
 */
class WrappedToolLoopAgent extends AIToolLoopAgent {
  constructor(settings: ToolLoopAgentSettings) {
    super({
      ...settings,
      experimental_telemetry:
        settings.experimental_telemetry !== undefined
          ? settings.experimental_telemetry
          : resolveTelemetry(settings, 'tool-loop-agent'),
    });
  }
}

export const ToolLoopAgent = WrappedToolLoopAgent as typeof AIToolLoopAgent;
export type ToolLoopAgent<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
> = InstanceType<typeof AIToolLoopAgent<CALL_OPTIONS, TOOLS>>;

// ---------------------------------------------------------------------------
// Pass-throughs (re-exported so users import everything from this subpath)
// ---------------------------------------------------------------------------

export {
  hasToolCall,
  stepCountIs,
  tool,
  toolModelMessageSchema,
  wrapLanguageModel,
} from 'ai';

export type {
  EmbedManyResult,
  EmbedResult,
  GenerateTextResult,
  ModelMessage,
  StreamTextResult,
  TelemetrySettings,
  Tool,
  ToolCallPart,
  ToolResultPart,
  ToolSet,
} from 'ai';
