/**
 * Tests for src/core/signals.ts
 *
 * AC-5b: 3-signal cross-scenarios — fully deterministic with mock.timers.
 *   buildAttemptSignal now uses AbortController + setTimeout (not AbortSignal.timeout),
 *   so all timers are interceptable by node:test mock.timers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttemptSignal } from '../src/core/signals';

describe('buildAttemptSignal', () => {
  it('returns a signal that never aborts when no constraints provided', () => {
    const { signal, effectiveTimeout, cleanup } = buildAttemptSignal({});
    assert.equal(effectiveTimeout, undefined);
    assert.equal(signal.aborted, false);
    cleanup();
  });

  it('returns caller signal directly when only callerSignal provided', () => {
    const controller = new AbortController();
    const { signal, effectiveTimeout, cleanup } = buildAttemptSignal({
      callerSignal: controller.signal,
    });
    assert.equal(effectiveTimeout, undefined);
    assert.equal(signal.aborted, false);
    controller.abort();
    assert.equal(signal.aborted, true);
    cleanup();
  });

  it('effectiveTimeout = timeout when only timeout provided', () => {
    const { effectiveTimeout, cleanup } = buildAttemptSignal({ timeout: 200 });
    assert.equal(effectiveTimeout, 200);
    cleanup();
  });

  it('effectiveTimeout = remainingDeadline when only deadline is tight', () => {
    const deadlineAt = Date.now() + 80;
    const { effectiveTimeout, cleanup } = buildAttemptSignal({ deadlineAt });
    // Allow ±5ms for execution time.
    assert.ok(
      effectiveTimeout !== undefined && effectiveTimeout >= 75 && effectiveTimeout <= 80,
      `effectiveTimeout should be ~80, got ${effectiveTimeout}`
    );
    cleanup();
  });

  it('AC-5b Case B: effectiveTimeout = min(timeout, remainingDeadline)', () => {
    // Pure arithmetic: no timer fired.
    const deadlineAt = Date.now() + 80;
    const { effectiveTimeout, cleanup } = buildAttemptSignal({
      timeout: 200,
      deadlineAt,
    });
    assert.ok(
      effectiveTimeout !== undefined && effectiveTimeout <= 80,
      `effectiveTimeout should be ≤80 (min of 200 and ~80), got ${effectiveTimeout}`
    );
    cleanup();
  });

  it('AC-5b Case A: composite signal aborts when caller aborts (synchronous)', () => {
    // Abort synchronously — no timer dependency.
    const controller = new AbortController();
    const { signal, cleanup } = buildAttemptSignal({
      callerSignal: controller.signal,
      timeout: 10_000,
      deadlineAt: Date.now() + 30_000,
    });

    assert.equal(signal.aborted, false);
    controller.abort();
    assert.equal(signal.aborted, true, 'composite signal should abort when caller aborts');
    cleanup();
  });

  it('timeout signal aborts after tick (mock timers)', async (t) => {
    // With mock.timers, the setTimeout in buildAttemptSignal is fake.
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const { signal, effectiveTimeout, cleanup } = buildAttemptSignal({ timeout: 50 });
    assert.equal(effectiveTimeout, 50);
    assert.equal(signal.aborted, false);

    // Advance fake clock by 50ms → the AbortController.abort() fires.
    t.mock.timers.tick(50);
    await Promise.resolve(); // flush microtasks

    assert.equal(signal.aborted, true, 'signal should abort after timeout tick');
    cleanup();
    t.mock.timers.reset();
  });

  it('cleanup cancels the timeout timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const { signal, cleanup } = buildAttemptSignal({ timeout: 100 });
    assert.equal(signal.aborted, false);

    // Cleanup before tick — timer should be cleared.
    cleanup();
    t.mock.timers.tick(100);
    await Promise.resolve();

    // Signal should NOT have aborted because cleanup cleared the timer.
    assert.equal(signal.aborted, false, 'cleanup should cancel the timeout timer');
    t.mock.timers.reset();
  });
});

describe('isCallerAbort', () => {
  it('returns false when callerSignal is not aborted', async () => {
    const { isCallerAbort } = await import('../src/core/signals');
    const controller = new AbortController();
    const err = new DOMException('abort', 'AbortError');
    assert.equal(isCallerAbort(err, controller.signal), false);
  });

  it('returns true when callerSignal is aborted and error is AbortError', async () => {
    const { isCallerAbort } = await import('../src/core/signals');
    const controller = new AbortController();
    controller.abort();
    const err = new DOMException('abort', 'AbortError');
    assert.equal(isCallerAbort(err, controller.signal), true);
  });

  it('returns false when callerSignal is aborted but error is not AbortError', async () => {
    const { isCallerAbort } = await import('../src/core/signals');
    const controller = new AbortController();
    controller.abort();
    const err = new Error('some other error');
    assert.equal(isCallerAbort(err, controller.signal), false);
  });

  it('returns false when no callerSignal provided', async () => {
    const { isCallerAbort } = await import('../src/core/signals');
    const err = new DOMException('abort', 'AbortError');
    assert.equal(isCallerAbort(err, undefined), false);
  });
});
