import { subAgent } from 'aisdk-posthog';
import {
  generateText,
  stepCountIs,
  tool,
  ToolLoopAgent,
} from 'aisdk-posthog/ai';
import { z } from 'zod';

import { MODEL, shutdown } from './telemetry';

const agent = new ToolLoopAgent({
  model: MODEL,
  instructions:
    'You are a helpful assistant. Delegate research to the `research` tool.',
  stopWhen: stepCountIs(5),
  tools: {
    // The LLM call inside this tool is reported under functionId "research".
    research: subAgent(
      'research',
      tool({
        description: 'Research a topic and return a short summary',
        inputSchema: z.object({ topic: z.string() }),
        execute: async ({ topic }, { abortSignal }) => {
          const { text } = await generateText({
            model: MODEL,
            prompt: `Summarize ${topic} in two sentences.`,
            abortSignal,
          });
          return text;
        },
      }),
    ),
  },
});

const result = await agent.generate({ prompt: 'What is OpenTelemetry?' });
console.log(result.text);
await shutdown();
