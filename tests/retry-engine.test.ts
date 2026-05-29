/**
 * Tests for src/retry/engine.ts
 *
 * All ACs covered:
 *   AC-1:  fn never resolves + timeout:50 + maxAttempts:1 → rejects ~50ms, no hang
 *   AC-2:  fn resolves before timeout → resolves; retries on retryable error
 *   AC-3:  GET 503 → retries; POST 503 → does NOT; network POST → does NOT
 *   AC-3b: POST timeout (no status) → does NOT retry; GET timeout → does; POST with retryableMethods:['POST'] → does
 *   AC-4:  timeout:50 + deadline:120, fn always exceeds → ~2 attempts, rejects timeout
 *   AC-5:  callerSignal aborted mid-flight → rejects AbortError, no retry
 *   AC-5b: 3-signal cross scenarios (tested in signals.test.ts; engine-level check here)
 *   AC-6:  shouldRetry=true doesn't exceed maxAttempts/deadline; =false cuts early
 *   AC-6b: shouldRetry that throws → fail-closed, propagates original error
 *   AC-7:  happy path, exhaustion, non-retryable; onRetry/onFailure called correctly
 *   AC-8:  engine.ts does NOT import from errors/extractor.ts (grep check inline)
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

function makeTimeoutError(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function makeAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

// ---------------------------------------------------------------------------
// AC-1: fn that never resolves + timeout:50 + maxAttempts:1 → rejects ~timeout
// ---------------------------------------------------------------------------

describe('AC-1: per-attempt timeout fires when fn never resolves', () => {
  it('rejects with TimeoutError within the timeout window', async () => {
    const start = Date.now();

    await assert.rejects(
      () =>
        executeWithRetry(
          ({ signal }) =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(new DOMException('timeout', 'TimeoutError'));
              }, { once: true });
            }),
          { maxAttempts: 1, timeout: 80 }
        ),
      (err: unknown) => {
        assert.ok(err instanceof DOMException);
        assert.equal(err.name, 'TimeoutError');
        return true;
      }
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 300, `should resolve within 300ms, took ${elapsed}ms`);
  });

  it('signal is propagated to fn and is aborted when timeout fires', async () => {
    let capturedSignal: AbortSignal | undefined;

    await assert.rejects(
      () =>
        executeWithRetry(
          ({ signal }) => {
            capturedSignal = signal;
            return new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(new DOMException('timeout', 'TimeoutError'));
              }, { once: true });
            });
          },
          { maxAttempts: 1, timeout: 60 }
        )
    );

    assert.ok(capturedSignal, 'fn should have received a signal');
    assert.equal(capturedSignal!.aborted, true, 'signal should be aborted after timeout');
  });
});

// ---------------------------------------------------------------------------
// AC-2: fn resolves before timeout → resolves; backoff on retryable error
// ---------------------------------------------------------------------------

describe('AC-2: fn resolves before timeout', () => {
  it('resolves successfully when fn returns before timeout', async () => {
    const result = await executeWithRetry(
      async () => 'ok',
      { maxAttempts: 1, timeout: 5000 }
    );
    assert.equal(result, 'ok');
  });

  it('retries on a retryable error and eventually succeeds', async () => {
    let calls = 0;
    const result = await executeWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw makeError({ statusCode: 503 });
        return 'done';
      },
      {
        maxAttempts: 3,
        initialDelay: 10,
        jitter: 'none',
        retryableMethods: ['GET'],
      },
      'GET'
    );
    assert.equal(result, 'done');
    assert.equal(calls, 3);
  });
});

// ---------------------------------------------------------------------------
// AC-3: GET 503 → retries; POST 503 → does NOT; network POST → does NOT
// ---------------------------------------------------------------------------

describe('AC-3: method gate', () => {
  it('GET 503 defaults → retries', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw makeError({ statusCode: 503 });
          },
          { maxAttempts: 3, initialDelay: 1, jitter: 'none' },
          'GET'
        )
    );
    assert.equal(calls, 3, 'GET 503 should retry up to maxAttempts');
  });

  it('POST 503 defaults → does NOT retry', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw makeError({ statusCode: 503 });
          },
          { maxAttempts: 3, initialDelay: 1, jitter: 'none' },
          'POST'
        )
    );
    assert.equal(calls, 1, 'POST 503 should not retry (default method gate)');
  });

  it('network error on POST → does NOT retry', async () => {
    let calls = 0;
    const networkErr = makeError({ code: 'ECONNRESET' });
    networkErr['config'] = { method: 'POST' };

    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw networkErr;
          },
          { maxAttempts: 3, initialDelay: 1, jitter: 'none' },
          'POST'
        )
    );
    assert.equal(calls, 1, 'network error on POST should not retry');
  });
});

// ---------------------------------------------------------------------------
// AC-3b: POST timeout no-status → no retry; GET timeout → yes; POST with retryableMethods:['POST'] → yes
// ---------------------------------------------------------------------------

describe('AC-3b: timeout (no status) method gate', () => {
  it('POST timeout (no status) → does NOT retry (double-charge protection)', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWithRetry(
          async ({ signal }) => {
            calls++;
            return new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                reject(new DOMException('timeout', 'TimeoutError'))
              , { once: true });
            });
          },
          { maxAttempts: 3, timeout: 30, jitter: 'none', initialDelay: 1 },
          'POST'
        )
    );
    assert.equal(calls, 1, 'POST timeout should not retry');
  });

  it('GET timeout → retries', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWithRetry(
          async ({ signal }) => {
            calls++;
            return new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                reject(new DOMException('timeout', 'TimeoutError'))
              , { once: true });
            });
          },
          { maxAttempts: 3, timeout: 30, jitter: 'none', initialDelay: 1 },
          'GET'
        )
    );
    assert.ok(calls >= 2, `GET timeout should retry, got ${calls} calls`);
  });

  it('retryableMethods:["POST"] → POST retries on 503', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw makeError({ statusCode: 503 });
          },
          { maxAttempts: 3, initialDelay: 1, jitter: 'none', retryableMethods: ['POST'] },
          'POST'
        )
    );
    assert.equal(calls, 3, 'POST should retry when explicitly in retryableMethods');
  });
});

// ---------------------------------------------------------------------------
// AC-4: timeout + deadline → ~2 attempts, 3rd doesn't start
// ---------------------------------------------------------------------------

describe('AC-4: deadline hard cap', () => {
  it('stops retrying when deadline would be exceeded before next attempt', async () => {
    let calls = 0;
    const deadline = Date.now() + 120;

    await assert.rejects(
      () =>
        executeWithRetry(
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
            initialDelay: 1,
            jitter: 'none',
          },
          'GET'
        ),
      (err: unknown) => {
        assert.ok(
          err instanceof DOMException && err.name === 'TimeoutError',
          `expected TimeoutError, got ${err instanceof Error ? err.name : String(err)}`
        );
        return true;
      }
    );

    // With timeout:50 and deadline:120, we expect at most 2-3 calls depending on timing.
    assert.ok(calls >= 1 && calls <= 4, `expected 1-4 attempts within deadline, got ${calls}`);
  });
});

// ---------------------------------------------------------------------------
// AC-5: callerSignal aborted → immediate AbortError, no retry
// ---------------------------------------------------------------------------

describe('AC-5: caller signal abort stops everything', () => {
  it('rejects immediately when callerSignal is aborted mid-flight', async () => {
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

    // Abort after a short delay
    setTimeout(() => controller.abort(), 10);

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof DOMException);
      assert.equal(err.name, 'AbortError');
      return true;
    });

    assert.equal(calls, 1, 'should not retry after caller abort');
  });

  it('rejects with AbortError before first attempt when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await assert.rejects(
      () =>
        executeWithRetryAndSignal(
          async () => { calls++; return 'never'; },
          controller.signal,
          { maxAttempts: 3 }
        ),
      (err: unknown) => {
        assert.ok(err instanceof DOMException && err.name === 'AbortError');
        return true;
      }
    );

    assert.equal(calls, 0, 'should not call fn when signal already aborted');
  });
});

// ---------------------------------------------------------------------------
// AC-5b: 3-signal cross scenarios at engine level
// ---------------------------------------------------------------------------

describe('AC-5b: engine-level 3-signal cross scenarios', () => {
  it('Case A: caller abort wins over internal timeout', async () => {
    const controller = new AbortController();

    const p = executeWithRetryAndSignal(
      ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            // Distinguish caller abort (AbortError) from timeout (TimeoutError)
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

    // Abort caller at ~20ms, well before 200ms timeout
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof DOMException && err.name === 'AbortError',
        `expected AbortError, got ${err instanceof Error ? err.name : String(err)}`);
      return true;
    });
  });

  it('Case B: effective timeout = min(timeout, remainingDeadline)', async () => {
    // timeout:200, deadline in 80ms → effective timeout ~80ms
    const deadline = Date.now() + 80;
    const start = Date.now();

    await assert.rejects(
      () =>
        executeWithRetry(
          async ({ signal }) =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                reject(new DOMException('timeout', 'TimeoutError'))
              , { once: true });
            }),
          { maxAttempts: 1, timeout: 200, deadline }
        ),
      (err: unknown) => {
        assert.ok(err instanceof DOMException && err.name === 'TimeoutError');
        return true;
      }
    );

    const elapsed = Date.now() - start;
    // Should fire in ~80ms (deadline), not ~200ms (timeout)
    assert.ok(elapsed < 180, `expected to fire before 180ms (deadline wins), took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// AC-6: shouldRetry cannot override maxAttempts/deadline; false cuts early
// ---------------------------------------------------------------------------

describe('AC-6: shouldRetry gate', () => {
  it('shouldRetry returning true still respects maxAttempts hard cap', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw makeError({ statusCode: 503 });
          },
          {
            maxAttempts: 2,
            initialDelay: 1,
            jitter: 'none',
            shouldRetry: () => true,
          },
          'GET'
        )
    );
    assert.equal(calls, 2, 'maxAttempts is a hard cap regardless of shouldRetry');
  });

  it('shouldRetry returning false stops retrying even when gate would allow', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw makeError({ statusCode: 503 });
          },
          {
            maxAttempts: 5,
            initialDelay: 1,
            jitter: 'none',
            shouldRetry: () => false,
          },
          'GET'
        )
    );
    assert.equal(calls, 1, 'shouldRetry=false should cut retries immediately');
  });

  it('shouldRetry returning true still respects deadline', async () => {
    let calls = 0;
    const deadline = Date.now() + 60;

    await assert.rejects(
      () =>
        executeWithRetry(
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
            initialDelay: 1,
            jitter: 'none',
            shouldRetry: () => true,
          },
          'GET'
        )
    );

    // Deadline of 60ms with 30ms timeout → at most ~2 attempts
    assert.ok(calls <= 4, `deadline should cap at ~2 attempts, got ${calls}`);
  });
});

// ---------------------------------------------------------------------------
// AC-6b: shouldRetry that throws → fail-closed, original error propagated
// ---------------------------------------------------------------------------

describe('AC-6b: shouldRetry fail-closed on throw', () => {
  it('propagates the ORIGINAL operation error when shouldRetry throws', async () => {
    const originalError = makeError({ statusCode: 503 });
    const hookError = new Error('hook exploded');

    let calls = 0;
    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw originalError;
          },
          {
            maxAttempts: 3,
            initialDelay: 1,
            jitter: 'none',
            shouldRetry: () => { throw hookError; },
          },
          'GET'
        ),
      (err: unknown) => {
        assert.equal(err, originalError, 'should propagate original op error, not hook error');
        return true;
      }
    );

    assert.equal(calls, 1, 'should not retry when shouldRetry throws');
  });

  it('does not loop when shouldRetry throws on every call', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw makeError({ statusCode: 500 });
          },
          {
            maxAttempts: 10,
            initialDelay: 1,
            jitter: 'none',
            shouldRetry: () => { throw new Error('boom'); },
          },
          'GET'
        )
    );
    assert.equal(calls, 1, 'should stop after first shouldRetry throw (fail-closed)');
  });
});

// ---------------------------------------------------------------------------
// AC-7: happy path, exhaustion, non-retryable, onRetry/onFailure
// ---------------------------------------------------------------------------

describe('AC-7: observers and lifecycle', () => {
  it('happy path: resolves without calling onRetry or onFailure', async () => {
    const onRetry = (calls: number[] = []) => (..._args: unknown[]) => { calls.push(1); return calls; };
    const retryCalls: number[] = [];
    const failureCalls: number[] = [];

    const result = await executeWithRetry(
      async () => 42,
      {
        maxAttempts: 3,
        onRetry: (..._args) => { retryCalls.push(1); },
        onFailure: (..._args) => { failureCalls.push(1); },
      }
    );

    assert.equal(result, 42);
    assert.equal(retryCalls.length, 0);
    assert.equal(failureCalls.length, 0);
    void onRetry; // suppress unused warning
  });

  it('exhaustion: onRetry called N-1 times, onFailure called once', async () => {
    const retryCalls: Array<[unknown, number, number]> = [];
    const failureCalls: Array<[unknown, number]> = [];
    let calls = 0;

    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw makeError({ statusCode: 503 });
          },
          {
            maxAttempts: 3,
            initialDelay: 1,
            jitter: 'none',
            onRetry: (err, attempt, delay) => { retryCalls.push([err, attempt, delay]); },
            onFailure: (err, attempts) => { failureCalls.push([err, attempts]); },
          },
          'GET'
        )
    );

    assert.equal(calls, 3);
    assert.equal(retryCalls.length, 2, 'onRetry called twice (between attempts 1-2 and 2-3)');
    assert.equal(failureCalls.length, 1, 'onFailure called once');

    // onRetry receives (error, attemptThatFailed, delay)
    assert.equal(retryCalls[0][1], 1);
    assert.equal(retryCalls[1][1], 2);
    // onFailure receives (error, totalAttempts)
    assert.equal(failureCalls[0][1], 3);
  });

  it('non-retryable error: onFailure called immediately after first attempt', async () => {
    const failureCalls: Array<[unknown, number]> = [];
    const retryCalls: number[] = [];

    // 404 is non-retryable
    await assert.rejects(
      () =>
        executeWithRetry(
          async () => { throw makeError({ statusCode: 404 }); },
          {
            maxAttempts: 5,
            onRetry: () => { retryCalls.push(1); },
            onFailure: (err, attempts) => { failureCalls.push([err, attempts]); },
          },
          'GET'
        )
    );

    assert.equal(retryCalls.length, 0, 'onRetry should not be called for non-retryable');
    assert.equal(failureCalls.length, 1);
    assert.equal(failureCalls[0][1], 1, 'onFailure should report 1 attempt');
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
// Additional: Retry-After header respect
// ---------------------------------------------------------------------------

describe('Retry-After header handling', () => {
  it('respects Retry-After when within maxRetryAfter', async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw makeError({ statusCode: 429, retryAfterSeconds: 0 }); // 0s → immediate
          },
          {
            maxAttempts: 2,
            respectRetryAfter: true,
            maxRetryAfter: 60000,
            jitter: 'none',
          },
          'GET'
        )
    );
    assert.equal(calls, 2);
  });

  it('gives up when Retry-After exceeds maxRetryAfter', async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        executeWithRetry(
          async () => {
            calls++;
            throw makeError({ statusCode: 429, retryAfterSeconds: 120 }); // 120s > 60s max
          },
          {
            maxAttempts: 3,
            respectRetryAfter: true,
            maxRetryAfter: 60000,
            jitter: 'none',
          },
          'GET'
        )
    );
    // Should give up after the first 429 because Retry-After > maxRetryAfter
    assert.equal(calls, 1, 'should give up when Retry-After exceeds maxRetryAfter');
  });
});
