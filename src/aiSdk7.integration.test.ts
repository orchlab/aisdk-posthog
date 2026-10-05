/**
 * End-to-end tests against the real `ai@7` and `@ai-sdk/otel`, using mock
 * language models and a fake PostHog client. They pin down the PostHog events
 * and properties produced for generateText, streamText, tool calls and
 * ToolLoopAgent / sub-agent runs.
 */

import { generateText, simulateReadableStream, stepCountIs, streamText, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as aiSubpath from './ai';
import { setDefaultTelemetry } from './defaults';
import { createAISDKTelemetry, toOtelTraceId } from './factory';
import { subAgent } from './subAgent';

interface Captured {
  distinctId: string;
  event: string;
  properties: Record<string, any>;
  groups?: Record<string, string>;
}

const captureCalls: Captured[] = [];

vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: vi.fn((params) => {
      captureCalls.push(params);
    }),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  })),
}));

afterEach(() => {
  captureCalls.length = 0;
  setDefaultTelemetry(undefined);
});

const usage = {
  inputTokens: { total: 10, noCache: 6, cacheRead: 4, cacheWrite: 0 },
  outputTokens: { total: 5, text: 3, reasoning: 2 },
};

const toolCallResult = (toolName: string, input: object, id = 'call_1') =>
  ({
    content: [
      { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage,
    warnings: [],
  }) as any;

const textResult = (text: string) =>
  ({
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }) as any;

/** generate-model that first calls `toolName`, then answers with `answer`. */
function toolThenAnswerModel(toolName: string, input: object, answer: string) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: 'mock-gen',
    provider: 'mock-provider',
    doGenerate: async () =>
      n++ === 0 ? toolCallResult(toolName, input) : textResult(answer),
  });
}

function streamToolThenAnswerModel(toolName: string, input: object, answer: string) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: 'mock-stream',
    provider: 'mock-provider',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: (n++ === 0
          ? [
              {
                type: 'tool-call',
                toolCallId: 'call_s1',
                toolName,
                input: JSON.stringify(input),
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tc' }, usage },
            ]
          : [
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: answer },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ]) as any,
      }),
    }),
  });
}

const echo = tool({
  description: 'echo the input',
  inputSchema: z.object({ x: z.string() }),
  execute: async ({ x }) => ({ y: x }),
});

function makeInstance(overrides: Record<string, unknown> = {}) {
  const resolverCalls: Array<{
    traceId: string;
    spanAttributes: Record<string, unknown>;
    executionUidByTraceId?: string;
  }> = [];
  const inst = createAISDKTelemetry({
    apiKey: 'phc_test',
    registerGlobalContextManager: true,
    getContext: (info) => {
      resolverCalls.push(info);
      const uid =
        info.executionUidByTraceId ??
        (info.spanAttributes['ai.telemetry.metadata.executionUid'] as string | undefined);
      return uid
        ? {
            distinctId: `user_of_${uid}`,
            groupType: 'workspace',
            groupId: 'ws_1',
            sessionId: 'sess_1',
            properties: { execution_uid: uid },
          }
        : undefined;
    },
    ...overrides,
  });
  return { inst, resolverCalls };
}

const byEvent = (event: string) => captureCalls.filter((c) => c.event === event);
const byName = (name: string) =>
  captureCalls.find((c) => c.properties.$ai_span_name === name);

describe('ai@7 generateText inside withExecutionTrace', () => {
  it('emits trace / agent / step / generation / tool events with linkage', async () => {
    const { inst } = makeInstance();
    const traceId = toOtelTraceId('exec_gen');

    await inst.withExecutionTrace('exec_gen', 'chat.reply', {}, async () => {
      await generateText({
        model: toolThenAnswerModel('echo', { x: 'hi' }, 'all done'),
        system: 'be brief',
        prompt: 'say hi',
        tools: { echo },
        stopWhen: stepCountIs(3),
        temperature: 0.2,
        telemetry: inst.getTelemetry('chat', { executionUid: 'exec_gen' }),
      });
    });
    await inst.shutdown();

    // Every event shares the deterministic trace id and the resolved context.
    expect(captureCalls.length).toBeGreaterThanOrEqual(6);
    for (const c of captureCalls) {
      expect(c.properties.$ai_trace_id).toBe(traceId);
      expect(c.distinctId).toBe('user_of_exec_gen');
      expect(c.properties.execution_uid).toBe('exec_gen');
      expect(c.properties.$ai_framework).toBe('aisdk');
      expect(c.groups).toEqual({ workspace: 'ws_1' });
    }

    // Single $ai_trace: the execution root. The invoke_agent span is demoted.
    const traces = byEvent('$ai_trace');
    expect(traces).toHaveLength(1);
    expect(traces[0].properties.$ai_span_name).toBe('chat.reply');
    expect(traces[0].properties.$ai_parent_id).toBeUndefined();
    const rootId = traces[0].properties.$ai_span_id;

    const agent = byName('chat')!; // gen_ai.agent.name = functionId
    expect(agent.event).toBe('$ai_span');
    expect(agent.properties.$ai_parent_id).toBe(rootId);

    const steps = captureCalls.filter((c) =>
      /^step \d+$/.test(c.properties.$ai_span_name),
    );
    expect(steps).toHaveLength(2);
    for (const s of steps) {
      expect(s.event).toBe('$ai_span');
      expect(s.properties.$ai_parent_id).toBe(agent.properties.$ai_span_id);
    }
    const stepIds = steps.map((s) => s.properties.$ai_span_id);

    // Generations: one per step, parented to their step.
    const generations = byEvent('$ai_generation');
    expect(generations).toHaveLength(2);
    for (const g of generations) {
      expect(stepIds).toContain(g.properties.$ai_parent_id);
      expect(g.properties.$ai_model).toBe('mock-gen');
      expect(g.properties.$ai_provider).toBe('mock-provider');
      expect(g.properties.$ai_input_tokens).toBe(10);
      expect(g.properties.$ai_output_tokens).toBe(5);
      expect(g.properties.$ai_total_tokens).toBe(15);
      expect(g.properties.$ai_cache_read_input_tokens).toBe(4);
      expect(g.properties.$ai_reasoning_tokens).toBe(2);
      expect(g.properties.$ai_temperature).toBe(0.2);
      expect(g.properties.$ai_stream).toBe(false);
      expect(g.properties.$ai_tools).toEqual([
        { name: 'echo', description: 'echo the input' },
      ]);
      expect(g.properties.$ai_input[0]).toEqual({
        role: 'system',
        content: 'be brief',
      });
      expect(g.properties.$ai_input[1]).toEqual({
        role: 'user',
        content: 'say hi',
      });
      // v6 cost behaviour is unchanged: server-side by default.
      expect(g.properties.$ai_total_cost_usd).toBeUndefined();
    }
    const toolCallGen = generations.find(
      (g) => g.properties.$ai_output_finish_reason === 'tool-calls',
    )!;
    const finalGen = generations.find(
      (g) => g.properties.$ai_output_finish_reason === 'stop',
    )!;
    expect(JSON.parse(toolCallGen.properties.$ai_response_tool_calls)).toEqual([
      { toolCallId: 'call_1', toolName: 'echo', input: { x: 'hi' } },
    ]);
    expect(toolCallGen.properties.$ai_output_choices[0].content[0]).toMatchObject({
      type: 'tool-call',
      function: { name: 'echo' },
      id: 'call_1',
    });
    expect(finalGen.properties.$ai_output_choices).toEqual([
      { role: 'assistant', content: 'all done' },
    ]);
    // The second call sees the tool round-trip in its input.
    const roles = finalGen.properties.$ai_input.map((m: any) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);

    // Tool span.
    const toolSpan = byName('tool: echo')!;
    expect(toolSpan.event).toBe('$ai_span');
    expect(stepIds).toContain(toolSpan.properties.$ai_parent_id);
    expect(toolSpan.properties.$ai_input_state).toEqual({ x: 'hi' });
    expect(toolSpan.properties.$ai_output_state).toEqual({ y: 'hi' });
  });

  it('reaches the resolver with metadata attributes on every span kind', async () => {
    const { inst, resolverCalls } = makeInstance();
    // Standalone call (no withExecutionTrace): attribution can only come from
    // the metadata stamped on the spans via getTelemetry().
    await generateText({
      model: toolThenAnswerModel('echo', { x: 'a' }, 'ok'),
      prompt: 'p',
      tools: { echo },
      stopWhen: stepCountIs(3),
      telemetry: inst.getTelemetry('fn', { executionUid: 'exec_meta', team: 'blue' }),
    });
    await inst.shutdown();

    expect(captureCalls.length).toBeGreaterThan(0);
    for (const c of captureCalls) {
      expect(c.distinctId).toBe('user_of_exec_meta');
    }
    // Metadata is present on generation, tool, step and agent spans alike.
    expect(
      resolverCalls.every(
        (r) => r.spanAttributes['ai.telemetry.metadata.team'] === 'blue',
      ),
    ).toBe(true);

    // No execution wrapper -> the invoke_agent span is the $ai_trace.
    const traces = byEvent('$ai_trace');
    expect(traces).toHaveLength(1);
    expect(traces[0].properties.$ai_span_name).toBe('fn');
    expect(traces[0].properties.$ai_input_tokens).toBe(20);
    expect(traces[0].properties.$ai_output_tokens).toBe(10);
    expect(traces[0].properties.$ai_output_choices).toEqual([
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('redacts inputs and outputs in privacy mode', async () => {
    const { inst } = makeInstance({ privacyMode: true });
    await generateText({
      model: toolThenAnswerModel('echo', { x: 'secret' }, 'secret answer'),
      prompt: 'secret prompt',
      tools: { echo },
      stopWhen: stepCountIs(3),
      telemetry: inst.getTelemetry('fn', { executionUid: 'exec_priv' }),
    });
    await inst.shutdown();

    const dump = JSON.stringify(captureCalls);
    expect(dump).not.toContain('secret');
    expect(byEvent('$ai_generation')[0].properties.$ai_input).toBe('[REDACTED]');
    expect(byName('tool: echo')!.properties.$ai_input_state).toBe('[REDACTED]');
  });

  it('does not emit anything when telemetry is disabled per call', async () => {
    const { inst } = makeInstance();
    await generateText({
      model: toolThenAnswerModel('echo', { x: 'a' }, 'ok'),
      prompt: 'p',
      tools: { echo },
      stopWhen: stepCountIs(3),
      telemetry: { ...inst.getTelemetry('fn')!, isEnabled: false },
    });
    await inst.shutdown();
    expect(captureCalls).toHaveLength(0);
  });
});

describe('ai@7 streamText', () => {
  it('emits streaming generations with first-token latency and tool spans', async () => {
    const { inst } = makeInstance();

    await inst.withExecutionTrace('exec_stream', 'chat.reply', {}, async () => {
      const result = streamText({
        model: streamToolThenAnswerModel('echo', { x: 'yo' }, 'streamed'),
        prompt: 'go',
        tools: { echo },
        stopWhen: stepCountIs(3),
        telemetry: inst.getTelemetry('sfn', { executionUid: 'exec_stream' }),
      });
      await result.consumeStream();
    });
    await inst.shutdown();

    const traceId = toOtelTraceId('exec_stream');
    for (const c of captureCalls) {
      expect(c.properties.$ai_trace_id).toBe(traceId);
      expect(c.distinctId).toBe('user_of_exec_stream');
    }
    const generations = byEvent('$ai_generation');
    expect(generations).toHaveLength(2);
    for (const g of generations) {
      expect(g.properties.$ai_stream).toBe(true);
      expect(typeof g.properties.$ai_time_to_first_token).toBe('number');
      expect(g.properties.$ai_model).toBe('mock-stream');
    }
    const finalGen = generations.find(
      (g) => g.properties.$ai_output_finish_reason === 'stop',
    )!;
    expect(finalGen.properties.$ai_output_choices).toEqual([
      { role: 'assistant', content: 'streamed' },
    ]);
    const toolSpan = byName('tool: echo')!;
    expect(toolSpan.properties.$ai_input_state).toEqual({ x: 'yo' });
    expect(toolSpan.properties.$ai_output_state).toEqual({ y: 'yo' });
    // Hierarchy: tool and generations hang under a step span.
    const stepIds = captureCalls
      .filter((c) => /^step \d+$/.test(c.properties.$ai_span_name))
      .map((c) => c.properties.$ai_span_id);
    expect(stepIds).toHaveLength(2);
    expect(stepIds).toContain(toolSpan.properties.$ai_parent_id);
    for (const g of generations) {
      expect(stepIds).toContain(g.properties.$ai_parent_id);
    }
  });
});

describe("'aisdk-posthog/ai' drop-in wrappers with ai@7", () => {
  it('auto-injects telemetry into generateText', async () => {
    const { inst } = makeInstance();
    setDefaultTelemetry(inst);

    await inst.withExecutionTrace('exec_wrap', 'chat.reply', {}, async () => {
      await aiSubpath.generateText({
        model: new MockLanguageModelV4({ doGenerate: async () => textResult('hi') }),
        prompt: 'p',
      });
    });
    await inst.shutdown();

    expect(byEvent('$ai_generation')).toHaveLength(1);
    // functionId defaults to the wrapped function's name.
    expect(byName('generateText')).toBeDefined();
  });

  it('lets an explicit telemetry (or experimental_telemetry) win', async () => {
    const { inst } = makeInstance();
    setDefaultTelemetry(inst);

    await aiSubpath.generateText({
      model: new MockLanguageModelV4({ doGenerate: async () => textResult('hi') }),
      prompt: 'p',
      telemetry: { isEnabled: false },
    });
    await aiSubpath.generateText({
      model: new MockLanguageModelV4({ doGenerate: async () => textResult('hi') }),
      prompt: 'p',
      experimental_telemetry: { isEnabled: false },
    });
    await inst.shutdown();
    expect(captureCalls).toHaveLength(0);
  });

  it('traces a ToolLoopAgent whose tool runs a sub-agent', async () => {
    const { inst } = makeInstance();
    setDefaultTelemetry(inst);

    const research = subAgent(
      'researcher',
      tool({
        description: 'delegate research',
        inputSchema: z.object({ q: z.string() }),
        execute: async ({ q }) => {
          const r = await aiSubpath.generateText({
            model: new MockLanguageModelV4({
              modelId: 'mock-sub',
              doGenerate: async () => textResult(`found ${q}`),
            }),
            prompt: q,
          });
          return r.text;
        },
      }),
    );

    const agent = new aiSubpath.ToolLoopAgent({
      model: toolThenAnswerModel('research', { q: 'cats' }, 'summary'),
      tools: { research },
      stopWhen: stepCountIs(3),
    });

    await inst.withExecutionTrace('exec_agent', 'chat.reply', {}, async () => {
      await agent.generate({ prompt: 'investigate' });
    });
    await inst.shutdown();

    const traceId = toOtelTraceId('exec_agent');
    for (const c of captureCalls) {
      expect(c.properties.$ai_trace_id).toBe(traceId);
    }
    expect(byEvent('$ai_trace')).toHaveLength(1);

    const outerAgent = byName('tool-loop-agent')!;
    const innerAgent = byName('researcher')!;
    const toolSpan = byName('tool: research')!;
    expect(outerAgent).toBeDefined();
    expect(innerAgent).toBeDefined();
    expect(toolSpan).toBeDefined();

    // Sub-agent's root hangs off the outer agent's tool execution span.
    expect(innerAgent.properties.$ai_parent_id).toBe(toolSpan.properties.$ai_span_id);
    expect(toolSpan.properties.$ai_output_state).toBe('found cats');

    const subGeneration = byEvent('$ai_generation').find(
      (g) => g.properties.$ai_model === 'mock-sub',
    )!;
    expect(subGeneration).toBeDefined();
    const subStep = captureCalls.find(
      (c) => c.properties.$ai_span_id === subGeneration.properties.$ai_parent_id,
    )!;
    expect(subStep.properties.$ai_parent_id).toBe(innerAgent.properties.$ai_span_id);
  });
});

describe('review fixes', () => {
  it('stamps ai.telemetry.functionId on every span for resolvers', async () => {
    const { inst, resolverCalls } = makeInstance();
    await generateText({
      model: toolThenAnswerModel('echo', { x: 'a' }, 'ok'),
      prompt: 'p',
      tools: { echo },
      stopWhen: stepCountIs(3),
      telemetry: inst.getTelemetry('my-fn', { executionUid: 'exec_fid' }),
    });
    await inst.shutdown();
    expect(resolverCalls.length).toBeGreaterThan(0);
    expect(
      resolverCalls.every(
        (r) => r.spanAttributes['ai.telemetry.functionId'] === 'my-fn',
      ),
    ).toBe(true);
  });

  it('logs failing tool spans through the error logger', async () => {
    const errors: string[] = [];
    const { inst } = makeInstance({
      logger: {
        debug() {},
        info() {},
        warn() {},
        error: (m: string) => errors.push(m),
      },
    });
    const boom = tool({
      description: 'fails',
      inputSchema: z.object({ x: z.string() }),
      execute: async () => {
        throw new Error('kaput');
      },
    });
    await generateText({
      model: toolThenAnswerModel('boom', { x: 'a' }, 'ok'),
      prompt: 'p',
      tools: { boom },
      stopWhen: stepCountIs(3),
      telemetry: inst.getTelemetry('fn', { executionUid: 'exec_err' }),
    }).catch(() => {});
    await inst.shutdown();
    expect(errors.some((m) => m.includes('Tool "boom" failed'))).toBe(true);
  });

  it('forwards only `telemetry` (not the deprecated alias) to ai', async () => {
    const { inst } = makeInstance();
    setDefaultTelemetry(inst);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await aiSubpath.generateText({
      model: new MockLanguageModelV4({ doGenerate: async () => textResult('hi') }),
      prompt: 'p',
      experimental_telemetry: { isEnabled: false },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports the final assistant text as the trace output', async () => {
    const { inst } = makeInstance();
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        n++ === 0
          ? ({
              content: [
                { type: 'text', text: 'Let me check.' },
                { type: 'tool-call', toolCallId: 'c', toolName: 'echo', input: '{"x":"a"}' },
              ],
              finishReason: { unified: 'tool-calls', raw: 'tc' },
              usage,
              warnings: [],
            } as any)
          : textResult('The answer is 42.'),
    });
    await generateText({
      model,
      prompt: 'p',
      tools: { echo },
      stopWhen: stepCountIs(3),
      telemetry: inst.getTelemetry('fn', { executionUid: 'exec_out' }),
    });
    await inst.shutdown();
    expect(byEvent('$ai_trace')[0].properties.$ai_output_choices).toEqual([
      { role: 'assistant', content: 'The answer is 42.' },
    ]);
  });
});
