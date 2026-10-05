# Examples

Runnable examples for `aisdk-posthog`. They import from the package name, which resolves to the
local `src/` through `tsconfig.json` paths, so no build is needed.

```bash
pnpm install
export POSTHOG_API_KEY=phc_...          # your PostHog project API key
export AI_GATEWAY_API_KEY=...           # or configure any provider and set MODEL accordingly
# optional: POSTHOG_HOST, MODEL (default openai/gpt-4o-mini)

pnpm example:generate   # generateText
pnpm example:stream     # streamText
pnpm example:agent      # ToolLoopAgent + subAgent
```
