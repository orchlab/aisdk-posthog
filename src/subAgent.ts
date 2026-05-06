/**
 * `subAgent(name, tool)` wraps an AI SDK tool definition so the wrapped
 * tool's `execute` runs inside an AsyncLocalStorage frame holding the
 * sub-agent's name. The `'aisdk-posthog/ai'` subpath wrappers and the
 * `currentSubAgentName()` helper read from this frame, which lets nested
 * LLM calls inside the tool report under the sub-agent's name in PostHog
 * (`functionId: '<name>'`) without per-call telemetry threading.
 *
 * Mixing modes:
 *   - Drop-in mode: import `generateText` from `'aisdk-posthog/ai'` inside
 *     the wrapped execute — telemetry + functionId auto-applied.
 *   - Per-call mode: import `generateText` from `'ai'` and read
 *     `currentSubAgentName()` to populate `functionId` yourself.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Tool } from 'ai';

const subAgentNameALS = new AsyncLocalStorage<string>();

/**
 * Returns the name registered by the innermost surrounding `subAgent()`
 * frame, or `undefined` if not inside one. Useful in per-call mode for
 * computing a functionId without hardcoding it inside each tool.
 */
export function currentSubAgentName(): string | undefined {
  return subAgentNameALS.getStore();
}

/**
 * Loose structural fallback used by the implementation signature. AI SDK's
 * `Tool` (v6) requires `inputSchema`; the structural shape here lets unit
 * tests pass minimal `{ execute }` mocks. Production callers hit the
 * `Tool`-typed overload and get full INPUT/OUTPUT generic preservation.
 */
interface ToolLike {
  execute?: (input: never, options: never) => unknown;
}

/**
 * Wraps a tool definition so its `execute` runs with the sub-agent name
 * set in AsyncLocalStorage. Returns a new tool with the same shape as the
 * input — pass it to `tools: { … }` exactly like the unwrapped tool.
 *
 * If the tool has no `execute` (an LLM-side tool with no local handler),
 * the wrapper returns the tool unchanged.
 *
 * Nested usage: `subAgent('outer', subAgent('inner', tool))` — the
 * innermost name wins for nested LLM calls, matching standard ALS scoping.
 *
 * Typing: `import type` from `'ai'` keeps the runtime peer-optional while
 * preserving the wrapped tool's INPUT/OUTPUT generics — call sites see
 * `Tool<typeof mySchema, MyOutput>` instead of structural `(unknown,
 * unknown) => unknown`.
 */
export function subAgent<T extends Tool>(name: string, tool: T): T;
export function subAgent<T extends ToolLike>(name: string, tool: T): T;
export function subAgent<T extends ToolLike>(name: string, tool: T): T {
  if (typeof tool.execute !== 'function') {
    return tool;
  }
  const innerExecute = tool.execute;
  // Cast scoped to the property: TS can't narrow a function-property type
  // from a generic `T`. Runtime contract is preserved — same args, same
  // return — only the ALS frame is added.
  const wrappedExecute = ((input, options) =>
    subAgentNameALS.run(name, () =>
      innerExecute(input, options),
    )) as T['execute'];
  return { ...tool, execute: wrappedExecute };
}
