# aisdk-posthog

## 0.3.0

### Minor Changes

- **AI SDK v7 support (breaking).** `ai` v7 removed the built-in
  OpenTelemetry and ignores `metadata` / `tracer` in its telemetry options,
  which silently stopped PostHog traces. This release targets `ai` ^7 and
  `@ai-sdk/otel` and **drops `ai` v6 support** (stay on `0.2.x` for v6).

  - `getTelemetry()` now returns `{ isEnabled, functionId, integrations }`
    where `integrations` is a per-call `new OpenTelemetry({ tracer })` from
    `@ai-sdk/otel`. No global `registerTelemetry()` needed. Pass it as
    `telemetry:` (`experimental_telemetry` is a deprecated alias in v7).
    `AiSdkTelemetryConfig` changed accordingly (`metadata` / `tracer`
    removed, `integrations` added).
  - Metadata is re-attached to every span via `enrichSpan` as
    `ai.telemetry.metadata.<key>`, so `getContext` resolvers and
    `executionUid` attribution keep working unchanged.
  - The exporter maps the v7 GenAI span attributes: `invoke_agent` ->
    `$ai_trace`, `chat` -> `$ai_generation`, `execute_tool` -> `$ai_span`,
    `agent_step` / others -> `$ai_span`. The v6 `ai.*` attribute mapping is
    gone. Input/output messages are converted from GenAI message parts to
    PostHog `{ role, content }`.
  - New: each agent step is reported as a `$ai_span` (`step N`);
    `$ai_cache_creation_input_tokens` is emitted when reported.
  - `aisdk-posthog/ai` wrappers inject `telemetry` (and honor an explicit
    `telemetry` or `experimental_telemetry`). `TelemetrySettings` type
    re-export replaced by `TelemetryOptions`.
  - The instance now exposes `tracer`.
  - Peer dependencies are now `ai >=7.0.0` and `@ai-sdk/otel >=1.0.0`, both
    required (install them alongside; their versions track each other). The
    `ai` peer is no longer optional because the factory loads
    `@ai-sdk/otel` at runtime.
  - **Breaking:** `engines.node` is now `>=22.12` (AI SDK 7 needs 22; 22.12 is the first release where the CJS entry can `require()` the ESM-only `@ai-sdk/otel`).
  - The resolver also sees `ai.telemetry.functionId` on every span.
  - Known limitation: `$ai_stream` is inferred from the presence of a time
    to first chunk, so a stream that errors before its first chunk is
    reported as non-streaming. `embeddings` spans are `$ai_span` events
    carrying token usage, not `$ai_embedding` events.

### Patch Changes

- Repository restructure for open source: tests moved to `test/`, runnable
  `examples/`, tsup build (ESM + CJS + types in a flat `dist/`, shared chunk so
  both entry points share default-telemetry state), eslint/prettier config, CI
  and release workflows, community health files. Public API and entry points
  (`aisdk-posthog`, `aisdk-posthog/ai`) are unchanged.

## 0.2.1

### Patch Changes

- **Slimmer published tarball.** Drop `composite: true` from `tsconfig.json`
  so the build no longer emits `dist/esm/tsconfig.tsbuildinfo` and
  `dist/cjs/tsconfig.tsbuildinfo` — together ~170 kB of TypeScript
  incremental build cache that was being shipped to every consumer for no
  benefit (this package has no project references and doesn't need
  composite). Removes the now-redundant `prepack` strip script.

  No source / runtime / API change. Packed tarball drops from ~88 kB →
  ~40 kB, unpacked from ~440 kB → ~250 kB.

## 0.2.0

### Minor Changes

- **Default cost calculation moved to PostHog server-side.**

  Add `costCalculation: 'server' | 'client'` option (default: `'server'`).
  In the default `'server'` mode the exporter omits `$ai_input_cost_usd`,
  `$ai_output_cost_usd`, and `$ai_total_cost_usd` from emitted
  `$ai_generation` events; PostHog fills them in from `$ai_model` +
  token counts using its own pricing tables. This matches the behavior of
  the official `@posthog/ai` wrappers (OpenAI, Anthropic, Vercel
  middleware) and means cost stays accurate as PostHog updates pricing,
  without consumers needing to ship `llm-info` updates.

  Set `costCalculation: 'client'` to keep the previous behavior of
  computing cost via `llm-info` and embedding it on the event.

  **Migration from 0.1.x:** if you rely on `$ai_*_cost_usd` being present
  on the emitted event before it reaches PostHog (e.g. a downstream
  processor that reads it), pass `costCalculation: 'client'` to
  `createAISDKTelemetry`. Otherwise no code change is needed and you'll
  start seeing PostHog's authoritative cost numbers in the LLM Analytics
  UI.

## 0.1.0

### Minor Changes

- Initial release. PostHog LLM analytics integration for the Vercel AI SDK,
  built on OpenTelemetry. Maps `ai.*` spans to `$ai_trace`, `$ai_generation`,
  and `$ai_span` events, with token-based cost calculation via `llm-info`,
  deterministic execution-trace IDs, and a streaming-aware buffer that
  reconstructs parent-child span relationships broken by AI SDK's
  `TransformStream` boundaries.

  Two usage modes:
  - **Drop-in subpath** `'aisdk-posthog/ai'` — register a default instance
    via `setDefaultTelemetry()` once at boot, then change one import line
    per file. Every LLM call (and tool call) is auto-instrumented.
  - **Per-call embedding** — pass `experimental_telemetry: telemetry.getTelemetry(...)`
    explicitly. Both modes coexist and caller-supplied values always win.

  Sub-agent ergonomics: `subAgent(name, tool)` runs the wrapped tool's
  `execute` inside an `AsyncLocalStorage` frame so nested LLM calls inside
  it report under the sub-agent's name in PostHog. Works in both modes.

  Public API:
  - `createAISDKTelemetry(options)` — core factory
  - `setDefaultTelemetry(inst | resolverFn)` / `getDefaultTelemetry()`
  - `subAgent(name, tool)` / `currentSubAgentName()`
  - `withExecutionTrace`, `captureSpanContext`, `toOtelTraceId` (on instance)
  - Subpath: `generateText`, `streamText`, `embed`, `embedMany`,
    `ToolLoopAgent` (auto-instrumented); `tool`, `wrapLanguageModel`,
    `stepCountIs`, `hasToolCall` (pass-through)
  - Advanced: `PostHogAISdkExporter`, `getModelCostBreakdown`
