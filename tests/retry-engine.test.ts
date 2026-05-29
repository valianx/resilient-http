/**
 * Tests for src/retry/engine.ts
 *
 * All ACs covered:
 *   AC-1:  fn never resolves + timeout:50 + maxAttempts:1 → rejects, no hang
 *   AC-2:  fn resolves before timeout → resolves; retries on retryable error
 *   AC-3:  GET 503 → retries; POST 503 → does NOT; network POST → does NOT
 *   AC-3b: POST timeout (no status) → does NOT retry; GET timeout → does retry;
 *          POST with retryableMethods:['POST'] → does
 *   AC-4:  timeout + deadline → limited attempts
 *   AC-5:  callerSignal aborted mid-flight → rejects AbortError, no retry
 *   AC-5b: 3-signal cross scenarios
 *   AC-6:  shouldRetry=true doesn't exceed maxAttempts/deadline; =false cuts early
 *   AC-6b: shouldRetry that throws → fail-closed, propagates original error
 *   AC-7:  happy path, exhaustion, non-retryable; onRetry/onFailure called correctly
 *   AC-8:  engine.ts does NOT import from errors/extractor.ts (grep check inline)
 *
 * Cross-runtime timer strategy:
 *   - buildAttemptSignal uses AbortController + setTimeout (not AbortSignal.timeout),
 *     so all timers are standard setTimeout calls.
 *   - Node 22: mock.timers intercepts setTimeout → tick() advances fake clock
 *     deterministically (total test time ~5ms).
 *   - Bun: mock.timers not available → tick() awaits real time. Bun's single-
 *     threaded test runner ensures sequential execution without cancellations.
 *   - initialDelay:0 + jitter:none makes inter-attempt sleep(0) instant.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeWithRetry, executeWithRetryAndSignal } from '../src/retry/engine';
import { enableFakeTimers, tick, flush, resetTimers } from './test-utils.ts';

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
// AC-1: fn that never resolves + timeout fires → rejects with TimeoutError
// ---------------------------------------------------------------------------

describe('AC-1: per-attempt timeout fires when fn never resolves', () => {
  it('rejects with TimeoutError when fn listens on signal abort', async (t) => {
    enableFakeTimers(t);

    const p = executeWithRetry(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('timeout', 'TimeoutError'));
          }, { once: true });
        }),
      { maxAttempts: 1, timeout: 80 }
    );

    await flush();
    await tick(80); // fires the AbortController timeout
    await flush();

    await assert.rejects(p, (err: unknown) => {
      // Use name check instead of instanceof for cross-runtime compat (Bun).
      assert.ok(
        err instanceof Error && err.name === 'TimeoutError',
        `expected TimeoutError, got ${err instanceof Error ? err.name : String(err)}`
      );
      return true;
    });

    resetTimers();
  });

  it('signal is propagated to fn and is aborted when timeout fires', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await tick(60);
    await flush();

    await assert.rejects(p);

    assert.ok(capturedSignal, 'fn should have received a signal');
    assert.equal(capturedSignal!.aborted, true, 'signal should be aborted after timeout');

    resetTimers();
  });
});

// ---------------------------------------------------------------------------
// AC-2: fn resolves before timeout → resolves; backoff on retryable error
// ---------------------------------------------------------------------------

describe('AC-2: fn resolves before timeout', () => {
  it('resolves successfully when fn returns before timeout', async (t) => {
    enableFakeTimers(t);

    const p = executeWithRetry(
      async () => 'ok',
      { maxAttempts: 1, timeout: 5000 }
    );

    await flush();
    const result = await p;
    assert.equal(result, 'ok');

    resetTimers();
  });

  it('retries on a retryable error and eventually succeeds', async (t) => {
    enableFakeTimers(t);
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw makeError({ statusCode: 503 });
        return 'done';
      },
      {
        maxAttempts: 3,
        initialDelay: 0,
        jitter: 'none',
        retryableMethods: ['GET'],
      },
      'GET'
    );

    await flush();
    await tick(0);
    await flush();
    await tick(0);
    await flush();

    const result = await p;
    assert.equal(result, 'done');
    assert.equal(calls, 3);

    resetTimers();
  });
});

// ---------------------------------------------------------------------------
// AC-3: GET 503 → retries; POST 503 → does NOT; network POST → does NOT
// ---------------------------------------------------------------------------

describe('AC-3: method gate', () => {
  it('GET 503 defaults → retries', async (t) => {
    enableFakeTimers(t);
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 503 });
      },
      { maxAttempts: 3, initialDelay: 0, jitter: 'none' },
      'GET'
    ).catch(() => { /* expected */ });

    await flush();
    await tick(0);
    await flush();
    await tick(0);
    await flush();
    await p;

    assert.equal(calls, 3, 'GET 503 should retry up to maxAttempts');
    resetTimers();
  });

  it('POST 503 defaults → does NOT retry', async (t) => {
    enableFakeTimers(t);
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 503 });
      },
      { maxAttempts: 3, initialDelay: 0, jitter: 'none' },
      'POST'
    ).catch(() => { /* expected */ });

    await flush();
    await p;

    assert.equal(calls, 1, 'POST 503 should not retry');
    resetTimers();
  });

  it('network error on POST → does NOT retry', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await p;

    assert.equal(calls, 1, 'network error on POST should not retry');
    resetTimers();
  });
});

// ---------------------------------------------------------------------------
// AC-3b: POST timeout no-status → no retry; GET timeout → yes;
//         POST with retryableMethods:['POST'] → yes
// ---------------------------------------------------------------------------

describe('AC-3b: timeout (no status) method gate', () => {
  it('POST timeout (no status) → does NOT retry (double-charge protection)', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await tick(30);
    await flush();
    await p;

    assert.equal(calls, 1, 'POST timeout should not retry');
    resetTimers();
  });

  it('GET timeout → retries', async (t) => {
    enableFakeTimers(t);
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

    for (let i = 0; i < 3; i++) {
      await flush();
      await tick(30);
      await flush();
      await tick(0);
      await flush();
    }
    await p;

    assert.ok(calls >= 2, `GET timeout should retry, got ${calls} calls`);
    resetTimers();
  });

  it('retryableMethods:["POST"] → POST retries on 503', async (t) => {
    enableFakeTimers(t);
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw makeError({ statusCode: 503 });
      },
      { maxAttempts: 3, initialDelay: 0, jitter: 'none', retryableMethods: ['POST'] },
      'POST'
    ).catch(() => { /* expected */ });

    await flush();
    await tick(0);
    await flush();
    await tick(0);
    await flush();
    await p;

    assert.equal(calls, 3, 'POST should retry when explicitly in retryableMethods');
    resetTimers();
  });
});

// ---------------------------------------------------------------------------
// AC-4: timeout + deadline → limited attempts
// ---------------------------------------------------------------------------

describe('AC-4: deadline hard cap', () => {
  it('stops retrying when deadline would be exceeded before next attempt', async (t) => {
    enableFakeTimers(t, { includeDate: true });
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

    await flush();
    await tick(50);
    await flush();
    await tick(0);
    await flush();
    await tick(50);
    await flush();
    await tick(0);
    await flush();
    await tick(50);
    await flush();
    await p;

    assert.ok(calls >= 1 && calls <= 4, `expected 1-4 attempts within deadline, got ${calls}`);
    resetTimers();
  });
});

// ---------------------------------------------------------------------------
// AC-5: callerSignal aborted → immediate AbortError, no retry
// ---------------------------------------------------------------------------

describe('AC-5: caller signal abort stops everything', () => {
  it('rejects immediately when callerSignal is aborted mid-flight', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    controller.abort(); // synchronous abort
    await flush();

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof DOMException);
      assert.equal(err.name, 'AbortError');
      return true;
    });

    assert.equal(calls, 1, 'should not retry after caller abort');
    resetTimers();
  });

  it('rejects with AbortError before first attempt when signal already aborted', async (t) => {
    enableFakeTimers(t);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const p = executeWithRetryAndSignal(
      async () => { calls++; return 'never'; },
      controller.signal,
      { maxAttempts: 3 }
    );

    await flush();

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof DOMException && err.name === 'AbortError');
      return true;
    });

    assert.equal(calls, 0, 'should not call fn when signal already aborted');
    resetTimers();
  });
});

// ---------------------------------------------------------------------------
// AC-5b: 3-signal cross scenarios at engine level
// ---------------------------------------------------------------------------

describe('AC-5b: engine-level 3-signal cross scenarios', () => {
  it('Case A: caller abort wins over internal timeout', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await tick(20); // advance 20ms (less than 200ms internal timeout)
    controller.abort(); // caller aborts before internal timeout
    await flush();

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof DOMException && err.name === 'AbortError',
        `expected AbortError, got ${err instanceof Error ? err.name : String(err)}`);
      return true;
    });

    resetTimers();
  });

  it('Case B: effectiveTimeout = min(timeout, remainingDeadline)', async () => {
    // Pure arithmetic — no timers needed.
    const deadlineAt = Date.now() + 80;
    const { buildAttemptSignal } = await import('../src/core/signals');
    const { effectiveTimeout, cleanup } = buildAttemptSignal({
      timeout: 200,
      deadlineAt,
    });
    assert.ok(
      effectiveTimeout !== undefined && effectiveTimeout <= 80,
      `effectiveTimeout should be ≤80, got ${effectiveTimeout}`
    );
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// AC-6: shouldRetry cannot override maxAttempts/deadline; false cuts early
// ---------------------------------------------------------------------------

describe('AC-6: shouldRetry gate', () => {
  it('shouldRetry returning true still respects maxAttempts hard cap', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await tick(0);
    await flush();
    await p;

    assert.equal(calls, 2, 'maxAttempts is a hard cap regardless of shouldRetry');
    resetTimers();
  });

  it('shouldRetry returning false stops retrying even when gate would allow', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await p;

    assert.equal(calls, 1, 'shouldRetry=false should cut retries immediately');
    resetTimers();
  });

  it('shouldRetry returning true still respects deadline', async (t) => {
    enableFakeTimers(t, { includeDate: true });
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

    await flush();
    await tick(30);
    await flush();
    await tick(0);
    await flush();
    await tick(30);
    await flush();
    await tick(30);
    await flush();
    await p;

    assert.ok(calls <= 4, `deadline should cap at ~2 attempts, got ${calls}`);
    resetTimers();
  });
});

// ---------------------------------------------------------------------------
// AC-6b: shouldRetry that throws → fail-closed, original error propagated
// ---------------------------------------------------------------------------

describe('AC-6b: shouldRetry fail-closed on throw', () => {
  it('propagates the ORIGINAL operation error when shouldRetry throws', async (t) => {
    enableFakeTimers(t);
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

    await flush();

    await assert.rejects(p, (err: unknown) => {
      assert.equal(err, originalError, 'should propagate original op error');
      return true;
    });

    assert.equal(calls, 1, 'should not retry when shouldRetry throws');
    resetTimers();
  });

  it('does not loop when shouldRetry throws on every call', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await p;

    assert.equal(calls, 1, 'should stop after first shouldRetry throw (fail-closed)');
    resetTimers();
  });
});

// ---------------------------------------------------------------------------
// AC-7: happy path, exhaustion, non-retryable, onRetry/onFailure
// ---------------------------------------------------------------------------

describe('AC-7: observers and lifecycle', () => {
  it('happy path: resolves without calling onRetry or onFailure', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    const result = await p;

    assert.equal(result, 42);
    assert.equal(retryCalls.length, 0);
    assert.equal(failureCalls.length, 0);
    resetTimers();
  });

  it('exhaustion: onRetry called N-1 times, onFailure called once', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await tick(0);
    await flush();
    await tick(0);
    await flush();
    await p;

    assert.equal(calls, 3);
    assert.equal(retryCalls.length, 2, 'onRetry called twice');
    assert.equal(failureCalls.length, 1, 'onFailure called once');
    assert.equal(retryCalls[0][1], 1);
    assert.equal(retryCalls[1][1], 2);
    assert.equal(failureCalls[0][1], 3);
    resetTimers();
  });

  it('non-retryable error: onFailure called immediately after first attempt', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await p;

    assert.equal(retryCalls.length, 0, 'onRetry should not be called for non-retryable');
    assert.equal(failureCalls.length, 1);
    assert.equal(failureCalls[0][1], 1, 'onFailure should report 1 attempt');
    resetTimers();
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
    enableFakeTimers(t);
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

    await flush();
    await tick(0);
    await flush();
    await p;

    assert.equal(calls, 2);
    resetTimers();
  });

  it('gives up when Retry-After (delta-seconds) exceeds maxRetryAfter', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await p;

    assert.equal(calls, 1, 'should give up when Retry-After exceeds maxRetryAfter');
    resetTimers();
  });

  it('negative Retry-After delta-seconds clamped to 0 and retries', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await tick(0);
    await flush();
    await p;

    assert.equal(calls, 2, 'negative Retry-After clamped to 0 should still retry');
    resetTimers();
  });
});

// ---------------------------------------------------------------------------
// SEC-001: no-method fail-safe (double-charge prevention)
// ---------------------------------------------------------------------------

describe('SEC-001: fail-safe method gate when no method is known', () => {
  it('network error with no method context → does NOT retry (fail-safe)', async (t) => {
    enableFakeTimers(t);
    const networkErr = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    let calls = 0;

    const p = executeWithRetry(
      async () => {
        calls++;
        throw networkErr;
      },
      { maxAttempts: 3, initialDelay: 0, jitter: 'none' }
    ).catch(() => { /* expected */ });

    await flush();
    await p;

    assert.equal(calls, 1, 'unknown method → fail-safe → no retry (SEC-001)');
    resetTimers();
  });

  it('timeout with no method context → does NOT retry (fail-safe)', async (t) => {
    enableFakeTimers(t);
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

    await flush();
    await tick(30);
    await flush();
    await p;

    assert.equal(calls, 1, 'unknown method on timeout → fail-safe → no retry (SEC-001)');
    resetTimers();
  });
});
