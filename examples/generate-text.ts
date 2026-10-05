import { generateText } from 'aisdk-posthog/ai';

import { MODEL, shutdown } from './telemetry';

const { text } = await generateText({
  model: MODEL,
  prompt: 'Give me a one-sentence summary of what PostHog does.',
});

console.log(text);
await shutdown();
