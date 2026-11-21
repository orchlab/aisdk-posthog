/**
 * Shared fake posthog-node client. Each suite mocks the module with
 *
 *   vi.mock('posthog-node', () => import('./posthogMock'));
 *
 * and imports the recorders below from the same module, so the factory's
 * `new PostHog(...)` and the test see the same state.
 */

import { vi } from 'vitest';

export interface Captured {
  distinctId: string;
  event: string;
  properties: Record<string, any>;
  groups?: Record<string, string>;
  timestamp?: Date;
}

/** Every event the exporter sent with `captureAi`, in order. */
export const captureCalls: Captured[] = [];

/** `'error'` listeners the exporter registered on the client. */
export const errorListeners: Array<(err: unknown) => void> = [];

/** Spy on `capture`, which the exporter must not use for `$ai_*` events. */
export const capture = vi.fn();

export function resetPosthogMock(): void {
  captureCalls.length = 0;
  errorListeners.length = 0;
  capture.mockClear();
}

export const PostHog = vi.fn().mockImplementation(() => ({
  capture,
  captureAi: vi.fn((params: Captured) => {
    captureCalls.push(params);
  }),
  on: vi.fn((event: string, listener: (err: unknown) => void) => {
    if (event === 'error') {
      errorListeners.push(listener);
    }
    return () => {};
  }),
  flush: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}),
}));
