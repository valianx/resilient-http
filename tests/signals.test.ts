/**
 * Tests for src/core/signals.ts
 *
 * AC-5b: 3-signal cross-scenarios (fake timers).
 *   Case A: timeout:100, deadline:300, caller aborts ~50ms → caller wins.
 *   Case B: timeout:200 with deadline_remaining:80 → effective timeout ~80ms.
 */

import { describe, it, mock } from 'node:test';
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
    // Allow ±5ms for execution time
    assert.ok(
      effectiveTimeout !== undefined && effectiveTimeout >= 75 && effectiveTimeout <= 80,
      `effectiveTimeout should be ~80, got ${effectiveTimeout}`
    );
    cleanup();
  });

  it('AC-5b Case B: effectiveTimeout = min(timeout, remainingDeadline)', () => {
    // timeout:200, deadline_remaining:80 → min = 80
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

  it('AC-5b Case A: composite signal aborts when caller aborts (before timeout)', async () => {
    const controller = new AbortController();
    const { signal, cleanup } = buildAttemptSignal({
      callerSignal: controller.signal,
      timeout: 100,
      deadlineAt: Date.now() + 300,
    });

    assert.equal(signal.aborted, false);

    // Simulate caller abort after ~5ms
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 5);
    });

    assert.equal(signal.aborted, true, 'composite signal should be aborted after caller aborts');
    cleanup();
  });

  it('composite signal propagates timeout abort without caller', async () => {
    const { signal, cleanup } = buildAttemptSignal({ timeout: 30 });
    assert.equal(signal.aborted, false);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.equal(signal.aborted, true, 'signal should be aborted after timeout');
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

// Suppress unused import warning from node:test
void mock;
