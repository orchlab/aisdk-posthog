import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAISDKTelemetry } from './factory';

// Capture every PostHog `capture` call across the suite. Mocking the module
// means our factory's `new PostHog(...)` returns the stub regardless of
// where it's instantiated. `vi.mock` is hoisted by vitest above all imports
// at compile time, so the mock applies before `./factory` loads `posthog-node`.
const captureCalls: Array<{
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  groups?: Record<string, string>;
  timestamp?: Date;
}> = [];

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
});

describe('createAISDKTelemetry', () => {
  describe('disabled instance', () => {
    it('returns no-op surface when enabled=false', async () => {
      const inst = createAISDKTelemetry({
        apiKey: 'phc_anything',
        enabled: false,
        registerGlobalContextManager: false,
      });

      expect(inst.getTelemetry('test')).toBeUndefined();

      const result = await inst.withExecutionTrace(
        'exec_disabled',
        'chat.reply',
        {},
        async () => 42,
      );
      expect(result).toBe(42);
      expect(captureCalls).toHaveLength(0);
    });

    it('returns no-op when apiKey is empty even if enabled=true', async () => {
      const inst = createAISDKTelemetry({
        apiKey: '',
        enabled: true,
        registerGlobalContextManager: false,
      });
      expect(inst.getTelemetry('test')).toBeUndefined();
    });
  });

  describe('toOtelTraceId stability', () => {
    it('produces a stable 32-char hex trace ID for a given executionUid', () => {
      const inst = createAISDKTelemetry({
        apiKey: 'phc_x',
        enabled: false, // disabled so we don't allocate the tracer
        registerGlobalContextManager: false,
      });

      const a = inst.toOtelTraceId('exec_abc');
      const b = inst.toOtelTraceId('exec_abc');
      const c = inst.toOtelTraceId('exec_xyz');

      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('enabled instance', () => {
    it('emits a $ai_generation event for a synthetic doStream span', async () => {
      // Need the global context manager so child spans inherit the parent
      // execution trace's traceId. OTel only honors the first registration
      // per worker process, so subsequent tests in this file will share it.
      const inst = createAISDKTelemetry({
        apiKey: 'phc_test',
        enabled: true,
        registerGlobalContextManager: true,
        getContext: ({ traceId, executionUidByTraceId }) => ({
          distinctId: 'user_123',
          groupId: 'workspace_999',
          groupType: 'workspace_id',
          properties: {
            execution_uid: executionUidByTraceId ?? 'unknown',
            verified_trace_id: traceId,
          },
        }),
      });

      try {
        await inst.withExecutionTrace(
          'exec_smoke_1',
          'chat.reply',
          {},
          async () => {
            const cfg = inst.getTelemetry('test-fn', {
              executionUid: 'exec_smoke_1',
            });
            expect(cfg).toBeDefined();
            const tracer = cfg!.tracer;

            await tracer.startActiveSpan(
              'ai.streamText.doStream',
              {
                attributes: {
                  'ai.operationId': 'ai.streamText.doStream',
                  'ai.model.id': 'claude-sonnet-4',
                  'ai.model.provider': 'anthropic',
                  'ai.usage.inputTokens': 100,
                  'ai.usage.outputTokens': 50,
                  'ai.usage.totalTokens': 150,
                  'ai.response.text': 'hello world',
                  'ai.response.finishReason': 'stop',
                  'ai.settings.temperature': 0.7,
                },
              },
              (span) => {
                span.end();
              },
            );
          },
        );
      } finally {
        await inst.shutdown();
      }

      // Find the generation event (the execution root span also produces an event).
      const generationEvent = captureCalls.find(
        (c) => c.event === '$ai_generation',
      );
      expect(generationEvent).toBeDefined();
      expect(generationEvent!.distinctId).toBe('user_123');
      expect(generationEvent!.properties.$ai_model).toBe('claude-sonnet-4');
      expect(generationEvent!.properties.$ai_provider).toBe('anthropic');
      expect(generationEvent!.properties.$ai_input_tokens).toBe(100);
      expect(generationEvent!.properties.$ai_output_tokens).toBe(50);
      expect(generationEvent!.properties.$ai_total_tokens).toBe(150);
      expect(generationEvent!.properties.$ai_stream).toBe(true);
      expect(generationEvent!.properties.$ai_framework).toBe('aisdk');
      expect(generationEvent!.properties.$ai_trace_id).toMatch(
        /^[0-9a-f]{32}$/,
      );
      expect(generationEvent!.groups).toEqual({
        workspace_id: 'workspace_999',
      });

      // The execution-root span should produce a $ai_trace event.
      const traceEvent = captureCalls.find((c) => c.event === '$ai_trace');
      expect(traceEvent).toBeDefined();
      expect(traceEvent!.properties.$ai_trace_id).toBe(
        generationEvent!.properties.$ai_trace_id,
      );

      // Resolver received the executionUidByTraceId fallback.
      expect(generationEvent!.properties.execution_uid).toBe('exec_smoke_1');
    });

    it('uses the resolver for context attribution', async () => {
      const resolverCalls: Array<{
        traceId: string;
        executionUidByTraceId?: string;
      }> = [];

      const inst = createAISDKTelemetry({
        apiKey: 'phc_test',
        enabled: true,
        registerGlobalContextManager: true,
        getContext: ({ traceId, executionUidByTraceId }) => {
          resolverCalls.push({ traceId, executionUidByTraceId });
          return { distinctId: 'distinct_x' };
        },
      });

      try {
        await inst.withExecutionTrace(
          'exec_resolver',
          'chat.reply',
          {},
          async () => {
            const cfg = inst.getTelemetry('fn');
            await cfg!.tracer.startActiveSpan(
              'ai.toolCall',
              {
                attributes: {
                  'ai.operationId': 'ai.toolCall',
                  'ai.toolCall.name': 'searchEmails',
                  'ai.toolCall.args': '{"query":"x"}',
                  'ai.toolCall.result': '{"hits":1}',
                },
              },
              (span) => span.end(),
            );
          },
        );
      } finally {
        await inst.shutdown();
      }

      // At least one resolver call carries the precomputed executionUid lookup.
      const withExecutionUid = resolverCalls.find(
        (c) => c.executionUidByTraceId === 'exec_resolver',
      );
      expect(withExecutionUid).toBeDefined();

      const toolEvent = captureCalls.find(
        (c) =>
          c.event === '$ai_span' &&
          c.properties.$ai_span_name === 'tool: searchEmails',
      );
      expect(toolEvent).toBeDefined();
      expect(toolEvent!.distinctId).toBe('distinct_x');
      expect(toolEvent!.properties.$ai_input_state).toEqual({ query: 'x' });
      expect(toolEvent!.properties.$ai_output_state).toEqual({ hits: 1 });
    });
  });
});
