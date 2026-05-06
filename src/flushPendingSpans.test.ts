/**
 * Focused tests for `PostHogAISdkExporter.flushPendingSpans` — the
 * temporal-containment re-parenting that fixes streaming-broken parent
 * relationships.
 *
 * Two paths under test:
 *   1. "Trust first" — when a child's actual OTel parent IS a known
 *      traceOp span (`ai.streamText` etc.), the override is NOT applied
 *      and the real parent is preserved. This matters for parallel
 *      sub-agents whose time ranges overlap; without the trust-first
 *      branch, temporal containment would attribute the child to the
 *      wrong parent.
 *   2. "Temporal containment fallback" — when a child's actual parent is
 *      NOT a traceOp span (streaming dropped the context), the exporter
 *      finds the smallest enclosing traceOp span by start-time
 *      containment and reparents to it.
 *
 * Both paths are observable through the captured PostHog events'
 * `$ai_parent_id` field, set by `getBaseProperties`:
 *
 *   $ai_parent_id: parentOverrides?.get(spanId) ?? rawParentId
 */

import { context as otelContext, trace } from '@opentelemetry/api';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAISDKTelemetry } from './factory';

const captureCalls: Array<{
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
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

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe('flushPendingSpans temporal containment', () => {
  // The OTel global context manager is process-wide; register once.
  let inst: ReturnType<typeof createAISDKTelemetry>;
  beforeAll(() => {
    inst = createAISDKTelemetry({
      apiKey: 'phc_test',
      enabled: true,
      registerGlobalContextManager: true,
      getContext: () => ({ distinctId: 'user_test' }),
    });
  });

  it('keeps real parent when child OTel parent is a known traceOp span', async () => {
    await inst.withExecutionTrace('exec_trust', 'chat.reply', {}, async () => {
      const cfg = inst.getTelemetry('test')!;
      const tracer = cfg.tracer;

      // Parent A starts in the execution context. Its parent is the
      // execution root span (chat.reply).
      const parentA = tracer.startSpan('ai.streamText', {
        attributes: { 'ai.operationId': 'ai.streamText' },
      });

      // Real child of parentA: started inside parentA's context, so its
      // OTel parent is parentA's spanId. The exporter should "trust"
      // this parent and NOT override.
      const parentACtx = trace.setSpan(otelContext.active(), parentA);
      await otelContext.with(parentACtx, async () => {
        const child = tracer.startSpan('ai.streamText.doStream', {
          attributes: { 'ai.operationId': 'ai.streamText.doStream' },
        });
        await delay(2);
        child.end();
      });

      await delay(2);
      parentA.end();
    });

    const generation = captureCalls.find((c) => c.event === '$ai_generation');
    expect(generation).toBeDefined();

    const parentTrace = captureCalls.find(
      (c) =>
        c.event === '$ai_span' &&
        c.properties.$ai_span_name === 'ai.streamText',
    );
    expect(parentTrace).toBeDefined();

    // The generation event's parent should be parentA's spanId — the OTel
    // parent was preserved, no override happened.
    expect(generation!.properties.$ai_parent_id).toBe(
      parentTrace!.properties.$ai_span_id,
    );
  });

  it('reparents orphan via temporal containment when OTel parent is not a traceOp', async () => {
    await inst.withExecutionTrace('exec_orphan', 'chat.reply', {}, async () => {
      const cfg = inst.getTelemetry('test')!;
      const tracer = cfg.tracer;

      // Capture the execution context so we can start orphans under
      // the execution root (NOT inside parentA's active context).
      const execCtx = otelContext.active();

      // Parent A: a real ai.streamText.
      const parentA = tracer.startSpan('ai.streamText', {
        attributes: { 'ai.operationId': 'ai.streamText' },
      });

      // Orphan: starts under the execution context (parent = chat.reply
      // root span, which is NOT a traceOp). Temporal containment should
      // re-parent it to parentA.
      await delay(2);
      await otelContext.with(execCtx, async () => {
        const orphan = tracer.startSpan('ai.streamText.doStream', {
          attributes: { 'ai.operationId': 'ai.streamText.doStream' },
        });
        await delay(2);
        orphan.end();
      });

      await delay(2);
      parentA.end();
    });

    const parentTrace = captureCalls.find(
      (c) =>
        c.event === '$ai_span' &&
        c.properties.$ai_span_name === 'ai.streamText',
    );
    expect(parentTrace).toBeDefined();

    const orphan = captureCalls.find((c) => c.event === '$ai_generation');
    expect(orphan).toBeDefined();

    // The orphan's $ai_parent_id should now point at parentA, not at the
    // execution root span — confirming the override was applied.
    expect(orphan!.properties.$ai_parent_id).toBe(
      parentTrace!.properties.$ai_span_id,
    );
  });

  it('picks the smallest enclosing traceOp span for nested orphans', async () => {
    await inst.withExecutionTrace('exec_nested', 'chat.reply', {}, async () => {
      const cfg = inst.getTelemetry('test')!;
      const tracer = cfg.tracer;
      const execCtx = otelContext.active();

      // Outer ai.streamText (long-lived).
      const outer = tracer.startSpan('ai.streamText', {
        attributes: { 'ai.operationId': 'ai.streamText' },
      });

      await delay(5);

      // Inner ai.streamText (short-lived, fully inside outer's window).
      const inner = tracer.startSpan('ai.streamText', {
        attributes: { 'ai.operationId': 'ai.streamText' },
      });

      await delay(2);

      // Orphan whose start time falls inside both outer AND inner. The
      // exporter should pick `inner` (smaller duration) per the
      // bestDuration tiebreak.
      await otelContext.with(execCtx, async () => {
        const orphan = tracer.startSpan('ai.streamText.doStream', {
          attributes: { 'ai.operationId': 'ai.streamText.doStream' },
        });
        await delay(1);
        orphan.end();
      });

      await delay(1);
      inner.end();

      await delay(2);
      outer.end();
    });

    const traceOps = captureCalls.filter(
      (c) =>
        c.event === '$ai_span' &&
        c.properties.$ai_span_name === 'ai.streamText',
    );
    expect(traceOps).toHaveLength(2);

    // Identify outer vs inner by latency (outer is longer).
    const sortedByLatency = traceOps.sort(
      (a, b) =>
        (a.properties.$ai_latency as number) -
        (b.properties.$ai_latency as number),
    );
    const innerEvent = sortedByLatency[0];

    const orphan = captureCalls.find((c) => c.event === '$ai_generation');
    expect(orphan).toBeDefined();

    // Smallest enclosing traceOp wins.
    expect(orphan!.properties.$ai_parent_id).toBe(
      innerEvent.properties.$ai_span_id,
    );
  });
});
