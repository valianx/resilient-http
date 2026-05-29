/**
 * Tests for Phase 5: hook system + request-builder + idempotency-key + body replay.
 *
 * AC-1:  array of onRequest hooks run in order; each can mutate ctx.request.
 * AC-2:  onRequest that throws → ResilientHttpError { kind:'setup' }, no fetch.
 * AC-3:  onRequest re-runs on every attempt; ctx.attempt increments; ctx.error carries prev error.
 * AC-4:  ctx.meta mutated on attempt 1 persists to attempt 2 and to final error.
 * AC-5:  idempotencyKey evaluated once — all retries carry identical header value.
 * AC-5b: idempotencyKey with CRLF in value → ResilientHttpError { kind:'setup' }.
 * AC-5c: idempotencyKey provider that throws → ResilientHttpError { kind:'setup' }.
 * AC-6:  JSON-object body with retry → replayed identically on retry.
 * AC-7:  ReadableStream body + retryActive → ResilientHttpError { kind:'setup' }.
 * AC-8:  onRetry/onFailure that throw → captured, operation continues normally.
 * AC-9:  onResponse that throws → ResilientHttpError { kind:'setup' }.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RequestBuilder } from '../src/client/request-builder';
import { runRetryObservers, runFailureObservers, runRequestHooks, runResponseHooks } from '../src/hooks/run';
import { isResilientHttpError } from '../src/errors/resilient-http-error';
import type { HookContext } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal HookContext for direct hook runner tests. */
function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    request: {
      url: 'https://api.test/payments',
      method: 'POST',
      headers: {},
    },
    attempt: 1,
    attemptId: 'test-attempt-id',
    requestId: 'test-request-id',
    elapsed: 0,
    meta: {},
    ...overrides,
  };
}

/** Extract the Idempotency-Key header from an attempt for inspection. */
async function captureIdempotencyHeader(
  builder: RequestBuilder,
  attempt: number,
  prevError?: unknown
): Promise<string | null> {
  const { headers } = await builder.buildAttempt(attempt, prevError);
  return headers.get('Idempotency-Key');
}

// ============================================================================
// AC-1 — array of onRequest hooks run in order; each can mutate ctx.request
// ============================================================================

describe('Phase 5 hooks — AC-1: onRequest array runs in order', () => {
  it('runs all hooks in array order and accumulates mutations', async () => {
    const log: string[] = [];

    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'GET',
      hooks: {
        onRequest: [
          (ctx) => { log.push('first'); ctx.request.headers['X-First'] = '1'; },
          (ctx) => { log.push('second'); ctx.request.headers['X-Second'] = '2'; },
          (ctx) => { log.push('third'); ctx.request.headers['X-Third'] = '3'; },
        ],
      },
    });

    const { ctx, headers } = await builder.buildAttempt(1);

    assert.deepStrictEqual(log, ['first', 'second', 'third']);
    assert.strictEqual(headers.get('X-First'), '1');
    assert.strictEqual(headers.get('X-Second'), '2');
    assert.strictEqual(headers.get('X-Third'), '3');
    assert.strictEqual(ctx.attempt, 1);
  });

  it('single hook (not array) also works', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'GET',
      hooks: {
        onRequest: (ctx) => { ctx.request.headers['X-Single'] = 'yes'; },
      },
    });

    const { headers } = await builder.buildAttempt(1);
    assert.strictEqual(headers.get('X-Single'), 'yes');
  });

  it('later hook sees mutations from earlier hooks', async () => {
    let secondSawHeader = '';

    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'GET',
      hooks: {
        onRequest: [
          (ctx) => { ctx.request.headers['X-Token'] = 'token-from-first'; },
          (ctx) => { secondSawHeader = ctx.request.headers['X-Token'] ?? ''; },
        ],
      },
    });

    await builder.buildAttempt(1);
    assert.strictEqual(secondSawHeader, 'token-from-first');
  });
});

// ============================================================================
// AC-2 — onRequest that throws → ResilientHttpError { kind:'setup' }
// ============================================================================

describe('Phase 5 hooks — AC-2: onRequest throw → setup error', () => {
  it('throws ResilientHttpError with kind:setup when hook throws', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'POST',
      hooks: {
        onRequest: () => { throw new Error('auth token expired'); },
      },
    });

    await assert.rejects(
      () => builder.buildAttempt(1),
      (err: unknown) => {
        assert.ok(isResilientHttpError(err));
        assert.strictEqual(err.kind, 'setup');
        assert.ok(err.message.includes('auth token expired'));
        return true;
      }
    );
  });

  it('stops at the throwing hook — later hooks do not run', async () => {
    const log: string[] = [];

    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'POST',
      hooks: {
        onRequest: [
          () => { log.push('first'); throw new Error('boom'); },
          () => { log.push('second'); },
        ],
      },
    });

    await assert.rejects(() => builder.buildAttempt(1));
    assert.deepStrictEqual(log, ['first']);
  });

  it('TypeError thrown by hook is wrapped in setup error with correct url/method', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'POST',
      hooks: {
        onRequest: () => { throw new TypeError('network config invalid'); },
      },
    });

    const err = await builder.buildAttempt(1).catch((e: unknown) => e);
    assert.ok(isResilientHttpError(err));
    assert.strictEqual((err as { kind: string }).kind, 'setup');
    assert.strictEqual((err as { url: string }).url, 'https://api.test/items');
    assert.strictEqual((err as { method: string }).method, 'POST');
  });
});

// ============================================================================
// AC-3 — onRequest re-runs per attempt; ctx.attempt grows; ctx.error carries prev
// ============================================================================

describe('Phase 5 hooks — AC-3: onRequest re-runs per attempt', () => {
  it('ctx.attempt is 1 on first call and 2 on second call', async () => {
    const attempts: number[] = [];

    const builder = RequestBuilder.create({
      url: 'https://api.test/pay',
      method: 'POST',
      hooks: {
        onRequest: (ctx) => { attempts.push(ctx.attempt); },
      },
    });

    await builder.buildAttempt(1);
    await builder.buildAttempt(2);

    assert.deepStrictEqual(attempts, [1, 2]);
  });

  it('ctx.error on second attempt carries the error from attempt 1', async () => {
    const prevErrors: unknown[] = [];
    const fakeError = new Error('503 from attempt 1');

    const builder = RequestBuilder.create({
      url: 'https://api.test/pay',
      method: 'POST',
      hooks: {
        onRequest: (ctx) => { prevErrors.push(ctx.error); },
      },
    });

    await builder.buildAttempt(1, undefined);
    await builder.buildAttempt(2, fakeError);

    assert.strictEqual(prevErrors[0], undefined);
    assert.strictEqual(prevErrors[1], fakeError);
  });

  it('ctx.error is undefined on the first attempt', async () => {
    let capturedError: unknown = 'sentinel';

    const builder = RequestBuilder.create({
      url: 'https://api.test/pay',
      method: 'POST',
      hooks: {
        onRequest: (ctx) => { capturedError = ctx.error; },
      },
    });

    await builder.buildAttempt(1);
    assert.strictEqual(capturedError, undefined);
  });
});

// ============================================================================
// AC-4 — ctx.meta persists between attempts and travels to final error
// ============================================================================

describe('Phase 5 hooks — AC-4: ctx.meta persists across attempts', () => {
  it('meta mutation in attempt 1 is visible in attempt 2', async () => {
    const metas: Record<string, unknown>[] = [];

    const builder = RequestBuilder.create({
      url: 'https://api.test/pay',
      method: 'POST',
      hooks: {
        onRequest: (ctx) => {
          if (ctx.attempt === 1) ctx.meta['refreshed'] = true;
          metas.push({ ...ctx.meta });
        },
      },
    });

    await builder.buildAttempt(1);
    await builder.buildAttempt(2);

    // Attempt 1 set refreshed=true; attempt 2 should see it.
    assert.strictEqual(metas[0]?.['refreshed'], true);
    assert.strictEqual(metas[1]?.['refreshed'], true);
  });

  it('builder.meta is the same object referenced by ctx.meta', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/pay',
      method: 'POST',
      hooks: {
        onRequest: (ctx) => { ctx.meta['key'] = 'value'; },
      },
    });

    await builder.buildAttempt(1);

    // builder.meta is the authoritative meta bag.
    assert.strictEqual(builder.meta['key'], 'value');
  });

  it('builder.meta travels to the ResilientHttpError when passed as meta field', async () => {
    // AC-4: "travels to final error" — the engine is responsible for passing
    // builder.meta into the ResilientHttpError constructor.  Here we verify the
    // contract from the RequestBuilder side: builder.meta is the object that
    // MUST be forwarded.  We simulate what the engine does by constructing the
    // error manually with builder.meta and asserting it arrives on err.meta.
    const { ResilientHttpError } = await import('../src/errors/resilient-http-error.js');

    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      hooks: {
        onRequest: (ctx) => {
          ctx.meta['chargeAttempt'] = ctx.attempt;
          ctx.meta['correlationId'] = 'corr-xyz';
        },
      },
    });

    await builder.buildAttempt(1);
    await builder.buildAttempt(2);

    // The engine would pass builder.meta here; we assert that the meta survives.
    const err = new ResilientHttpError({
      kind: 'setup',
      message: 'all retries exhausted',
      url: 'https://api.test/payments',
      method: 'POST',
      attempts: 2,
      meta: builder.meta,
    });

    assert.ok(err.meta !== undefined, 'meta must be present on the error');
    assert.strictEqual(err.meta?.['chargeAttempt'], 2,
      'meta must carry the last attempt number written by the hook');
    assert.strictEqual(err.meta?.['correlationId'], 'corr-xyz',
      'meta must preserve all keys written during the retry lifecycle');
  });
});

// ============================================================================
// AC-5 — idempotencyKey evaluated once; identical header on all retries
// ============================================================================

describe('Phase 5 hooks — AC-5: idempotency-key frozen across retries (PAYMENT SAFETY)', () => {
  it('() => randomUUID() is called once; all three attempts carry the same key', async () => {
    let callCount = 0;
    const fakeUUIDs = ['uuid-1111', 'uuid-2222', 'uuid-3333'];

    // Simulate a function that would return different values on each call.
    const provider = () => {
      const id = fakeUUIDs[callCount] ?? 'uuid-fallback';
      callCount++;
      return id;
    };

    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      idempotencyKey: provider,
      retryActive: true,
    });

    // Provider must be called exactly once regardless of how many attempts we build.
    assert.strictEqual(callCount, 1, 'provider called once during create()');

    const key1 = await captureIdempotencyHeader(builder, 1);
    const key2 = await captureIdempotencyHeader(builder, 2);
    const key3 = await captureIdempotencyHeader(builder, 3);

    // All three must be the same frozen value.
    assert.strictEqual(key1, key2, 'key must be identical on attempt 1 and 2');
    assert.strictEqual(key2, key3, 'key must be identical on attempt 2 and 3');
    assert.strictEqual(key1, 'uuid-1111', 'key is the first (and only) resolved value');

    // Provider was never called again after the initial resolution.
    assert.strictEqual(callCount, 1, 'provider still called only once after 3 buildAttempt calls');
  });

  it('static string key is the same on all attempts', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      idempotencyKey: 'order-abc-123',
      retryActive: true,
    });

    const key1 = await captureIdempotencyHeader(builder, 1);
    const key2 = await captureIdempotencyHeader(builder, 2);

    assert.strictEqual(key1, 'order-abc-123');
    assert.strictEqual(key2, 'order-abc-123');
  });

  it('idempotencyKey:true generates a stable UUID across attempts', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      idempotencyKey: true,
      retryActive: true,
    });

    const key1 = await captureIdempotencyHeader(builder, 1);
    const key2 = await captureIdempotencyHeader(builder, 2);

    assert.ok(typeof key1 === 'string' && key1.length > 0);
    assert.strictEqual(key1, key2, 'same UUID across attempts');
  });

  it('key is attached before onRequest runs so hook can read it', async () => {
    let headerSeenByHook: string | null = null;

    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      idempotencyKey: 'stable-key',
      hooks: {
        onRequest: (ctx) => { headerSeenByHook = ctx.request.headers['Idempotency-Key'] ?? null; },
      },
    });

    await builder.buildAttempt(1);
    assert.strictEqual(headerSeenByHook, 'stable-key');
  });

  it('onRequest hook can override the idempotency-key for a specific attempt', async () => {
    const capturedKeys: (string | null)[] = [];

    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      idempotencyKey: 'frozen-key',
      hooks: {
        // Simulate a hook that overrides the key only on attempt 2.
        onRequest: (ctx) => {
          if (ctx.attempt === 2) {
            ctx.request.headers['Idempotency-Key'] = 'hook-override';
          }
        },
      },
    });

    const { headers: h1 } = await builder.buildAttempt(1);
    capturedKeys.push(h1.get('Idempotency-Key'));

    const { headers: h2 } = await builder.buildAttempt(2);
    capturedKeys.push(h2.get('Idempotency-Key'));

    assert.strictEqual(capturedKeys[0], 'frozen-key');
    assert.strictEqual(capturedKeys[1], 'hook-override');
  });
});

// ============================================================================
// AC-5b — CRLF in idempotency-key value → setup error (CRLF injection guard)
// ============================================================================

describe('Phase 5 hooks — AC-5b: CRLF in idempotency-key rejected (injection guard)', () => {
  it('CRLF in idempotencyKey string → setup error, no request with injected header', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      // Value contains CRLF — classic header injection payload.
      idempotencyKey: 'abc\r\nX-Injected: 1',
    });

    // The CRLF is rejected when the native Headers API is used in buildAttempt.
    const result = await builder.buildAttempt(1).catch((e: unknown) => e);

    assert.ok(isResilientHttpError(result), 'must throw ResilientHttpError');
    assert.strictEqual((result as { kind: string }).kind, 'setup');
    // The injected header must NOT be present.
    // (If we reached here without throwing, check that the header was not set.)
  });

  it('CRLF in a plain header value is also rejected', async () => {
    const ctx = makeCtx({
      request: {
        url: 'https://api.test/pay',
        method: 'POST',
        headers: { 'X-Bad': 'value\r\nX-Injected: bad' },
      },
    });

    // runRequestHooks itself doesn't validate; validation happens in buildAttempt
    // when the Headers object is constructed. Test via builder.
    const builder = RequestBuilder.create({
      url: 'https://api.test/pay',
      method: 'POST',
      headers: { 'X-Bad': 'value\r\nX-Injected: bad' },
    });

    const result = await builder.buildAttempt(1).catch((e: unknown) => e);
    assert.ok(isResilientHttpError(result));
    assert.strictEqual((result as { kind: string }).kind, 'setup');

    // Suppress unused variable warning — ctx is used to document the intent.
    void ctx;
  });
});

// ============================================================================
// AC-5c — idempotencyKey provider throws → setup error
// ============================================================================

describe('Phase 5 hooks — AC-5c: provider function throws → setup error', () => {
  it('provider that throws → ResilientHttpError { kind:setup } at create time', () => {
    const thrower = (): string => { throw new Error('boom'); };

    assert.throws(
      () => RequestBuilder.create({
        url: 'https://api.test/payments',
        method: 'POST',
        idempotencyKey: thrower,
      }),
      (err: unknown) => {
        assert.ok(isResilientHttpError(err));
        assert.strictEqual((err as { kind: string }).kind, 'setup');
        assert.ok((err as { message: string }).message.includes('boom'));
        return true;
      }
    );
  });
});

// ============================================================================
// AC-6 — JSON body replayed identically on retry
// ============================================================================

describe('Phase 5 hooks — AC-6: body replay on retry', () => {
  it('JSON-object body is serialised once and replayed identically on each attempt', async () => {
    const payload = { orderId: 'ord-001', amount: 99.99, currency: 'USD' };
    const serialised = JSON.stringify(payload);

    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      body: payload,
      retryActive: true,
    });

    const { body: body1 } = await builder.buildAttempt(1);
    const { body: body2 } = await builder.buildAttempt(2);

    assert.strictEqual(body1, serialised);
    assert.strictEqual(body2, serialised);
    // Must be the same string — not re-serialised.
    assert.strictEqual(body1, body2);
  });

  it('string body is replayed without modification', async () => {
    const rawBody = 'raw-string-body';

    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'PUT',
      body: rawBody,
      retryActive: true,
    });

    const { body: body1 } = await builder.buildAttempt(1);
    const { body: body2 } = await builder.buildAttempt(2);

    assert.strictEqual(body1, rawBody);
    assert.strictEqual(body2, rawBody);
  });

  it('Uint8Array body is replayed without modification', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const builder = RequestBuilder.create({
      url: 'https://api.test/upload',
      method: 'PUT',
      body: bytes,
      retryActive: true,
    });

    const { body: body1 } = await builder.buildAttempt(1);
    const { body: body2 } = await builder.buildAttempt(2);

    assert.ok(body1 instanceof Uint8Array);
    assert.ok(body2 instanceof Uint8Array);
    assert.deepStrictEqual(body1, bytes);
    assert.deepStrictEqual(body2, bytes);
    assert.strictEqual(body1, body2, 'same Uint8Array reference');
  });

  it('content-type: application/json is inferred for object bodies', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      body: { amount: 10 },
      retryActive: true,
    });

    const { headers } = await builder.buildAttempt(1);
    const ct = headers.get('content-type');
    assert.ok(ct?.includes('application/json'), `expected application/json, got: ${ct}`);
  });

  it('explicit content-type header is not overwritten', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/payments',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: { amount: 10 },
      retryActive: true,
    });

    const { headers } = await builder.buildAttempt(1);
    assert.strictEqual(headers.get('content-type'), 'application/x-www-form-urlencoded');
  });
});

// ============================================================================
// AC-7 — ReadableStream body + retryActive → setup error
// ============================================================================

describe('Phase 5 hooks — AC-7: stream body with retry → setup error', () => {
  it('ReadableStream + retryActive → ResilientHttpError { kind:setup }', () => {
    // ReadableStream is a global in Node 18+ (via the Web Streams API).
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    assert.throws(
      () => RequestBuilder.create({
        url: 'https://api.test/upload',
        method: 'POST',
        body: stream,
        retryActive: true,
      }),
      (err: unknown) => {
        assert.ok(isResilientHttpError(err));
        assert.strictEqual((err as { kind: string }).kind, 'setup');
        const msg = (err as { message: string }).message;
        assert.ok(
          msg.includes('ReadableStream') || msg.includes('stream') || msg.includes('replay'),
          `expected stream-related message, got: ${msg}`
        );
        return true;
      }
    );
  });

  it('ReadableStream + retryActive:false does NOT throw at create time', () => {
    const stream = new ReadableStream();

    // Should not throw — single-use stream is allowed without retry.
    assert.doesNotThrow(() =>
      RequestBuilder.create({
        url: 'https://api.test/upload',
        method: 'POST',
        body: stream,
        retryActive: false,
      })
    );
  });
});

// ============================================================================
// AC-8 — onRetry / onFailure observers throw → captured, never propagated
// ============================================================================

describe('Phase 5 hooks — AC-8: observer hooks throw → captured, not propagated', () => {
  it('onRetry observer that throws → not propagated', async () => {
    await assert.doesNotReject(() =>
      runRetryObservers(
        () => { throw new Error('observer boom'); },
        new Error('original'),
        1,
        1000
      )
    );
  });

  it('onRetry array with one throwing observer → others still run', async () => {
    const log: string[] = [];

    await runRetryObservers(
      [
        () => { log.push('first'); throw new Error('boom'); },
        () => { log.push('second'); },
      ],
      new Error('original'),
      1,
      1000
    );

    assert.deepStrictEqual(log, ['first', 'second']);
  });

  it('onFailure observer that throws → not propagated', async () => {
    await assert.doesNotReject(() =>
      runFailureObservers(
        () => { throw new Error('failure observer boom'); },
        new Error('original'),
        3
      )
    );
  });

  it('onFailure array with throwing observer → others still run', async () => {
    const log: string[] = [];

    await runFailureObservers(
      [
        () => { throw new Error('boom'); },
        () => { log.push('ran'); },
      ],
      new Error('original'),
      3
    );

    assert.deepStrictEqual(log, ['ran']);
  });

  it('async onRetry observer that throws → captured', async () => {
    await assert.doesNotReject(() =>
      runRetryObservers(
        async () => { throw new Error('async boom'); },
        new Error('original'),
        2,
        500
      )
    );
  });

  it('async onFailure observer that throws → captured', async () => {
    await assert.doesNotReject(() =>
      runFailureObservers(
        async () => { throw new Error('async boom'); },
        new Error('original'),
        2
      )
    );
  });
});

// ============================================================================
// AC-9 — onResponse throws → ResilientHttpError { kind:'setup' }
// ============================================================================

describe('Phase 5 hooks — AC-9: onResponse throw → setup error', () => {
  it('single onResponse hook that throws → setup error', async () => {
    const ctx = makeCtx();

    await assert.rejects(
      () => runResponseHooks(
        () => { throw new Error('response hook boom'); },
        ctx
      ),
      (err: unknown) => {
        assert.ok(isResilientHttpError(err));
        assert.strictEqual((err as { kind: string }).kind, 'setup');
        assert.ok((err as { message: string }).message.includes('response hook boom'));
        return true;
      }
    );
  });

  it('onResponse array — stops at the throwing hook', async () => {
    const log: string[] = [];
    const ctx = makeCtx();

    await assert.rejects(
      () => runResponseHooks(
        [
          () => { log.push('first'); throw new Error('boom'); },
          () => { log.push('second'); },
        ],
        ctx
      )
    );

    assert.deepStrictEqual(log, ['first']);
  });

  it('onResponse that succeeds runs before the caller can check the response', async () => {
    const ctx = makeCtx();
    let ranHook = false;

    // Should not throw — verify hook ran.
    await assert.doesNotReject(() =>
      runResponseHooks(
        () => { ranHook = true; },
        ctx
      )
    );

    assert.ok(ranHook);
  });
});

// ============================================================================
// Additional: requestId is stable across buildAttempt calls; attemptId changes
// ============================================================================

describe('Phase 5 hooks — requestId/attemptId stability', () => {
  it('requestId is the same across all attempts', async () => {
    const capturedIds: string[] = [];

    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'GET',
      hooks: {
        onRequest: (ctx) => { capturedIds.push(ctx.requestId); },
      },
    });

    await builder.buildAttempt(1);
    await builder.buildAttempt(2);
    await builder.buildAttempt(3);

    assert.strictEqual(capturedIds[0], capturedIds[1]);
    assert.strictEqual(capturedIds[1], capturedIds[2]);
    assert.ok(typeof capturedIds[0] === 'string' && capturedIds[0].length > 0);
  });

  it('attemptId changes on each attempt', async () => {
    const capturedAttemptIds: string[] = [];

    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'GET',
      hooks: {
        onRequest: (ctx) => { capturedAttemptIds.push(ctx.attemptId); },
      },
    });

    await builder.buildAttempt(1);
    await builder.buildAttempt(2);

    assert.notStrictEqual(capturedAttemptIds[0], capturedAttemptIds[1]);
  });
});

// ============================================================================
// Additional: no hooks at all — builder works with zero config
// ============================================================================

describe('Phase 5 hooks — zero hooks baseline', () => {
  it('builder works with no hooks specified', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'GET',
    });

    const { ctx, headers, body } = await builder.buildAttempt(1);

    assert.strictEqual(ctx.attempt, 1);
    assert.ok(ctx.requestId.length > 0);
    assert.ok(headers instanceof Headers);
    assert.strictEqual(body, null);
  });

  it('null body → null returned from buildAttempt', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'DELETE',
      body: null,
    });

    const { body } = await builder.buildAttempt(1);
    assert.strictEqual(body, null);
  });
});

// ============================================================================
// Additional: async hooks work correctly
// ============================================================================

describe('Phase 5 hooks — async hook support', () => {
  it('async onRequest hooks run sequentially in order', async () => {
    const log: number[] = [];

    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'GET',
      hooks: {
        onRequest: [
          async () => { await Promise.resolve(); log.push(1); },
          async () => { await Promise.resolve(); log.push(2); },
          async () => { await Promise.resolve(); log.push(3); },
        ],
      },
    });

    await builder.buildAttempt(1);
    assert.deepStrictEqual(log, [1, 2, 3]);
  });

  it('async onRequest hook that rejects → setup error', async () => {
    const builder = RequestBuilder.create({
      url: 'https://api.test/items',
      method: 'GET',
      hooks: {
        onRequest: async () => {
          await Promise.resolve();
          throw new Error('async hook failed');
        },
      },
    });

    await assert.rejects(
      () => builder.buildAttempt(1),
      (err: unknown) => {
        assert.ok(isResilientHttpError(err));
        assert.strictEqual((err as { kind: string }).kind, 'setup');
        return true;
      }
    );
  });
});
