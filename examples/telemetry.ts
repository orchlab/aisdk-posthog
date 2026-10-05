import { createAISDKTelemetry, setDefaultTelemetry } from 'aisdk-posthog';

/** Model id routed through the Vercel AI Gateway (needs AI_GATEWAY_API_KEY). */
export const MODEL = process.env.MODEL ?? 'openai/gpt-4o-mini';

export const telemetry = createAISDKTelemetry({
  apiKey: process.env.POSTHOG_API_KEY!,
  host: process.env.POSTHOG_HOST,
  getContext: () => ({ distinctId: 'example-user' }),
});

// Drop-in mode: calls imported from 'aisdk-posthog/ai' are instrumented automatically.
setDefaultTelemetry(telemetry);

export async function shutdown() {
  await telemetry.shutdown();
}
