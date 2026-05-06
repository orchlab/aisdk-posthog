# aisdk-posthog

PostHog LLM analytics integration for the [Vercel AI SDK](https://sdk.vercel.ai/), built on OpenTelemetry.

Maps the AI SDK's `experimental_telemetry` spans (`ai.generateText`, `ai.streamText`, `ai.toolCall`, `ai.embed`, ...) to PostHog LLM observability events: `$ai_trace`, `$ai_generation`, `$ai_span`. Includes split input/output/total cost in USD via [`llm-info`](https://www.npmjs.com/package/llm-info), a deterministic execution-trace ID derived from your own ID, and a streaming-aware buffer that fixes parent-child span relationships when the AI SDK's `TransformStream` boundaries break OTel context propagation.

> **Status: community-maintained.** Not an official PostHog SDK.

## Install

```bash
npm install aisdk-posthog
# or
pnpm add aisdk-posthog
```

`ai` is an optional peer dependency. You only need it installed if you use the drop-in `'aisdk-posthog/ai'` subpath.

## Two ways to use it

The package supports two modes that compose freely. Mix and match per file.

### Mode A — drop-in subpath (zero per-call boilerplate)

Register a default telemetry instance once at app boot, then change one import line per file. Every LLM call inside is auto-instrumented; tool calls trace automatically; sub-agents pick up the right `functionId` via `subAgent()`.

```ts
// app/boot.ts — register once
import { createAISDKTelemetry, setDefaultTelemetry } from 'aisdk-posthog';

const telemetry = createAISDKTelemetry({
  apiKey: process.env.POSTHOG_API_KEY!,
  enabled: process.env.NODE_ENV === 'production',
  getContext: ({ spanAttributes, executionUidByTraceId }) => {
    const executionUid =
      (spanAttributes['ai.telemetry.metadata.executionUid'] as
        | string
        | undefined) ?? executionUidByTraceId;
    if (!executionUid) return undefined;
    // …look up your user/workspace/chat from `executionUid`…
    return {
      distinctId: 'user_42',
      groupId: 'workspace_99',
      groupType: 'workspace_id',
    };
  },
});
setDefaultTelemetry(telemetry);
```

```ts
// anywhere else — only the import line changes
- import { generateText, streamText, ToolLoopAgent, tool } from 'ai';
+ import { generateText, streamText, ToolLoopAgent, tool } from 'aisdk-posthog/ai';

// call sites stay literally identical
await generateText({ model, prompt });   // auto-instrumented
await streamText({ model, messages });   // auto-instrumented

const agent = new ToolLoopAgent({ model, instructions, tools }); // auto-instrumented
```

If `setDefaultTelemetry` is never called or telemetry is disabled, the wrappers forward untouched — calls behave exactly like importing from `'ai'` directly.

### Mode B — per-call embedding (explicit, no globals)

Hold the instance and pass `experimental_telemetry: telemetry.getTelemetry(...)` per call. No subpath, no module-level state. Use this when you want fine-grained control over `functionId` per call site.

```ts
import { generateText } from 'ai';
import { telemetry } from './boot';

await generateText({
  model,
  prompt,
  experimental_telemetry: telemetry.getTelemetry('chat-reply', {
    executionUid,
  }),
});
```

### Mixing modes

Both modes coexist. Caller-supplied `experimental_telemetry` always wins over the auto-injected default, so you can use the subpath everywhere and override per call when you want a custom `functionId`:

```ts
import { generateText } from 'aisdk-posthog/ai';
import { telemetry } from './boot';

// Most calls auto-instrument with default config
await generateText({ model, prompt });

// One specific call wants a custom functionId
await generateText({
  model,
  prompt,
  experimental_telemetry: telemetry.getTelemetry('special-case'),
});
```

## Sub-agents (tools that call LLMs internally)

Wrap the tool with `subAgent('name', tool({...}))`. Inside the wrapped tool, the AI SDK functions imported from the subpath automatically use `'name'` as their `functionId` so the sub-agent shows up by name in PostHog. This works for both `generateText` patterns and `ToolLoopAgent` patterns.

```ts
import { subAgent } from 'aisdk-posthog';
import { generateText, ToolLoopAgent, tool, stepCountIs } from 'aisdk-posthog/ai';
import { z } from 'zod';

tools: {
  research: subAgent('research', tool({
    description: 'Research a topic',
    inputSchema: z.object({ topic: z.string() }),
    execute: async ({ topic }, { abortSignal }) => {
      // Functions imported from 'aisdk-posthog/ai' read the current
      // sub-agent name from AsyncLocalStorage and tag the span as
      // `functionId: 'research'`. No telemetry threading.
      const agent = new ToolLoopAgent({
        model, instructions, tools: innerTools, stopWhen: stepCountIs(12),
      });
      return (await agent.generate({ prompt: topic, abortSignal })).text;
    },
  })),
}
```

For per-call mode, read the current sub-agent name yourself:

```ts
import { tool } from 'ai';
import { subAgent, currentSubAgentName } from 'aisdk-posthog';
import { generateText } from 'ai';

tools: {
  research: subAgent('research', tool({
    description, inputSchema,
    execute: async ({ topic }, { abortSignal }) => {
      return generateText({
        model, prompt: `Research: ${topic}`,
        experimental_telemetry: telemetry.getTelemetry(
          currentSubAgentName() ?? 'fallback',
        ),
        abortSignal,
      });
    },
  })),
}
```

## Wrapping a top-level execution

Use `withExecutionTrace` to anchor an entire request under one PostHog trace with a stable, deterministic `traceId` derived from your own execution ID:

```ts
import { randomUUID } from 'node:crypto';

const requestId = randomUUID();

await telemetry.withExecutionTrace(
  requestId,
  'chat.reply',
  { userId: req.user.id, channel: 'slack' },
  async () => {
    // every LLM call inside lands as a child of `chat.reply`
    return generateText({ model, prompt }); // subpath: auto-instrumented
  },
);

// admin link the user can paste anywhere — works without storing the trace ID:
const traceUrl = `https://us.posthog.com/llm-observability/traces/${telemetry.toOtelTraceId(requestId)}`;
```

The `operationId` (second arg) is free-form — pick whatever name makes sense for your request type (`'chat.reply'`, `'ingest.batch'`, `'cron.daily-summary'`). The `executionUid` (first arg) should come from your own domain (HTTP request ID, queue job ID, message ID) so the same trace ID is reproducible without storage. Metadata keys (third arg) are stored verbatim on the span — pick names that won't collide with OTel/AI SDK semconv attributes (`ai.*`, `gen_ai.*`).

## Options

| Option                         | Default                    | Notes                                                                                                                                                                                                                       |
| ------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                       | (required)                 | PostHog project API key.                                                                                                                                                                                                    |
| `host`                         | `https://us.i.posthog.com` | PostHog ingestion host. Use `https://eu.i.posthog.com` for the EU region.                                                                                                                                                   |
| `enabled`                      | `true`                     | Master switch. When `false`, the factory returns a no-op instance.                                                                                                                                                          |
| `debug`                        | `false`                    | Verbose internal logging.                                                                                                                                                                                                   |
| `privacyMode`                  | `false`                    | Redact prompt text and tool inputs/outputs.                                                                                                                                                                                 |
| `flushAt`                      | `1`                        | PostHog client flush threshold. `1` is suitable for serverless.                                                                                                                                                             |
| `getContext`                   | —                          | Resolves `distinctId` / `groupId` / `sessionId` / extra properties for each emitted span. Returning `undefined` causes the event to be attributed to `'system'` — events still emit, just without a real user tied to them. |
| `logger`                       | `console`                  | Structural `{ info, warn, error, debug }` interface.                                                                                                                                                                        |
| `registerGlobalContextManager` | `true`                     | Installs `AsyncLocalStorageContextManager` as the global OTel context manager. Set to `false` if your app already wires one.                                                                                                |
| `tracerName`                   | `aisdk-posthog`            | Surfaced via the OTel API.                                                                                                                                                                                                  |
| `tracerVersion`                | `1.0.0`                    | Surfaced via the OTel API.                                                                                                                                                                                                  |

## What's emitted

| AI SDK operation                                                    | PostHog event                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `ai.generateText`, `ai.streamText` (outer span)                     | `$ai_trace` (or `$ai_span` when wrapped in `withExecutionTrace`) |
| `ai.generateText.doGenerate`, `ai.streamText.doStream` (inner span) | `$ai_generation` (with token counts, cost USD, model parameters) |
| `ai.toolCall`                                                       | `$ai_span` with `$ai_input_state` / `$ai_output_state`           |
| `withExecutionTrace(...)` root                                      | `$ai_trace`                                                      |
| Any other `ai.operationId` (e.g. `ai.embed`)                        | `$ai_span`                                                       |

`$ai_generation` events include `$ai_input_cost_usd`, `$ai_output_cost_usd`, `$ai_total_cost_usd` when the model is recognized by `llm-info`. Bedrock cross-region prefixes (`us.anthropic.claude-...`) and provider prefixes (`anthropic.claude-...`) are stripped before lookup.

## Streaming and parent-child spans

The Vercel AI SDK's streaming path uses `TransformStream`s, which break OpenTelemetry's `AsyncLocalStorage`-based context propagation. The exporter buffers child spans (`doStream`, `toolCall`) per traceId until the wrapping execution span ends, then re-parents them under the right `ai.streamText` span using **temporal containment** (start-time inside the parent's start/end window). When OTel propagation worked correctly, the original parent is preserved — temporal containment is only used as a fallback.

## Public API

```ts
// Core (always available)
createAISDKTelemetry(options): AISDKTelemetryInstance
toOtelTraceId(executionUid): string

// Convenience layer (for the drop-in subpath)
setDefaultTelemetry(instance | resolverFn | undefined): void
getDefaultTelemetry(): AISDKTelemetryInstance | undefined

// Sub-agent helper
subAgent(name, tool): tool
currentSubAgentName(): string | undefined

// Advanced (raw OTel exporter, for users wiring their own TracerProvider)
PostHogAISdkExporter
getModelCostBreakdown(modelId, inputTokens, outputTokens)
```

```ts
// Drop-in subpath (requires `ai` peer dep)
import {
  generateText,
  streamText,
  embed,
  embedMany,
  ToolLoopAgent,
  tool,
  wrapLanguageModel,
  stepCountIs,
  hasToolCall, // pass-throughs
} from 'aisdk-posthog/ai';
```

> `generateObject` and `streamObject` are deprecated in `ai` v6 and not re-exported by the subpath. Use `generateText({ output })` / `streamText({ output })` instead.

## Testing

```bash
pnpm test
```

Tests mock `posthog-node` and feed synthetic spans through the exporter to assert the emitted event shape.

## License

Apache-2.0.
