/**
 * Tests for src/core/signals.ts
 *
 * Cross-runtime: Node (mock.timers) and Bun (real timers).
 * buildAttemptSignal uses AbortController + setTimeout, so mock.timers
 * can intercept the timeout timer in Node.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttemptSignal } from '../src/core/signals';
import { enableFakeTimers, tick, flush, resetTimers } from './test-utils.ts';

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
    assert.ok(
      effectiveTimeout !== undefined && effectiveTimeout >= 75 && effectiveTimeout <= 80,
      `effectiveTimeout should be ~80, got ${effectiveTimeout}`
    );
    cleanup();
  });

  it('AC-5b Case B: effectiveTimeout = min(timeout, remainingDeadline)', () => {
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

  it('timeout signal aborts after tick', async (t) => {
    enableFakeTimers(t);

    const { signal, effectiveTimeout, cleanup } = buildAttemptSignal({ timeout: 50 });
    assert.equal(effectiveTimeout, 50);
    assert.equal(signal.aborted, false);

    await tick(50); // advance clock: fires the AbortController timeout
    await flush();

    assert.equal(signal.aborted, true, 'signal should abort after timeout tick');
    cleanup();
    resetTimers();
  });

  it('cleanup cancels the timeout timer', async (t) => {
    enableFakeTimers(t);

    const { signal, cleanup } = buildAttemptSignal({ timeout: 100 });
    assert.equal(signal.aborted, false);

    cleanup(); // cancel before tick
    await tick(100);
    await flush();

    assert.equal(signal.aborted, false, 'cleanup should cancel the timeout timer');
    resetTimers();
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
