/**
 * Cross-runtime test utilities for node:test + Bun compatibility.
 *
 * node:test (Node ≥22) supports mock.timers for fully deterministic tests.
 * Bun's node:test shim does not implement mock.timers — tests run with real
 * timers. Since Bun runs tests single-threaded within each file, real timers
 * of up to 200ms are reliable.
 *
 * Usage in tests:
 *   import { enableFakeTimers, tick, flush, resetTimers } from './test-utils.ts';
 *
 * In Node: enableFakeTimers(t) activates mock.timers. tick(ms) advances the
 * fake clock. resetTimers() restores the originals.
 *
 * In Bun: enableFakeTimers(t) is a no-op. tick(ms) awaits a real Promise for
 * `ms` milliseconds so real timers can fire. resetTimers() is a no-op.
 */

type TestContext = {
  mock?: {
    timers?: {
      enable: (opts: { apis: string[] }) => void;
      tick: (ms: number) => void;
      reset: () => void;
    };
  };
};

let _ctx: TestContext | undefined;

/** True when running under Node.js node:test with mock.timers support. */
function isMockTimersAvailable(): boolean {
  return typeof _ctx?.mock?.timers?.enable === 'function';
}

/**
 * Call once at the start of each test that needs timer control.
 * Pass `includeDate: true` for tests that check deadline via Date.now().
 */
export function enableFakeTimers(t: TestContext, opts: { includeDate?: boolean } = {}): void {
  _ctx = t;
  if (isMockTimersAvailable()) {
    const apis: string[] = ['setTimeout'];
    if (opts.includeDate) apis.push('Date');
    _ctx!.mock!.timers!.enable({ apis });
  }
}

/**
 * Advance time by `ms` milliseconds.
 * In Node: advances the fake clock synchronously.
 * In Bun: waits real time so real timers can fire.
 */
export async function tick(ms: number): Promise<void> {
  if (isMockTimersAvailable()) {
    _ctx!.mock!.timers!.tick(ms);
  } else {
    await new Promise<void>((r) => setTimeout(r, ms + 10)); // +10ms buffer in Bun
  }
}

/** Drain the microtask queue. */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/** Reset fake timers (Node) or no-op (Bun). */
export function resetTimers(): void {
  if (isMockTimersAvailable()) {
    _ctx!.mock!.timers!.reset();
  }
  _ctx = undefined;
}
