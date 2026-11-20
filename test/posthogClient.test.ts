/**
 * How the exporter uses the posthog-node 6 client: `$ai_*` events go through
 * `captureAi` (the dedicated AI endpoint), never `capture`, and delivery
 * failures — which posthog-node 6 reports only on its `'error'` event — reach
 * the host's logger.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAISDKTelemetry } from '../src/factory';

const client = vi.hoisted(() => ({
  capture: vi.fn(),
  captureAi: vi.fn(),
  errorListeners: [] as Array<(err: unknown) => void>,
}));

vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation(() => ({
    capture: client.capture,
    captureAi: client.captureAi,
    on: vi.fn((event: string, listener: (err: unknown) => void) => {
      if (event === 'error') {
        client.errorListeners.push(listener);
      }
      return () => {};
    }),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  })),
}));

afterEach(() => {
  client.capture.mockClear();
  client.captureAi.mockClear();
  client.errorListeners.length = 0;
});

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('posthog-node client usage', () => {
  it('sends $ai_* events with captureAi, not capture', async () => {
    const inst = createAISDKTelemetry({
      apiKey: 'phc_test',
      enabled: true,
      registerGlobalContextManager: true,
      getContext: () => ({ distinctId: 'user_ai_lane' }),
      logger: silentLogger(),
    });

    try {
      await inst.withExecutionTrace('exec_ai_lane', 'chat.reply', {}, () =>
        inst.tracer.startActiveSpan(
          'chat gpt-4o',
          {
            attributes: {
              'gen_ai.operation.name': 'chat',
              'gen_ai.request.model': 'gpt-4o',
            },
          },
          (span) => span.end(),
        ),
      );
    } finally {
      await inst.shutdown();
    }

    const events = client.captureAi.mock.calls.map(([params]) => params.event);
    expect(events).toContain('$ai_generation');
    expect(events.every((event: string) => event.startsWith('$ai_'))).toBe(
      true,
    );
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("forwards the client's delivery errors to the logger", async () => {
    const logger = silentLogger();
    const inst = createAISDKTelemetry({
      apiKey: 'phc_test',
      enabled: true,
      registerGlobalContextManager: false,
      logger,
    });

    try {
      expect(client.errorListeners).toHaveLength(1);
      client.errorListeners[0]!(new Error('3 event(s) were not delivered'));

      expect(logger.warn).toHaveBeenCalledWith(
        '[PostHogAISdk] PostHog did not deliver some events:',
        '3 event(s) were not delivered',
      );
    } finally {
      await inst.shutdown();
    }
  });
});
