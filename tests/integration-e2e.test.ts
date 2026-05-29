/**
 * End-to-end integration tests for the complete resilient-http client.
 *
 * Estos tests ejercitan `createResilientHttp()` de punta a punta con fetch
 * mockeado. El objetivo es verificar que las garantías críticas del README
 * —preset de pagos, BFF pattern, idempotencia, anti-doble-cobro— se cumplen
 * a nivel del cliente completo, no sólo a nivel unitario de los subsistemas.
 *
 * Gaps cubiertos aquí que no existían en la suite por fases:
 *   GAP-1:  Anti-doble-cobro: POST con timeout/red → NO reintenta VÍA EL CLIENTE.
 *           El engine tiene cobertura unitaria pero el camino end-to-end POST →
 *           createResilientHttp → retryEngine no tenía test de integración.
 *   GAP-2:  Idempotency-key estable en reintentos VÍA EL CLIENTE.
 *           El RequestBuilder tiene cobertura unitaria; aquí verificamos que la
 *           clave llega al fetch real con el mismo valor en ambos intentos.
 *   GAP-3:  toJSON safe-by-default sobre un error REAL producido por el cliente
 *           con secreto en header → no aparece en toJSON().
 *   GAP-4:  Retry exitoso GET 503 → 200 vía el cliente, con response.attempts=2.
 *   GAP-5:  Preset de pagos del README: POST + idempotencyKey + redactQueryParams
 *           + timeout/deadline como bloque integrado.
 *   GAP-6:  BFF pattern del README: error.toJSON() omite body/cause/meta;
 *           clientMessage derivado de kind/statusCode es correcto.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createResilientHttp } from '../src/client/create';
import { isResilientHttpError } from '../src/errors/resilient-http-error';

// ============================================================================
// Helpers
// ============================================================================

type FetchCall = { url: string; init: RequestInit };

type FetchSpec = {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
  rejectWith?: unknown;
};

function makeFetch(responses: FetchSpec[]) {
  let callIndex = 0;
  const calls: FetchCall[] = [];

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });

    const spec = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;

    if (spec.rejectWith !== undefined) throw spec.rejectWith;

    const status = spec.status ?? 200;
    const headers = new Headers(spec.headers ?? { 'content-type': 'application/json' });
    const body = spec.body !== undefined ? spec.body : '{}';
    return new Response(body, { status, statusText: spec.statusText ?? 'OK', headers });
  };

  return { mockFetch: mockFetch as typeof globalThis.fetch, calls };
}

// ============================================================================
// GAP-1: POST timeout → NO reintenta (anti-doble-cobro) vía cliente completo
// ============================================================================

describe('GAP-1: POST timeout/network → does NOT retry via full client', () => {
  it('POST with fetch TypeError → no retry, ResilientHttpError{kind:network}, 1 call', async () => {
    const { mockFetch, calls } = makeFetch([
      { rejectWith: new TypeError('Failed to fetch') },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      retry: { maxAttempts: 3, initialDelay: 0, jitter: 'none' },
    });

    const error = await client.post('https://payments.test/charges', {
      json: { amount: 5000, currency: 'usd' },
    }).catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error), 'must be ResilientHttpError');
    assert.strictEqual(error.kind, 'network');
    // Critical: POST must NOT have been retried despite maxAttempts=3.
    assert.strictEqual(calls.length, 1,
      `POST network error must not retry — calls=${calls.length}`);
    assert.strictEqual(error.attempts, 1,
      `error.attempts must be 1 for non-retried POST — got ${error.attempts}`);
  });

  it('POST 503 → no retry, throws on first attempt (double-charge prevention)', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 503, body: '{"error":"unavailable"}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      retry: { maxAttempts: 3, initialDelay: 0, jitter: 'none' },
    });

    const error = await client.post('https://payments.test/charges', {
      json: { amount: 5000, currency: 'usd' },
    }).catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    assert.strictEqual(error.kind, 'response');
    assert.strictEqual(error.statusCode, 503);
    // POST must NOT have retried on 503.
    assert.strictEqual(calls.length, 1,
      `POST 503 must not retry via client — calls=${calls.length}`);
  });
});

// ============================================================================
// GAP-2: idempotency-key stable across retries, delivered to real fetch
// ============================================================================

describe('GAP-2: idempotency-key is identical on all fetch calls (via client)', () => {
  it('GET with idempotencyKey string — same header value on attempt 1 and 2', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 503, body: '{}', headers: { 'content-type': 'application/json' } },
      { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      idempotencyKey: 'stable-key-xyz',
      retry: { maxAttempts: 2, initialDelay: 0, jitter: 'none', retryableMethods: ['GET'] },
    });

    await client.get('https://api.test/resource');

    assert.strictEqual(calls.length, 2, 'should have made 2 fetch calls');

    const getKey = (call: FetchCall): string | null => {
      const hdrs = call.init.headers as Headers;
      return hdrs?.get?.('Idempotency-Key') ?? null;
    };

    const key1 = getKey(calls[0]);
    const key2 = getKey(calls[1]);

    assert.ok(key1 !== null, 'attempt 1 must have Idempotency-Key header');
    assert.ok(key2 !== null, 'attempt 2 must have Idempotency-Key header');
    assert.strictEqual(key1, key2,
      `Idempotency-Key must be identical on all attempts — got "${key1}" vs "${key2}"`);
    assert.strictEqual(key1, 'stable-key-xyz');
  });

  it('() => randomUUID() provider is called once; same key on 2 attempts', async () => {
    let providerCalls = 0;
    const frozenKey = 'uuid-from-provider-once';

    const provider = (): string => {
      providerCalls++;
      return frozenKey;
    };

    const { mockFetch, calls } = makeFetch([
      { status: 503, body: '{}', headers: { 'content-type': 'application/json' } },
      { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      idempotencyKey: provider,
      retry: { maxAttempts: 2, initialDelay: 0, jitter: 'none', retryableMethods: ['GET'] },
    });

    await client.get('https://api.test/idempotent-resource');

    // Provider must have been called exactly once regardless of retry count.
    assert.strictEqual(providerCalls, 1,
      `Provider must be called exactly once — called ${providerCalls} times`);
    assert.strictEqual(calls.length, 2);

    const key1 = (calls[0].init.headers as Headers).get('Idempotency-Key');
    const key2 = (calls[1].init.headers as Headers).get('Idempotency-Key');
    assert.strictEqual(key1, frozenKey);
    assert.strictEqual(key2, frozenKey);
  });
});

// ============================================================================
// GAP-3: toJSON safe-by-default on error from real client request
//         secret in Authorization header → absent from toJSON()
// ============================================================================

describe('GAP-3: toJSON() safe-by-default on real client error (secret not leaked)', () => {
  it('Authorization header in error response headers → [REDACTED] in toJSON()', async () => {
    const secretToken = 'Bearer sk-prod-SUPERSECRET-PAYMENT-TOKEN-9999';

    const { mockFetch } = makeFetch([
      {
        status: 401,
        body: '{"error":"unauthorized"}',
        headers: {
          'content-type': 'application/json',
          'authorization': secretToken,   // server echoes auth header (unusual but tested)
          'x-request-id': 'req-abc',
        },
      },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });

    const error = await client.get('https://api.test/protected').catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error), 'must be ResilientHttpError');
    assert.strictEqual(error.kind, 'response');
    assert.strictEqual(error.statusCode, 401);

    const json = error.toJSON();
    const serialised = JSON.stringify(json);

    // The secret must NEVER appear in toJSON() output.
    assert.ok(
      !serialised.includes(secretToken),
      `Secret token leaked in toJSON(): ${serialised.slice(0, 200)}`
    );

    // Authorization should be [REDACTED].
    const headers = json['headers'] as Record<string, string> | undefined;
    if (headers && 'authorization' in headers) {
      assert.strictEqual(headers['authorization'], '[REDACTED]',
        'authorization header must be [REDACTED] in toJSON()');
    }

    // Non-sensitive headers should still be present.
    assert.ok(json['kind'] === 'response');
    assert.ok(json['statusCode'] === 401);
  });

  it('secret in query param → [REDACTED] in toJSON() url when redactQueryParams configured', async () => {
    const secretApiKey = 'api_key_SUPERSECRET_XYZ_9999';

    const { mockFetch } = makeFetch([
      { status: 403, body: '{"error":"forbidden"}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      redactQueryParams: ['api_key', 'signature'],
    });

    const error = await client.get(
      `https://api.test/data?api_key=${secretApiKey}&page=1`
    ).catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    const json = error.toJSON();
    const safeUrl = json['url'] as string;

    assert.ok(
      !safeUrl.includes(secretApiKey),
      `Secret API key must not appear in toJSON() url: ${safeUrl}`
    );
    // Non-sensitive param must survive.
    assert.ok(safeUrl.includes('page=1'), `Non-sensitive param page=1 must survive: ${safeUrl}`);
  });
});

// ============================================================================
// GAP-4: retry exitoso GET 503 → 200 vía cliente, attempts=2
// ============================================================================

describe('GAP-4: successful retry GET 503→200 via full client', () => {
  it('GET fails with 503, retries, succeeds on attempt 2 with response.attempts=2', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 503, body: '{"error":"unavailable"}', headers: { 'content-type': 'application/json' } },
      { status: 200, body: '{"result":"data"}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      retry: { maxAttempts: 2, initialDelay: 0, jitter: 'none' },
    });

    const response = await client.get('https://api.test/items');

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.data, { result: 'data' });
    assert.strictEqual(response.attempts, 2,
      `response.attempts must be 2 — got ${response.attempts}`);
    assert.strictEqual(calls.length, 2, 'must have made exactly 2 fetch calls');
  });
});

// ============================================================================
// GAP-5: Payment preset (README) as integrated block
// ============================================================================

describe('GAP-5: payment-safe preset from README — integrated smoke', () => {
  it('preset client: PUT idempotent charge, frozen key, deadline, redactQueryParams', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{"id":"ch_123","status":"captured"}', headers: { 'content-type': 'application/json' } },
    ]);

    // Replicate the README payment preset (simplified for testing).
    const paymentClient = createResilientHttp({
      baseURL: 'https://payments.test',
      fetch: mockFetch,
      retry: {
        maxAttempts: 3,
        backoff: 'exponential',
        jitter: 'none',
        initialDelay: 0,
        maxRetryAfter: 5_000,
        retryableMethods: ['GET', 'HEAD', 'PUT', 'DELETE'],
      },
      idempotencyKey: () => 'test-frozen-key-for-payment',
      redactQueryParams: ['token', 'signature', 'api_key'],
      headers: { 'Content-Type': 'application/json' },
    });

    // Use PUT (idempotent) as the README recommends.
    const response = await paymentClient.put<{ id: string; status: string }>(
      '/charges/ch_123/capture',
      { json: { amount: 1000, currency: 'usd' } }
    );

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.data, { id: 'ch_123', status: 'captured' });
    assert.strictEqual(calls.length, 1);

    // Verify idempotency key was sent.
    const sentHeaders = calls[0].init.headers as Headers;
    const idemKey = sentHeaders.get('Idempotency-Key');
    assert.strictEqual(idemKey, 'test-frozen-key-for-payment',
      `Expected idempotency key, got: ${idemKey}`);

    // Verify PUT method.
    assert.strictEqual(calls[0].init.method, 'PUT');

    // Verify body was JSON-encoded.
    assert.strictEqual(calls[0].init.body, JSON.stringify({ amount: 1000, currency: 'usd' }));
  });

  it('preset client: PUT with 503 retries; POST does NOT retry (payment safety)', async () => {
    // PUT (idempotent) SHOULD retry on 503.
    const { mockFetch: mockPutFetch, calls: putCalls } = makeFetch([
      { status: 503, body: '{}', headers: { 'content-type': 'application/json' } },
      { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
    ]);

    const paymentClient = createResilientHttp({
      baseURL: 'https://payments.test',
      fetch: mockPutFetch,
      retry: {
        maxAttempts: 2,
        initialDelay: 0,
        jitter: 'none',
        retryableMethods: ['GET', 'HEAD', 'PUT', 'DELETE'],
      },
    });

    const response = await paymentClient.put('/charges/ch_123/capture', {
      json: { amount: 1000 },
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(putCalls.length, 2, 'PUT should retry on 503');

    // POST to the same client MUST NOT retry.
    const { mockFetch: mockPostFetch, calls: postCalls } = makeFetch([
      { status: 503, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);
    const paymentClient2 = createResilientHttp({
      baseURL: 'https://payments.test',
      fetch: mockPostFetch,
      retry: {
        maxAttempts: 2,
        initialDelay: 0,
        jitter: 'none',
        retryableMethods: ['GET', 'HEAD', 'PUT', 'DELETE'],
      },
    });

    const postError = await paymentClient2.post('/charges', { json: { amount: 1000 } }).catch((e: unknown) => e);
    assert.ok(isResilientHttpError(postError));
    assert.strictEqual(postError.statusCode, 503);
    // POST must have been tried exactly once.
    assert.strictEqual(postCalls.length, 1,
      `POST must not retry when not in retryableMethods — calls=${postCalls.length}`);
  });
});

// ============================================================================
// GAP-6: BFF pattern from README — error.toJSON() is safe, clientMessage correct
// ============================================================================

describe('GAP-6: BFF pattern — toJSON() safe; clientMessage maps correctly', () => {
  it('kind:response → clientMessage includes statusCode, body excluded', async () => {
    const { mockFetch } = makeFetch([
      {
        status: 422,
        body: '{"detail":"invalid card number","internal":"db-secret-xyz"}',
        headers: { 'content-type': 'application/json' },
      },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });

    const error = await client.post('https://api.test/charges', {
      json: { card: '0000000000000000' },
    }).catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    assert.strictEqual(error.kind, 'response');
    assert.strictEqual(error.statusCode, 422);

    // Simulate the BFF clientMessage derivation from README.
    const clientMessage = error.kind === 'network'
      ? 'Service temporarily unavailable'
      : `Request failed with status ${error.statusCode ?? 'unknown'}`;

    assert.strictEqual(clientMessage, 'Request failed with status 422');

    // toJSON() must NOT expose body.
    const json = error.toJSON();
    assert.ok(!('body' in json), 'toJSON() must not include body (BFF safety)');

    // Internal field from body must not appear in toJSON() output.
    const serialised = JSON.stringify(json);
    assert.ok(!serialised.includes('db-secret-xyz'),
      'internal body field must not appear in toJSON() for BFF forwarding');
  });

  it('kind:network → clientMessage is "Service temporarily unavailable"', async () => {
    const { mockFetch } = makeFetch([
      { rejectWith: new TypeError('Failed to fetch') },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    const error = await client.get('https://api.test/data').catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    assert.strictEqual(error.kind, 'network');

    const clientMessage = error.kind === 'network'
      ? 'Service temporarily unavailable'
      : `Request failed with status ${error.statusCode ?? 'unknown'}`;

    assert.strictEqual(clientMessage, 'Service temporarily unavailable');

    // toJSON() safe.
    const json = error.toJSON();
    assert.ok(!('cause' in json), 'toJSON() must not include cause');
    assert.ok(!('body' in json), 'toJSON() must not include body');
  });

  it('meta from hooks does NOT appear in toJSON() even with rich payload', async () => {
    const internalSecret = 'internal-db-connection-string-ABCDEF';

    const { mockFetch } = makeFetch([
      { status: 500, body: '{"error":"internal"}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      hooks: {
        onRequest: (ctx) => {
          // Store internal debug data in meta (normal pattern).
          ctx.meta['dbConn'] = internalSecret;
          ctx.meta['requestTrace'] = { db: 'postgres', shard: 42 };
        },
      },
    });

    const error = await client.get('https://api.test/resource').catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    // meta IS available on the instance (for internal use).
    assert.strictEqual(error.meta?.['dbConn'], internalSecret,
      'meta should be accessible on the instance for internal use');

    // But toJSON() must NOT include meta.
    const json = error.toJSON();
    assert.ok(!('meta' in json), 'toJSON() must not include meta (BFF safety)');
    const serialised = JSON.stringify(json);
    assert.ok(!serialised.includes(internalSecret),
      `Internal secret from meta must not appear in toJSON(): ${serialised.slice(0, 200)}`);
  });
});
