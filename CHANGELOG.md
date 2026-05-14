# aisdk-posthog

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
