# aisdk-posthog

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
