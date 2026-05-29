/**
 * Tests for src/core/signals.ts
 *
 * AC-5b: 3-signal cross-scenarios — deterministic, no real timer waits.
 *   Case A: caller aborts → composite signal aborts.
 *   Case B: timeout:200 with deadline_remaining:80 → effectiveTimeout ≤ 80.
 *
 * All timing assertions here are purely arithmetic (Date.now() arithmetic
 * or effectiveTimeout value checks). Tests that need to observe a signal
 * aborting after a delay use AbortController.abort() synchronously so
 * there is no dependency on real or fake timers.
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
    // Pure arithmetic: no timer fired, just verifying the min() calculation.
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

  it('AC-5b Case A: composite signal aborts when caller aborts (synchronous abort)', () => {
    // We abort the caller synchronously — no timer dependency at all.
    const controller = new AbortController();
    const { signal, cleanup } = buildAttemptSignal({
      callerSignal: controller.signal,
      // Large timeout so AbortSignal.timeout won't compete.
      timeout: 10_000,
      deadlineAt: Date.now() + 30_000,
    });

    assert.equal(signal.aborted, false, 'should not be aborted before caller aborts');

    controller.abort();

    assert.equal(signal.aborted, true, 'composite signal should be aborted after caller aborts');
    cleanup();
  });

  it('effectiveTimeout reflects the configured timeout for timeout-only signal', () => {
    // Verifies that buildAttemptSignal sets effectiveTimeout correctly.
    // The actual abort from AbortSignal.timeout is tested via AC-1 in
    // retry-engine.test.ts (where fn listens on signal and the engine owns timeout).
    const { effectiveTimeout, cleanup } = buildAttemptSignal({ timeout: 30 });
    assert.equal(effectiveTimeout, 30, 'effectiveTimeout should equal the configured timeout');
    cleanup();
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
