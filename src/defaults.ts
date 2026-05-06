/**
 * Module-level default telemetry instance, consumed by:
 *   - the `'aisdk-posthog/ai'` subpath wrappers, which auto-inject
 *     `experimental_telemetry` into AI SDK calls when the user hasn't
 *     supplied one.
 *   - the `subAgent()` helper, which uses it to look up `getTelemetry()`
 *     for the wrapped tool's functionId.
 *
 * Two registration modes:
 *   - `setDefaultTelemetry(instance)` — eager, when you build the instance
 *     at app boot.
 *   - `setDefaultTelemetry(() => instance)` — lazy, when the instance is
 *     built on first use (matches the lazy-init pattern many hosts use to
 *     avoid touching env / config until they have to).
 *
 * Both modes are call-once (subsequent calls replace the resolver).
 * Pass `undefined` (or `() => undefined`) to clear.
 */

import type { AISDKTelemetryInstance } from './factory';

type Resolver = () => AISDKTelemetryInstance | undefined;

let resolver: Resolver = () => undefined;

export function setDefaultTelemetry(
  arg: AISDKTelemetryInstance | Resolver | undefined,
): void {
  if (typeof arg === 'function') {
    resolver = arg;
  } else {
    const inst = arg;
    resolver = () => inst;
  }
}

export function getDefaultTelemetry(): AISDKTelemetryInstance | undefined {
  return resolver();
}
