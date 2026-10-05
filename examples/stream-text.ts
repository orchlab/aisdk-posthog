import { streamText } from 'aisdk-posthog/ai';

import { MODEL, shutdown } from './telemetry';

const result = streamText({
  model: MODEL,
  prompt: 'Write a haiku about observability.',
});

for await (const chunk of result.textStream) process.stdout.write(chunk);
process.stdout.write('\n');
await shutdown();
