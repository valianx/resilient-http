/**
 * Regression tests for the per-request timeout signal bug (fix: 2.0.1).
 *
 * BUG: createResilientHttp({ fetch }).get(url, { timeout: 300 }) with a fetch
 * that takes 2000ms resolved OK instead of aborting at 300ms. The AbortSignal
 * built by buildAttemptSignal was never reaching the real fetch because
 * resolveRequestConfig did not inject the top-level `timeout`/`deadline`
 * fields into the retry options consumed by the engine.
 *
 * These tests exercise the REAL abort path: the mock fetch listens on
 * init.signal and rejects with AbortError/TimeoutError when aborted, so
 * fake timers are NOT sufficient — the signal must actually be wired through.
 *
 * Coverage:
 *   BUG-1: per-request timeout → fetch aborted → ResilientHttpError{kind:'network', classification:'timeout'}
 *   BUG-2: instance-level timeout → same abort behavior
 *   BUG-3: init.signal passed to fetch is never undefined when timeout is set
 *   BUG-4: timeout inside retry sub-object still works (no regression)
 *   BUG-5: control — no timeout, slow fetch resolves normally
 *   BUG-6: per-request timeout overrides instance timeout (lower wins within retry merge)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createResilientHttp } from '../src/client/create';
import { isResilientHttpError } from '../src/errors/resilient-http-error';
import { enableFakeTimers, tick, flush, resetTimers } from './test-utils.ts';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a mock fetch that resolves after `delayMs` but respects its
 * init.signal: if the signal aborts before the delay fires, the fetch
 * rejects with a TimeoutError (same as AbortSignal.timeout()) or AbortError.
 *
 * This is the critical difference from the existing makeFetch helpers: this
 * one actually LISTENS on the signal, so a wired-through AbortSignal can
 * interrupt it.
 */
function makeSlowFetch(delayMs: number) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const mockFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });

    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }, delayMs);

      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          // Abort reason may be a TimeoutError or DOMException with name AbortError.
          const reason = signal.reason as Error | undefined;
          reject(reason ?? new DOMException('signal aborted', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const reason = signal.reason as Error | undefined;
            reject(reason ?? new DOMException('signal aborted', 'AbortError'));
          },
          { once: true }
        );
      }
    });
  };

  return { mockFetch: mockFetch as typeof globalThis.fetch, calls };
}

// ============================================================================
// BUG-1: per-request timeout aborts fetch
// ============================================================================

describe('BUG-1: per-request timeout aborts fetch before it resolves', () => {
  it('fetch resolving at 500ms with timeout:100ms → ResilientHttpError{kind:network}', async (t) => {
    enableFakeTimers(t);

    const { mockFetch, calls } = makeSlowFetch(500);

    const client = createResilientHttp({ fetch: mockFetch });

    let caughtError: unknown;
    const p = client
      .get('https://api.test/slow', { timeout: 100 })
      .catch((e: unknown) => {
        caughtError = e;
      });

    // Let event loop advance so the fetch starts (microtasks settle).
    await flush();
    // Advance fake clock past the 100ms timeout.
    await tick(100);
    await flush();
    await p;

    assert.ok(
      isResilientHttpError(caughtError),
      `Expected ResilientHttpError, got: ${String(caughtError)}`
    );
    const err = caughtError as { kind: string; classification: string };
    assert.strictEqual(err.kind, 'network',
      `Expected kind:'network', got kind:'${err.kind}'`);
    assert.strictEqual(err.classification, 'timeout',
      `Expected classification:'timeout', got:'${err.classification}'`);

    // Fetch must have been called exactly once (no retry with default maxAttempts:1).
    assert.strictEqual(calls.length, 1, 'fetch must have been called once');

    // The signal passed to fetch must not be undefined.
    assert.ok(
      calls[0].init.signal !== undefined,
      'init.signal must be present when timeout is set'
    );

    resetTimers();
  });
});

// ============================================================================
// BUG-2: instance-level timeout aborts fetch
// ============================================================================

describe('BUG-2: instance-level timeout aborts fetch', () => {
  it('instance timeout:100ms, fetch resolving at 500ms → ResilientHttpError{kind:network}', async (t) => {
    enableFakeTimers(t);

    const { mockFetch, calls } = makeSlowFetch(500);

    // timeout at instance level (not per-request, not inside retry:{})
    const client = createResilientHttp({ fetch: mockFetch, timeout: 100 });

    let caughtError: unknown;
    const p = client
      .get('https://api.test/slow')
      .catch((e: unknown) => {
        caughtError = e;
      });

    await flush();
    await tick(100);
    await flush();
    await p;

    assert.ok(
      isResilientHttpError(caughtError),
      `Expected ResilientHttpError, got: ${String(caughtError)}`
    );
    const err = caughtError as { kind: string; classification: string };
    assert.strictEqual(err.kind, 'network');
    assert.strictEqual(err.classification, 'timeout');

    assert.ok(
      calls[0].init.signal !== undefined,
      'init.signal must be present when instance timeout is set'
    );

    resetTimers();
  });
});

// ============================================================================
// BUG-3: init.signal is present when timeout is configured
// ============================================================================

describe('BUG-3: init.signal is present on fetch call when timeout is configured', () => {
  it('timeout configured → fetch receives non-undefined signal', async (t) => {
    enableFakeTimers(t);

    // Use a fetch that resolves instantly to not actually trigger the timeout.
    const calls: Array<RequestInit> = [];
    const instantFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push(init ?? {});
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = createResilientHttp({
      fetch: instantFetch as typeof globalThis.fetch,
      timeout: 5000,
    });

    await client.get('https://api.test/fast');

    assert.strictEqual(calls.length, 1);
    assert.ok(
      calls[0].signal !== undefined,
      'init.signal must NOT be undefined when instance timeout is set'
    );
    assert.ok(
      calls[0].signal instanceof AbortSignal,
      'init.signal must be an AbortSignal instance'
    );

    resetTimers();
  });

  it('per-request timeout → fetch receives non-undefined signal', async () => {
    const calls: Array<RequestInit> = [];
    const instantFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push(init ?? {});
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = createResilientHttp({ fetch: instantFetch as typeof globalThis.fetch });

    await client.get('https://api.test/fast', { timeout: 5000 });

    assert.ok(
      calls[0].signal !== undefined,
      'init.signal must NOT be undefined when per-request timeout is set'
    );
    assert.ok(
      calls[0].signal instanceof AbortSignal,
      'init.signal must be an AbortSignal instance'
    );
  });
});

// ============================================================================
// BUG-4: timeout inside retry:{} sub-object still works (no regression)
// ============================================================================

describe('BUG-4: timeout inside retry sub-object still wires through (no regression)', () => {
  it('retry:{timeout:100} with slow fetch → aborts', async (t) => {
    enableFakeTimers(t);

    const { mockFetch, calls } = makeSlowFetch(500);

    const client = createResilientHttp({
      fetch: mockFetch,
      retry: { timeout: 100 },
    });

    let caughtError: unknown;
    const p = client
      .get('https://api.test/slow')
      .catch((e: unknown) => {
        caughtError = e;
      });

    await flush();
    await tick(100);
    await flush();
    await p;

    assert.ok(isResilientHttpError(caughtError));
    const err = caughtError as { kind: string; classification: string };
    assert.strictEqual(err.kind, 'network');
    assert.strictEqual(err.classification, 'timeout');
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].init.signal !== undefined);

    resetTimers();
  });
});

// ============================================================================
// BUG-5: control — no timeout, slow fetch resolves normally
// ============================================================================

describe('BUG-5: control — no timeout, slow fetch resolves normally', () => {
  it('without timeout, a slow fetch resolves successfully', async (t) => {
    enableFakeTimers(t);

    // Fetch that takes 200ms but respects its signal.
    const { mockFetch } = makeSlowFetch(200);

    const client = createResilientHttp({ fetch: mockFetch });

    let result: unknown;
    const p = client
      .get('https://api.test/slow-but-ok')
      .then((r) => {
        result = r;
      });

    await flush();
    // Advance past the 200ms delay — no timeout configured, should resolve.
    await tick(200);
    await flush();
    await p;

    assert.ok(result !== undefined, 'Should have resolved with a response');
    const r = result as { status: number };
    assert.strictEqual(r.status, 200, 'Should return 200 OK');

    resetTimers();
  });
});

// ============================================================================
// BUG-6: per-request timeout overrides instance timeout (lower wins)
// ============================================================================

describe('BUG-6: per-request timeout: timeout used is min(instance, per-request)', () => {
  it('instance:5000ms, per-request:100ms → aborts at 100ms before 500ms fetch resolves', async (t) => {
    enableFakeTimers(t);

    const { mockFetch } = makeSlowFetch(500);

    const client = createResilientHttp({
      fetch: mockFetch,
      timeout: 5000, // instance: 5s — should NOT be the one that fires
    });

    let caughtError: unknown;
    const p = client
      .get('https://api.test/slow', { timeout: 100 }) // per-request: 100ms — this one fires
      .catch((e: unknown) => {
        caughtError = e;
      });

    await flush();
    // At 100ms the per-request timeout fires; the 5s instance timeout has not.
    await tick(100);
    await flush();
    await p;

    assert.ok(isResilientHttpError(caughtError));
    const err = caughtError as { kind: string; classification: string };
    assert.strictEqual(err.kind, 'network');
    assert.strictEqual(err.classification, 'timeout');

    resetTimers();
  });
});

// ============================================================================
// Issue #37 — AC-5/AC-6 (integration layer): past absolute deadline through
// createResilientHttp surfaces classification:'timeout' with a contentful
// message (not undefined, not a contentless Network error).
// ============================================================================

describe('#37 Bug A (integration): past absolute deadline → ResilientHttpError{classification:timeout}', () => {
  it('executeWithRetry path: fetch never called, error has classification:timeout and contentful message', async () => {
    const fetchCalls: unknown[] = [];
    const mockFetch = async (): Promise<Response> => {
      fetchCalls.push(true);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    // No caller signal → routes through executeWithRetry.
    const client = createResilientHttp({ fetch: mockFetch as typeof globalThis.fetch });
    const error = await client
      .get('https://api.test/items', { deadline: Date.now() - 1 })
      .catch((e: unknown) => e);

    assert.strictEqual(fetchCalls.length, 0, 'fetch must never be called when deadline is past');
    assert.ok(isResilientHttpError(error), 'must be a ResilientHttpError');

    const e = error as { kind: string; classification: string; message: string; cause?: unknown };
    assert.strictEqual(e.kind, 'network',
      `expected kind:'network', got kind:'${e.kind}'`);
    assert.strictEqual(e.classification, 'timeout',
      `expected classification:'timeout', got:'${e.classification}'`);
    assert.ok(
      typeof e.message === 'string' && e.message.length > 0,
      `message must be a non-empty string, got: ${JSON.stringify(e.message)}`
    );
    assert.ok(
      !e.message.startsWith('Network error\n') || e.message.includes('TIMEOUT_ERR'),
      'message must be contentful — not the bare contentless "Network error"'
    );
    // Pin that the DOMException's message travels to error.cause.message so a mutant
    // that omits the DOMException constructor string would fail here.
    const cause = e.cause as { message?: string } | undefined;
    assert.ok(
      cause !== undefined && typeof cause.message === 'string' && cause.message.length > 0,
      `error.cause.message must be a non-empty string, got: ${JSON.stringify(cause?.message)}`
    );
    assert.strictEqual(
      cause?.message,
      'deadline exceeded before any request attempt',
      'cause.message must be the exact DOMException string from the ?? fallback'
    );
  });

  it('executeWithRetryAndSignal path: fetch never called, error has classification:timeout', async () => {
    const fetchCalls: unknown[] = [];
    const mockFetch = async (): Promise<Response> => {
      fetchCalls.push(true);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    // Caller signal present → routes through executeWithRetryAndSignal.
    const controller = new AbortController();
    const client = createResilientHttp({ fetch: mockFetch as typeof globalThis.fetch });
    const error = await client
      .get('https://api.test/items', { deadline: Date.now() - 1, signal: controller.signal })
      .catch((e: unknown) => e);

    assert.strictEqual(fetchCalls.length, 0, 'fetch must never be called when deadline is past');
    assert.ok(isResilientHttpError(error), 'must be a ResilientHttpError');

    const e = error as { kind: string; classification: string; message: string; cause?: unknown };
    assert.strictEqual(e.kind, 'network',
      `expected kind:'network', got kind:'${e.kind}'`);
    assert.strictEqual(e.classification, 'timeout',
      `expected classification:'timeout', got:'${e.classification}'`);
    assert.ok(
      typeof e.message === 'string' && e.message.length > 0,
      `message must be a non-empty string, got: ${JSON.stringify(e.message)}`
    );
    // Pin the DOMException's exact message on the signal path as well.
    const cause = e.cause as { message?: string } | undefined;
    assert.ok(
      cause !== undefined && typeof cause.message === 'string' && cause.message.length > 0,
      `error.cause.message must be a non-empty string (signal path), got: ${JSON.stringify(cause?.message)}`
    );
    assert.strictEqual(
      cause?.message,
      'deadline exceeded before any request attempt',
      'cause.message must be the exact DOMException string from the ?? fallback (signal path)'
    );
  });
});

// ============================================================================
// Issue #37 — Bug A counter-case (integration): lastError IS set → REAL error
// propagates, NOT the ?? fallback DOMException.
//
// Mutation-kill target: a mutant that replaces `throw lastError ?? new DOMException(...)`
// with `throw new DOMException(...)` would produce kind:'network', classification:'timeout'
// instead of kind:'response', statusCode:503. This test is the decisive kill.
// ============================================================================

describe('#37 Bug A counter-case (integration): real attempt ran → real error propagates, not ?? fallback', () => {
  it('executeWithRetry path: 503 attempt succeeds before deadline expires — real ResilientHttpError{kind:response,503}', async () => {
    // Compute deadline before any timer manipulation — real Date.now() + 5ms.
    // The first attempt fires synchronously, fails with 503, then backoff sleep
    // (100ms) would overshoot the deadline (+5ms) → delayExceedsDeadline fires →
    // break with lastError already set → `throw lastError ?? DOMException` must
    // throw the 503 error. No includeDate needed: Date mock would break the guardrail.
    const nearFutureDeadline = Date.now() + 5;

    const fetchCalls503: string[] = [];
    const client503 = createResilientHttp({
      fetch: (async (input: RequestInfo | URL): Promise<Response> => {
        fetchCalls503.push(typeof input === 'string' ? input : input.toString());
        return new Response('{"error":"service unavailable"}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
      retry: {
        maxAttempts: 5,
        initialDelay: 100,
        jitter: 'none',
        backoff: 'constant',
        deadline: nearFutureDeadline,
      },
    });

    const error = await client503.get('https://api.test/items').catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error), 'must be a ResilientHttpError');
    const e = error as { kind: string; statusCode?: number; classification: string };
    // Must be a response error (503), NOT a timeout from the ?? fallback.
    assert.strictEqual(e.kind, 'response',
      `expected kind:'response' (real 503 error), got kind:'${e.kind}' — ?? fallback must NOT be thrown when lastError is set`);
    assert.strictEqual(e.statusCode, 503,
      `expected statusCode:503, got:${e.statusCode}`);
    assert.notStrictEqual(e.classification, 'timeout',
      'classification must NOT be timeout when the real attempt produced a 503 response error');
  });

  it('executeWithRetryAndSignal path: 503 attempt before deadline expires — real ResilientHttpError{kind:response,503}', async () => {
    // Same as above but with a caller signal → routes through executeWithRetryAndSignal.
    const nearFutureDeadline = Date.now() + 5;
    const controller = new AbortController();
    const calls503: string[] = [];

    const client503 = createResilientHttp({
      fetch: (async (input: RequestInfo | URL): Promise<Response> => {
        calls503.push(typeof input === 'string' ? input : input.toString());
        return new Response('{"error":"service unavailable"}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
      retry: {
        maxAttempts: 5,
        initialDelay: 100,
        jitter: 'none',
        backoff: 'constant',
        deadline: nearFutureDeadline,
      },
    });

    const error = await client503
      .get('https://api.test/items', { signal: controller.signal })
      .catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error), 'must be a ResilientHttpError');
    const e = error as { kind: string; statusCode?: number; classification: string };
    assert.strictEqual(e.kind, 'response',
      `expected kind:'response' (real 503), got:'${e.kind}' (signal path) — ?? fallback must not fire when lastError is set`);
    assert.strictEqual(e.statusCode, 503,
      `expected statusCode:503, got:${e.statusCode} (signal path)`);
    assert.notStrictEqual(e.classification, 'timeout',
      'classification must NOT be timeout when the real attempt produced a 503 (signal path)');
  });
});
