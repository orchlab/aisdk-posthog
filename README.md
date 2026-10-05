<h1 align="center">aisdk-posthog</h1>

<h4 align="center">PostHog LLM analytics for the Vercel AI SDK</h4>

<div align="center">
  <a href="https://www.npmjs.com/package/aisdk-posthog"><img alt="npm version" src="https://img.shields.io/npm/v/aisdk-posthog"></a>
  <a href="https://www.npmjs.com/package/aisdk-posthog"><img alt="npm downloads" src="https://img.shields.io/npm/dw/aisdk-posthog"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue.svg"></a>
  <a href="https://github.com/orchlab/aisdk-posthog/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/orchlab/aisdk-posthog/actions/workflows/ci.yml/badge.svg"></a>
</div>

<div align="center">
  <img alt="GitHub Issues" src="https://img.shields.io/github/issues/orchlab/aisdk-posthog">
  <img alt="GitHub Pull Requests" src="https://img.shields.io/github/issues-pr/orchlab/aisdk-posthog">
  <img alt="GitHub Stars" src="https://img.shields.io/github/stars/orchlab/aisdk-posthog">
</div>

`aisdk-posthog` sends [Vercel AI SDK](https://ai-sdk.dev/) telemetry to [PostHog LLM analytics](https://posthog.com/docs/llm-analytics): traces, generations, tool calls and agent steps, with token counts and cost. It is built on OpenTelemetry and was originally developed and battle-tested at [Orchestra](https://orch.so).

> **Status: community-maintained.** Not an official PostHog SDK.

## Installation

```bash
npm install aisdk-posthog ai @ai-sdk/otel
```

```bash
pnpm add aisdk-posthog ai @ai-sdk/otel
```

```bash
yarn add aisdk-posthog ai @ai-sdk/otel
```

`ai` (>=7) and `@ai-sdk/otel` are required peer dependencies. Node 22.12+.

## Version Compatibility

| `aisdk-posthog` | `ai` (Vercel AI SDK) |
| --------------- | -------------------- |
| >= 0.3.0        | ^7                   |
| 0.2.x           | ^6                   |

## Quick start

```ts
import { generateText } from 'ai';
import { createAISDKTelemetry } from 'aisdk-posthog';

const telemetry = createAISDKTelemetry({
  apiKey: process.env.POSTHOG_API_KEY!,
  host: 'https://us.i.posthog.com', // or 'https://eu.i.posthog.com'
});

await generateText({
  model,
  prompt: 'Tell me a joke',
  telemetry: telemetry.getTelemetry('joke', { userId: 'user_42' }),
});

await telemetry.flush(); // important in serverless, see below
```

Open **LLM analytics** in PostHog and the call shows up as a trace with a generation. To avoid repeating `telemetry:` on every call, see [Mode A](#mode-a--drop-in-subpath-zero-per-call-boilerplate).

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

Hold the instance and pass `telemetry: telemetry.getTelemetry(...)` per call. No subpath, no module-level state. Use this when you want fine-grained control over `functionId` per call site.

```ts
import { generateText } from 'ai';
import { telemetry } from './boot';

await generateText({
  model,
  prompt,
  telemetry: telemetry.getTelemetry('chat-reply', {
    executionUid,
  }),
});
```

### Mixing modes

Both modes coexist. Caller-supplied `telemetry` (or the deprecated `experimental_telemetry` alias) always wins over the auto-injected default, so you can use the subpath everywhere and override per call when you want a custom `functionId`:

```ts
import { generateText } from 'aisdk-posthog/ai';
import { telemetry } from './boot';

// Most calls auto-instrument with default config
await generateText({ model, prompt });

// One specific call wants a custom functionId
await generateText({
  model,
  prompt,
  telemetry: telemetry.getTelemetry('special-case'),
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
        telemetry: telemetry.getTelemetry(
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

## User context and groups

`getContext` runs for every emitted span and decides who the event belongs to. Return `distinctId`, plus optional `groupType` / `groupId` ([PostHog groups](https://posthog.com/docs/product-analytics/group-analytics)), `sessionId` and extra `properties`:

```ts
const telemetry = createAISDKTelemetry({
  apiKey: process.env.POSTHOG_API_KEY!,
  getContext: ({ spanAttributes, executionUidByTraceId }) => {
    const userId = spanAttributes['ai.telemetry.metadata.userId'] as
      | string
      | undefined;
    if (!userId) return undefined; // attributed to 'system'
    return {
      distinctId: userId,
      groupType: 'company',
      groupId: String(spanAttributes['ai.telemetry.metadata.orgId']),
      sessionId: executionUidByTraceId,
    };
  },
});
```

Metadata passed to `getTelemetry(functionId, metadata)` is available on `spanAttributes` as `ai.telemetry.metadata.<key>`. If `getContext` returns `undefined`, the event is still emitted, attributed to `'system'`.

## Serverless environments

In serverless runtimes (AWS Lambda, Vercel Functions, Cloud Functions) the process can freeze right after the response, so flush before returning. `flushAt` defaults to `1`, which sends events immediately, but `flush()` makes sure they have left the process:

```ts
export async function handler(event) {
  const result = await generateText({
    model,
    prompt,
    telemetry: telemetry.getTelemetry('handler'),
  });

  await telemetry.flush(); // ensure events are sent
  return Response.json(result);
}

// Long-running servers: drain on shutdown
process.on('SIGTERM', async () => {
  await telemetry.shutdown();
  process.exit(0);
});
```

## Privacy mode

Set `privacyMode: true` to keep prompts and tool data out of PostHog:

```ts
const telemetry = createAISDKTelemetry({
  apiKey: process.env.POSTHOG_API_KEY!,
  privacyMode: true,
});
```

`$ai_input`, `$ai_output_choices`, `$ai_input_state` and `$ai_output_state` are replaced with `'[REDACTED]'`. Everything else is still captured: model, provider, token counts, cost, latency and errors.

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
| `tracerVersion`                | `1.0.0`                    | Version reported by the OTel tracer. Independent of this package's version.                                                                                                                                                                                                  |
| `costCalculation`              | `'server'`                 | `'server'`: omit `$ai_*_cost_usd` fields and let PostHog enrich server-side from `$ai_model` + token counts (matches the official `@posthog/ai` wrappers). `'client'`: compute cost locally via `llm-info` and include it on the event. |

## Cost calculation

By default (`costCalculation: 'server'`), this package omits the `$ai_input_cost_usd` / `$ai_output_cost_usd` / `$ai_total_cost_usd` fields and lets PostHog fill them in server-side from `$ai_model` + token counts. This matches the behavior of the official `@posthog/ai` wrappers (OpenAI, Anthropic, Vercel middleware) and means you get cost from PostHog's authoritative pricing tables — without needing to ship `llm-info` updates to your app every time a new model is released.

Switch to `'client'` if you need the cost embedded in the event before it reaches PostHog (e.g. you have a downstream processor that reads `$ai_total_cost_usd`), or if you support models that `llm-info` knows about but PostHog's server-side tables don't.

Per-event overrides are still possible regardless of mode — return `$ai_input_cost_usd` etc. from `getContext` via the `properties` field and they win over whatever this option produces.

## What's emitted

| AI SDK operation                                                    | PostHog event                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `invoke_agent` (generateText / streamText / ToolLoopAgent root span) | `$ai_trace` (or `$ai_span` when wrapped in `withExecutionTrace`) |
| `chat` (one model call per step)                                    | `$ai_generation` (token counts, model parameters; cost is filled in by PostHog server-side or computed client-side, see [Cost calculation](#cost-calculation)) |
| `execute_tool`                                                      | `$ai_span` with `$ai_input_state` / `$ai_output_state`           |
| `withExecutionTrace(...)` root                                      | `$ai_trace`                                                      |
| `agent_step` (`step N`) and any other AI span (e.g. `embeddings`)   | `$ai_span`                                                       |

All events include `$ai_framework` (`'aisdk'`), `$ai_trace_id`, `$ai_span_id`, `$ai_latency` and `$ai_is_error`.

In `'client'` cost mode, `$ai_generation` events include `$ai_input_cost_usd`, `$ai_output_cost_usd`, `$ai_total_cost_usd` when the model is recognized by `llm-info`. Bedrock cross-region prefixes (`us.anthropic.claude-...`) and provider prefixes (`anthropic.claude-...`) are stripped before lookup. In the default `'server'` mode these fields are omitted and PostHog fills them in.

## AI SDK v7 notes

`ai` v7 removed the built-in OpenTelemetry. `getTelemetry()` therefore returns `{ isEnabled, functionId, integrations: [new OpenTelemetry({ tracer, ... })] }`: a per-call `@ai-sdk/otel` integration bound to this instance's tracer. Per-call integrations take precedence over globally registered ones, so there is no `registerTelemetry()` call and telemetry stays opt-in per call.

- v7 dropped `metadata` from the telemetry options. Metadata passed to `getTelemetry(fnId, metadata)` is re-attached to every span of the call (agent, step, generation, tool) via `enrichSpan` as `ai.telemetry.metadata.<key>`, the same attribute names as v6, so existing `getContext` resolvers keep working.
- Inside `withExecutionTrace`, spans share the execution's trace id, and the resolver also receives `executionUidByTraceId`.
- `functionId` becomes `gen_ai.agent.name` and is used as the span name of the `invoke_agent` span (`$ai_span_name`).
- There is a new `agent_step` span per step (`step 1`, `step 2`, ...), reported as `$ai_span`. Generations and tool spans are parented to their step.
- `$ai_stream` is derived from the presence of a time to first chunk; `$ai_time_to_first_token` is in seconds.
- `$ai_provider` is now the GenAI provider name (`openai`, not `openai.chat`).
- Pass `telemetry`, not `experimental_telemetry` (deprecated alias in v7; the `aisdk-posthog/ai` wrappers accept both).

## Streaming and parent-child spans

The Vercel AI SDK's streaming path uses `TransformStream`s, which break OpenTelemetry's `AsyncLocalStorage`-based context propagation. The exporter buffers child spans (`chat`, `execute_tool`) per traceId until the wrapping execution span ends, then re-parents them under the right `invoke_agent` / `step` span using **temporal containment** (start-time inside the parent's start/end window). When OTel propagation worked correctly, the original parent is preserved — temporal containment is only used as a fallback.

## Public API

```ts
// Core (always available)
createAISDKTelemetry(options): AISDKTelemetryInstance
toOtelTraceId(executionUid): string

// Convenience layer (for the drop-in subpath)
setDefaultTelemetry(instance | resolverFn | undefined): void
getDefaultTelemetry(): AISDKTelemetryInstance | undefined

// The instance also exposes `tracer` (for custom spans)

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

> `generateObject` and `streamObject` are deprecated and not re-exported by the subpath. Use `generateText({ output })` / `streamText({ output })` instead.

## Troubleshooting

### Events not appearing in PostHog

1. Check that `POSTHOG_API_KEY` is set and that `enabled` is not `false`.
2. Enable `debug: true` to see detailed logs.
3. Call `telemetry.flush()` before the process exits (see [Serverless environments](#serverless-environments)).
4. Check the host: `us.i.posthog.com` vs `eu.i.posthog.com`.
5. Make sure the call actually passes `telemetry` (Mode B) or is imported from `aisdk-posthog/ai` with `setDefaultTelemetry` called (Mode A).
6. Confirm `ai` is v7+ and `@ai-sdk/otel` is installed. v6 needs `aisdk-posthog@0.2.x`.

### Missing user attribution

1. Implement `getContext` and return a `distinctId`. Returning `undefined` attributes events to `'system'`.
2. Pass the identifying value via `getTelemetry(functionId, metadata)` or `withExecutionTrace` so it is available on `spanAttributes`.

### Broken parent-child spans or missing traces

1. If your app already registers an OTel context manager, set `registerGlobalContextManager: false`.
2. Wrap the request in `withExecutionTrace` so all calls share one trace.

## Built & maintained by

This package was built for internal use at [Orchestra](https://orch.so), the AI-native productivity platform. We open-sourced it to help the AI SDK community get better visibility into their LLM apps.

Maintained by [Miro K](https://github.com/miro-ku) and the Orchestra team.

Using Genkit instead? See [`genkitx-posthog`](https://github.com/orchlab/genkitx-posthog), the same idea for Firebase Genkit.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). Runnable examples live in [`examples/`](./examples). Security issues: [SECURITY.md](./SECURITY.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
