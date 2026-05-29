/**
 * Tests for src/retry/engine.ts
 *
 * All ACs covered:
 *   AC-1:  fn never resolves + timeout:50 + maxAttempts:1 → rejects, no hang
 *   AC-2:  fn resolves before timeout → resolves; retries on retryable error
 *   AC-3:  GET 503 → retries; POST 503 → does NOT; network POST → does NOT
 *   AC-3b: POST timeout (no status) → does NOT retry; GET timeout → does retry;
 *          POST with retryableMethods:['POST'] → does
 *   AC-4:  timeout:50 + deadline:120, fn always exceeds → limited attempts
 *   AC-5:  callerSignal aborted mid-flight → rejects AbortError, no retry
 *   AC-5b: 3-signal cross scenarios
 *   AC-6:  shouldRetry=true doesn't exceed maxAttempts/deadline; =false cuts early
 *   AC-6b: shouldRetry that throws → fail-closed, propagates original error
 *   AC-7:  happy path, exhaustion, non-retryable; onRetry/onFailure called correctly
 *   AC-8:  engine.ts does NOT import from errors/extractor.ts (grep check inline)
 *
 * Determinism strategy:
 *   - buildAttemptSignal now uses AbortController + setTimeout (not AbortSignal.timeout)
 *     so mock.timers.enable(['setTimeout']) intercepts ALL timers — both the engine's
 *     per-attempt timeout AND the inter-attempt sleep().
 *   - Tests that need the fn to "time out" use t.mock.timers.tick() to advance
 *     the fake clock instead of waiting real milliseconds.
 *   - Tests for caller-abort semantics use AbortController.abort() synchronously.
 *   - initialDelay:0 + jitter:none makes inter-attempt sleep(0) a no-op tick.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeWithRetry, executeWithRetryAndSignal } from '../src/retry/engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(opts: {
  name?: string;
  statusCode?: number;
  code?: string;
  retryAfterSeconds?: number;
  method?: string;
  message?: string;
}): Error & Record<string, unknown> {
  const err = new Error(opts.message ?? 'test error') as Error & Record<string, unknown>;
  if (opts.name) err.name = opts.name;
  if (opts.statusCode !== undefined) {
    err['response'] = {
      status: opts.statusCode,
      headers: opts.retryAfterSeconds !== undefined
        ? { 'retry-after': String(opts.retryAfterSeconds) }
        : {},
    };
  }
  if (opts.code) err['code'] = opts.code;
  if (opts.method) {
    err['config'] = { method: opts.method };
  }
  return err;
}

// ---------------------------------------------------------------------------
// Helpers for mock.timers tests
//
// When mock.timers intercepts setTimeout, awaiting promises requires flushing
// the microtask queue between clock ticks. The engine has layered awaits:
//   fn() → sleep() → evaluateShouldRetry() → next iteration
// We flush with multiple Promise.resolve() rounds between ticks.
// ---------------------------------------------------------------------------

async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// AC-1: fn that never resolves + timeout fires → rejects with TimeoutError
//
// With mock.timers, the setTimeout in buildAttemptSignal is a fake timer.
// tick(timeout) fires the abort, which causes the fn to reject.
// ---------------------------------------------------------------------------

describe('AC-1: per-attempt timeout fires when fn never resolves', () => {
  it('rejects with TimeoutError when fn listens on signal abort', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const p = executeWithRetry(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('timeout', 'TimeoutError'));
          }, { once: true });
        }),
      { maxAttempts: 1, timeout: 80 }
    );

    await flushMicrotasks();
    t.mock.timers.tick(80); // fires the AbortController timeout in buildAttemptSignal
    await flushMicrotasks();

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof DOMException, `expected DOMException, got ${err}`);
      assert.equal(err.name, 'TimeoutError');
      return true;
    });

    t.mock.timers.reset();
  });

  it('signal is propagated to fn and is aborted when timeout fires', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let capturedSignal: AbortSignal | undefined;

    const p = executeWithRetry(
      ({ signal }) => {
        capturedSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('timeout', 'TimeoutError'));
          }, { once: true });
        });
      },
      { maxAttempts: 1, timeout: 60 }
    );

    await flushMicrotasks();
    t.mock.timers.tick(60);
    await flushMicrotasks();

    await assert.rejects(p);

    assert.ok(capturedSignal, 'fn should have received a signal');
    assert.equal(capturedSignal!.aborted, true, 'signal should be aborted after timeout');

    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-2: fn resolves before timeout → resolves; backoff on retryable error
// ---------------------------------------------------------------------------

describe('AC-2: fn resolves before timeout', () => {
  it('resolves successfully when fn returns before timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const p = executeWithRetry(
      async () => 'ok',
      { maxAttempts: 1, timeout: 5000 }
    );

    await flushMicrotasks();
    // fn resolves immediately — no tick needed for timeout.
    const result = await p;
    assert.equal(result, 'ok');

    t.mock.timers.reset();
  });

  it('retries on a retryable error and eventually succeeds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw makeError({ statusCode: 503 });
        return 'done';
      },
      {
        maxAttempts: 3,
        initialDelay: 0, // sleep(0) — instant
        jitter: 'none',
        retryableMethods: ['GET'],
      },
      'GET'
    );

    // Advance through inter-attempt sleeps.
    await flushMicrotasks();
    t.mock.timers.tick(0); // sleep(0) after attempt 1
    await flushMicrotasks();
    t.mock.timers.tick(0); // sleep(0) after attempt 2
    await flushMicrotasks();

    const result = await p;
    assert.equal(result, 'done');
    assert.equal(calls, 3);

    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-3: GET 503 → retries; POST 503 → does NOT; network POST → does NOT
// ---------------------------------------------------------------------------

describe('AC-3: method gate', () => {
  it('GET 503 defaults → retries', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 503 });
      },
      { maxAttempts: 3, initialDelay: 0, jitter: 'none' },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    t.mock.timers.tick(0);
    await flushMicrotasks();
    t.mock.timers.tick(0);
    await flushMicrotasks();
    await p;

    assert.equal(calls, 3, 'GET 503 should retry up to maxAttempts');
    t.mock.timers.reset();
  });

  it('POST 503 defaults → does NOT retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 503 });
      },
      { maxAttempts: 3, initialDelay: 0, jitter: 'none' },
      'POST'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    await p;

    assert.equal(calls, 1, 'POST 503 should not retry (default method gate)');
    t.mock.timers.reset();
  });

  it('network error on POST → does NOT retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const networkErr = makeError({ code: 'ECONNRESET' });
    networkErr['config'] = { method: 'POST' };

    const p = executeWithRetry(
      async () => {
        calls++;
        throw networkErr;
      },
      { maxAttempts: 3, initialDelay: 0, jitter: 'none' },
      'POST'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    await p;

    assert.equal(calls, 1, 'network error on POST should not retry');
    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-3b: POST timeout no-status → no retry; GET timeout → yes;
//         POST with retryableMethods:['POST'] → yes
// ---------------------------------------------------------------------------

describe('AC-3b: timeout (no status) method gate', () => {
  it('POST timeout (no status) → does NOT retry (double-charge protection)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async ({ signal }) => {
        calls++;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'TimeoutError'))
          , { once: true });
        });
      },
      { maxAttempts: 3, timeout: 30, jitter: 'none', initialDelay: 0 },
      'POST'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    t.mock.timers.tick(30); // fire the timeout → POST should NOT retry
    await flushMicrotasks();
    await p;

    assert.equal(calls, 1, 'POST timeout should not retry');
    t.mock.timers.reset();
  });

  it('GET timeout → retries', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async ({ signal }) => {
        calls++;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'TimeoutError'))
          , { once: true });
        });
      },
      { maxAttempts: 3, timeout: 30, jitter: 'none', initialDelay: 0 },
      'GET'
    ).catch(() => { /* expected */ });

    // Each attempt: tick to fire timeout, flush, then tick 0 for inter-attempt sleep.
    for (let i = 0; i < 3; i++) {
      await flushMicrotasks();
      t.mock.timers.tick(30); // fire per-attempt timeout
      await flushMicrotasks();
      t.mock.timers.tick(0); // fire inter-attempt sleep(0)
      await flushMicrotasks();
    }
    await p;

    assert.ok(calls >= 2, `GET timeout should retry, got ${calls} calls`);
    t.mock.timers.reset();
  });

  it('retryableMethods:["POST"] → POST retries on 503', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 503 });
      },
      { maxAttempts: 3, initialDelay: 0, jitter: 'none', retryableMethods: ['POST'] },
      'POST'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    t.mock.timers.tick(0);
    await flushMicrotasks();
    t.mock.timers.tick(0);
    await flushMicrotasks();
    await p;

    assert.equal(calls, 3, 'POST should retry when explicitly in retryableMethods');
    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-4: timeout + deadline → limited attempts
// ---------------------------------------------------------------------------

describe('AC-4: deadline hard cap', () => {
  it('stops retrying when deadline would be exceeded before next attempt', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let calls = 0;
    const deadline = Date.now() + 120;

    const p = executeWithRetry(
      async ({ signal }) => {
        calls++;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'TimeoutError'))
          , { once: true });
        });
      },
      {
        maxAttempts: 10,
        timeout: 50,
        deadline,
        initialDelay: 0,
        jitter: 'none',
      },
      'GET'
    ).catch(() => { /* expected rejection */ });

    // Attempt 1: tick 50ms (timeout fires), then 0ms (sleep), then advance
    // Date by 50ms so deadline check fails for next attempts.
    await flushMicrotasks();
    t.mock.timers.tick(50);
    await flushMicrotasks();
    t.mock.timers.tick(0); // inter-attempt sleep
    await flushMicrotasks();

    // Attempt 2: tick another 50ms
    t.mock.timers.tick(50);
    await flushMicrotasks();
    t.mock.timers.tick(0);
    await flushMicrotasks();

    // Advance more to push past deadline (120ms from start)
    t.mock.timers.tick(50);
    await flushMicrotasks();

    await p;

    assert.ok(calls >= 1 && calls <= 4, `expected 1-4 attempts within deadline, got ${calls}`);
    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-5: callerSignal aborted → immediate AbortError, no retry
// ---------------------------------------------------------------------------

describe('AC-5: caller signal abort stops everything', () => {
  it('rejects immediately when callerSignal is aborted mid-flight', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    let calls = 0;

    const p = executeWithRetryAndSignal(
      ({ signal }) => {
        calls++;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('abort', 'AbortError'))
          , { once: true });
        });
      },
      controller.signal,
      { maxAttempts: 5, initialDelay: 1000 }
    );

    await flushMicrotasks();

    // Abort the caller signal — this triggers the fn's abort listener immediately.
    controller.abort();
    await flushMicrotasks();

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof DOMException);
      assert.equal(err.name, 'AbortError');
      return true;
    });

    assert.equal(calls, 1, 'should not retry after caller abort');
    t.mock.timers.reset();
  });

  it('rejects with AbortError before first attempt when signal already aborted', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const p = executeWithRetryAndSignal(
      async () => { calls++; return 'never'; },
      controller.signal,
      { maxAttempts: 3 }
    );

    await flushMicrotasks();

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof DOMException && err.name === 'AbortError');
      return true;
    });

    assert.equal(calls, 0, 'should not call fn when signal already aborted');
    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-5b: 3-signal cross scenarios at engine level
// ---------------------------------------------------------------------------

describe('AC-5b: engine-level 3-signal cross scenarios', () => {
  it('Case A: caller abort wins over internal timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();

    const p = executeWithRetryAndSignal(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            if (controller.signal.aborted) {
              reject(new DOMException('caller abort', 'AbortError'));
            } else {
              reject(new DOMException('timeout', 'TimeoutError'));
            }
          }, { once: true });
        }),
      controller.signal,
      { maxAttempts: 1, timeout: 200 }
    );

    await flushMicrotasks();

    // Abort caller at tick 20ms (before 200ms internal timeout).
    t.mock.timers.tick(20);
    controller.abort(); // abort happens at fake 20ms
    await flushMicrotasks();

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof DOMException && err.name === 'AbortError',
        `expected AbortError, got ${err instanceof Error ? err.name : String(err)}`);
      return true;
    });

    t.mock.timers.reset();
  });

  it('Case B: effective timeout = min(timeout, remainingDeadline)', async (t) => {
    // Pure arithmetic test: verify effectiveTimeout is set correctly.
    // No real timers needed — just verify the calculation.
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const { buildAttemptSignal } = await import('../src/core/signals');
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

    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-6: shouldRetry cannot override maxAttempts/deadline; false cuts early
// ---------------------------------------------------------------------------

describe('AC-6: shouldRetry gate', () => {
  it('shouldRetry returning true still respects maxAttempts hard cap', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 503 });
      },
      {
        maxAttempts: 2,
        initialDelay: 0,
        jitter: 'none',
        shouldRetry: () => true,
      },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    t.mock.timers.tick(0);
    await flushMicrotasks();
    await p;

    assert.equal(calls, 2, 'maxAttempts is a hard cap regardless of shouldRetry');
    t.mock.timers.reset();
  });

  it('shouldRetry returning false stops retrying even when gate would allow', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 503 });
      },
      {
        maxAttempts: 5,
        initialDelay: 0,
        jitter: 'none',
        shouldRetry: () => false,
      },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    await p;

    assert.equal(calls, 1, 'shouldRetry=false should cut retries immediately');
    t.mock.timers.reset();
  });

  it('shouldRetry returning true still respects deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let calls = 0;
    const deadline = Date.now() + 60;

    const p = executeWithRetry(
      async ({ signal }) => {
        calls++;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'TimeoutError'))
          , { once: true });
        });
      },
      {
        maxAttempts: 100,
        timeout: 30,
        deadline,
        initialDelay: 0,
        jitter: 'none',
        shouldRetry: () => true,
      },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    t.mock.timers.tick(30); // attempt 1 timeout
    await flushMicrotasks();
    t.mock.timers.tick(0);  // sleep
    await flushMicrotasks();
    t.mock.timers.tick(30); // attempt 2 timeout
    await flushMicrotasks();
    t.mock.timers.tick(30); // push past deadline
    await flushMicrotasks();
    await p;

    assert.ok(calls <= 4, `deadline should cap at ~2 attempts, got ${calls}`);
    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-6b: shouldRetry that throws → fail-closed, original error propagated
// ---------------------------------------------------------------------------

describe('AC-6b: shouldRetry fail-closed on throw', () => {
  it('propagates the ORIGINAL operation error when shouldRetry throws', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const originalError = makeError({ statusCode: 503 });

    let calls = 0;
    const p = executeWithRetry(
      async () => {
        calls++;
        throw originalError;
      },
      {
        maxAttempts: 3,
        initialDelay: 0,
        jitter: 'none',
        shouldRetry: () => { throw new Error('hook exploded'); },
      },
      'GET'
    );

    await flushMicrotasks();

    await assert.rejects(p, (err: unknown) => {
      assert.equal(err, originalError, 'should propagate original op error');
      return true;
    });

    assert.equal(calls, 1, 'should not retry when shouldRetry throws');
    t.mock.timers.reset();
  });

  it('does not loop when shouldRetry throws on every call', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 500 });
      },
      {
        maxAttempts: 10,
        initialDelay: 0,
        jitter: 'none',
        shouldRetry: () => { throw new Error('boom'); },
      },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    await p;

    assert.equal(calls, 1, 'should stop after first shouldRetry throw (fail-closed)');
    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-7: happy path, exhaustion, non-retryable, onRetry/onFailure
// ---------------------------------------------------------------------------

describe('AC-7: observers and lifecycle', () => {
  it('happy path: resolves without calling onRetry or onFailure', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const retryCalls: number[] = [];
    const failureCalls: number[] = [];

    const p = executeWithRetry(
      async () => 42,
      {
        maxAttempts: 3,
        onRetry: () => { retryCalls.push(1); },
        onFailure: () => { failureCalls.push(1); },
      }
    );

    await flushMicrotasks();
    const result = await p;

    assert.equal(result, 42);
    assert.equal(retryCalls.length, 0);
    assert.equal(failureCalls.length, 0);
    t.mock.timers.reset();
  });

  it('exhaustion: onRetry called N-1 times, onFailure called once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const retryCalls: Array<[unknown, number, number]> = [];
    const failureCalls: Array<[unknown, number]> = [];
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 503 });
      },
      {
        maxAttempts: 3,
        initialDelay: 0,
        jitter: 'none',
        onRetry: (err, attempt, delay) => { retryCalls.push([err, attempt, delay]); },
        onFailure: (err, attempts) => { failureCalls.push([err, attempts]); },
      },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    t.mock.timers.tick(0);
    await flushMicrotasks();
    t.mock.timers.tick(0);
    await flushMicrotasks();
    await p;

    assert.equal(calls, 3);
    assert.equal(retryCalls.length, 2, 'onRetry called twice');
    assert.equal(failureCalls.length, 1, 'onFailure called once');
    assert.equal(retryCalls[0][1], 1);
    assert.equal(retryCalls[1][1], 2);
    assert.equal(failureCalls[0][1], 3);
    t.mock.timers.reset();
  });

  it('non-retryable error: onFailure called immediately after first attempt', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const failureCalls: Array<[unknown, number]> = [];
    const retryCalls: number[] = [];

    const p = executeWithRetry(
      async () => { throw makeError({ statusCode: 404 }); },
      {
        maxAttempts: 5,
        onRetry: () => { retryCalls.push(1); },
        onFailure: (err, attempts) => { failureCalls.push([err, attempts]); },
      },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    await p;

    assert.equal(retryCalls.length, 0, 'onRetry should not be called for non-retryable');
    assert.equal(failureCalls.length, 1);
    assert.equal(failureCalls[0][1], 1, 'onFailure should report 1 attempt');
    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// AC-8: engine.ts does NOT import from errors/extractor.ts
// ---------------------------------------------------------------------------

describe('AC-8: no import from errors/extractor in engine.ts', () => {
  it('engine source file does not reference errors/extractor', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const enginePath = path.resolve(
      new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
      '../src/retry/engine.ts'
    );
    const source = fs.readFileSync(enginePath, 'utf-8');
    const hasExtractorImport = /from ['"].*errors\/extractor['"]/.test(source);
    assert.equal(
      hasExtractorImport,
      false,
      'engine.ts must not import from errors/extractor.ts'
    );
  });
});

// ---------------------------------------------------------------------------
// Retry-After header handling
// ---------------------------------------------------------------------------

describe('Retry-After header handling', () => {
  it('respects Retry-After (delta-seconds 0) when within maxRetryAfter', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 429, retryAfterSeconds: 0 }); // 0s → instant
      },
      {
        maxAttempts: 2,
        respectRetryAfter: true,
        maxRetryAfter: 60000,
        jitter: 'none',
      },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    t.mock.timers.tick(0); // 0ms Retry-After
    await flushMicrotasks();
    await p;

    assert.equal(calls, 2);
    t.mock.timers.reset();
  });

  it('gives up when Retry-After (delta-seconds) exceeds maxRetryAfter', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 429, retryAfterSeconds: 120 }); // 120s > 60s cap
      },
      {
        maxAttempts: 3,
        respectRetryAfter: true,
        maxRetryAfter: 60000,
        jitter: 'none',
      },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    await p;

    assert.equal(calls, 1, 'should give up when Retry-After exceeds maxRetryAfter');
    t.mock.timers.reset();
  });

  it('negative Retry-After delta-seconds clamped to 0 and retries', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 429, retryAfterSeconds: -10 }); // clamped to 0
      },
      {
        maxAttempts: 2,
        respectRetryAfter: true,
        maxRetryAfter: 60000,
        jitter: 'none',
      },
      'GET'
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    t.mock.timers.tick(0); // 0ms after clamp
    await flushMicrotasks();
    await p;

    assert.equal(calls, 2, 'negative Retry-After clamped to 0 should still retry');
    t.mock.timers.reset();
  });
});

// ---------------------------------------------------------------------------
// SEC-001: no-method fail-safe (double-charge prevention)
// ---------------------------------------------------------------------------

describe('SEC-001: fail-safe method gate when no method is known', () => {
  it('network error with no method context → does NOT retry (fail-safe)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const networkErr = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw networkErr;
      },
      { maxAttempts: 3, initialDelay: 0, jitter: 'none' }
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    await p;

    assert.equal(calls, 1, 'unknown method → fail-safe → no retry (SEC-001)');
    t.mock.timers.reset();
  });

  it('timeout with no method context → does NOT retry (fail-safe)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;

    const p = executeWithRetry(
      async ({ signal }) => {
        calls++;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'TimeoutError'))
          , { once: true });
        });
      },
      { maxAttempts: 3, timeout: 30, jitter: 'none', initialDelay: 0 }
    ).catch(() => { /* expected */ });

    await flushMicrotasks();
    t.mock.timers.tick(30); // fire the timeout
    await flushMicrotasks();
    await p;

    assert.equal(calls, 1, 'unknown method on timeout → fail-safe → no retry (SEC-001)');
    t.mock.timers.reset();
  });
});
