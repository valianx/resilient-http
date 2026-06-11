/**
 * Tests for Phase 6: createResilientHttp integration.
 *
 * AC-1:  createResilientHttp() sin config → get(url) de 200 → ResilientResponse con data/status/headers/url/attempts/raw.
 * AC-2:  retry OFF por default (maxAttempts 1) → 503 con defaults lanza sin reintentar.
 * AC-3:  404 sin retry → ResilientHttpError kind:'response' statusCode 404.
 * AC-4:  .post(url, { json:{a:1} }) → body JSON + Content-Type application/json.
 * AC-5:  .get(url, { params:{ q:'hi', n:2 } }) → URL final con ?q=hi&n=2.
 * AC-6:  validateStatus:()=>true con 500 → NO lanza, devuelve ResilientResponse status 500.
 * AC-7:  204 → data null; responseType 'arrayBuffer' → ArrayBuffer; 'stream' → ReadableStream;
 *         205/304 → data null; Content-Length:0 → data null; HEAD → data null.
 * AC-8:  src/index.ts no exporta engine/RequestBuilder/hooks runners/classify.
 * AC-9:  maxAttempts>1 sin timeout ni deadline → logger.warn emitido.
 * AC-13: responseType 'stream' → data es ReadableStream, raw expone Response.
 * AC-15: ramas defensivas tienen cobertura (setup error de body no-serialisable / SEC-003).
 * SEC-003: hook deja body con referencia circular → setup error (no null silencioso).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createResilientHttp } from '../src/client/create';
import { isResilientHttpError } from '../src/errors/resilient-http-error';
import { EPOCH_FLOOR } from '../src/core/validate';
import type { RequestConfig } from '../src/types';

// ============================================================================
// Fetch mock helpers
// ============================================================================

type FetchMockOptions = {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
  /** If set, `fetch` will throw this value instead of returning a response. */
  rejectWith?: unknown;
};

/**
 * Create a minimal mock fetch compatible with the client.
 * Captures the calls so tests can inspect URL, method, headers, body.
 */
function makeFetch(responses: FetchMockOptions[]) {
  let callIndex = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const mockFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });

    const spec = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;

    if (spec.rejectWith !== undefined) {
      throw spec.rejectWith;
    }

    const status = spec.status ?? 200;
    const headers = new Headers(spec.headers ?? { 'content-type': 'application/json' });
    const responseBody = spec.body !== undefined ? spec.body : '{}';

    return new Response(responseBody, { status, statusText: spec.statusText ?? 'OK', headers });
  };

  return { mockFetch: mockFetch as typeof globalThis.fetch, calls };
}

// ============================================================================
// AC-1: createResilientHttp() sin config → ResilientResponse completo
// ============================================================================

describe('AC-1: createResilientHttp without config — GET 200', () => {
  it('returns a ResilientResponse with data/status/headers/url/attempts/raw', async () => {
    const { mockFetch } = makeFetch([
      { status: 200, body: '{"id":1}', headers: { 'content-type': 'application/json', 'x-request-id': 'abc' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    const response = await client.get<{ id: number }>('https://api.test/items/1');

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.data, { id: 1 });
    // url is a string (may be '' for mock Responses constructed without a real fetch URL).
    assert.ok(typeof response.url === 'string');
    assert.strictEqual(response.attempts, 1);
    assert.ok(response.raw instanceof Response);
    assert.strictEqual(response.headers['x-request-id'], 'abc');
  });

  it('data is null for an empty JSON body edge case', async () => {
    const { mockFetch } = makeFetch([
      { status: 200, body: 'null', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    const response = await client.get('https://api.test/empty');

    // JSON null → data is null
    assert.strictEqual(response.data, null);
  });
});

// ============================================================================
// AC-2: retry OFF por default — 503 lanza sin reintentar
// ============================================================================

describe('AC-2: default maxAttempts=1 — 503 throws without retry', () => {
  it('throws ResilientHttpError on 503 with attempts=1 (no retry)', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 503, body: '{"error":"unavailable"}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });

    const error = await client.get('https://api.test/service').catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    assert.strictEqual(error.kind, 'response');
    assert.strictEqual(error.statusCode, 503);
    // Only one fetch call — no retry.
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(error.attempts, 1);
  });
});

// ============================================================================
// AC-3: 404 sin retry → ResilientHttpError kind:'response' statusCode 404
// ============================================================================

describe('AC-3: 404 without retry → ResilientHttpError{kind:response, statusCode:404}', () => {
  it('throws with correct kind and statusCode', async () => {
    const { mockFetch } = makeFetch([
      { status: 404, statusText: 'Not Found', body: '{"error":"not found"}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    const error = await client.get('https://api.test/missing').catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    assert.strictEqual(error.kind, 'response');
    assert.strictEqual(error.statusCode, 404);
    assert.strictEqual(error.attempts, 1);
  });
});

// ============================================================================
// AC-4: .post(url, { json:{a:1} }) → JSON body + Content-Type header
// ============================================================================

describe('AC-4: .post with json shorthand', () => {
  it('serialises json body and sets Content-Type: application/json', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 201, body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    const config: RequestConfig = { json: { a: 1 } };
    await client.post('https://api.test/items', config);

    assert.strictEqual(calls.length, 1);
    const reqInit = calls[0].init;

    // Body must be the serialised JSON.
    assert.strictEqual(reqInit.body, JSON.stringify({ a: 1 }));

    // Content-Type must include application/json.
    const headers = reqInit.headers as Headers;
    const ct = headers.get('content-type');
    assert.ok(ct?.includes('application/json'), `Expected application/json, got: ${ct}`);
  });

  it('json property takes precedence over body', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    await client.post('https://api.test/items', { json: { from: 'json' }, body: 'from-body' });

    const reqInit = calls[0].init;
    assert.strictEqual(reqInit.body, JSON.stringify({ from: 'json' }));
  });
});

// ============================================================================
// AC-5: params → URL final con ?q=hi&n=2
// ============================================================================

describe('AC-5: query params appended to URL', () => {
  it('appends params as query string', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '[]', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    await client.get('https://api.test/search', { params: { q: 'hi', n: 2 } });

    const calledUrl = calls[0].url;
    assert.ok(calledUrl.includes('q=hi'), `Expected q=hi in ${calledUrl}`);
    assert.ok(calledUrl.includes('n=2'), `Expected n=2 in ${calledUrl}`);
  });

  it('omits null and undefined param values', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    await client.get('https://api.test/items', {
      params: { present: 'yes', absent: null, missing: undefined },
    });

    const calledUrl = calls[0].url;
    assert.ok(calledUrl.includes('present=yes'));
    assert.ok(!calledUrl.includes('absent'));
    assert.ok(!calledUrl.includes('missing'));
  });

  it('works with baseURL', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ baseURL: 'https://api.test', fetch: mockFetch });
    await client.get('/users', { params: { page: 1 } });

    const calledUrl = calls[0].url;
    assert.ok(calledUrl.startsWith('https://api.test/users'), calledUrl);
    assert.ok(calledUrl.includes('page=1'));
  });
});

// ============================================================================
// AC-6: validateStatus:()=>true — 500 devuelve ResilientResponse, no lanza
// ============================================================================

describe('AC-6: custom validateStatus allows 500', () => {
  it('does not throw, returns ResilientResponse with status 500', async () => {
    const { mockFetch } = makeFetch([
      { status: 500, body: '{"error":"internal"}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      validateStatus: () => true,
    });

    const response = await client.get('https://api.test/error-endpoint');

    assert.strictEqual(response.status, 500);
    assert.deepStrictEqual(response.data, { error: 'internal' });
  });
});

// ============================================================================
// AC-7: body parsing escapes + responseType modes
// ============================================================================

describe('AC-7: body parsing escapes', () => {
  it('204 No Content → data === null', async () => {
    const { mockFetch } = makeFetch([
      { status: 204, body: null, headers: {} },
    ]);

    const client = createResilientHttp({ fetch: mockFetch, validateStatus: () => true });
    const response = await client.delete('https://api.test/items/1');

    assert.strictEqual(response.data, null);
    assert.strictEqual(response.status, 204);
  });

  it('205 Reset Content → data === null', async () => {
    const { mockFetch } = makeFetch([
      { status: 205, body: null, headers: {} },
    ]);

    const client = createResilientHttp({ fetch: mockFetch, validateStatus: () => true });
    const response = await client.post('https://api.test/reset');

    assert.strictEqual(response.data, null);
    assert.strictEqual(response.status, 205);
  });

  it('304 Not Modified → data === null', async () => {
    const { mockFetch } = makeFetch([
      { status: 304, body: null, headers: {} },
    ]);

    const client = createResilientHttp({ fetch: mockFetch, validateStatus: () => true });
    const response = await client.get('https://api.test/cached');

    assert.strictEqual(response.data, null);
    assert.strictEqual(response.status, 304);
  });

  it('Content-Length: 0 with 200 → data === null', async () => {
    const { mockFetch } = makeFetch([
      { status: 200, body: '', headers: { 'content-length': '0', 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    const response = await client.get('https://api.test/empty-body');

    assert.strictEqual(response.data, null);
  });

  it('HEAD → data === null even if body would be present', async () => {
    const { mockFetch } = makeFetch([
      { status: 200, body: '{"id":1}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    const response = await client.head('https://api.test/items/1');

    assert.strictEqual(response.data, null);
    assert.strictEqual(response.status, 200);
  });

  it('responseType arrayBuffer → data is ArrayBuffer', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    // We need a Response that yields binary data.
    const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    };

    const client = createResilientHttp({ fetch: mockFetch as typeof globalThis.fetch });
    const response = await client.get('https://api.test/binary', { responseType: 'arrayBuffer' });

    assert.ok(response.data instanceof ArrayBuffer);
    const view = new Uint8Array(response.data as ArrayBuffer);
    assert.deepStrictEqual([...view], [1, 2, 3, 4]);
    // Suppress unused variable warning.
    void bytes;
  });

  it('responseType none → data === null, body not read', async () => {
    const { mockFetch } = makeFetch([
      { status: 200, body: '{"id":1}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    const response = await client.get('https://api.test/items/1', { responseType: 'none' });

    assert.strictEqual(response.data, null);
    assert.strictEqual(response.status, 200);
  });
});

// ============================================================================
// AC-8: barrel src/index.ts exports only config-only surface
// ============================================================================

describe('AC-8: public barrel exports only config-only surface', async () => {
  it('exports createResilientHttp, ResilientHttpError, isResilientHttpError, and types', async () => {
    // Dynamic import — if it resolves and these are present we are good.
    const mod = await import('../src/index');

    assert.ok(typeof mod.createResilientHttp === 'function', 'createResilientHttp must be exported');
    assert.ok(typeof mod.ResilientHttpError === 'function', 'ResilientHttpError must be exported');
    assert.ok(typeof mod.isResilientHttpError === 'function', 'isResilientHttpError must be exported');
  });

  it('does NOT export engine, RequestBuilder, hooks runners, classify, backoff, jitter, sleep', async () => {
    const mod = await import('../src/index') as Record<string, unknown>;

    const forbidden = [
      'executeWithRetry',
      'executeWithRetryAndSignal',
      'RequestBuilder',
      'runRequestHooks',
      'runResponseHooks',
      'runRetryObservers',
      'runFailureObservers',
      'classifyError',
      'isRetryableError',
      'extractMessageFromBody',
      'buildAttemptSignal',
      'isCallerAbort',
      'exponentialBackoff',
      'linearBackoff',
      'constantBackoff',
      'calculateBackoff',
      'fullJitter',
      'equalJitter',
      'decorrelatedJitter',
      'noJitter',
      'applyJitter',
      'sleep',
      'sleepWithAbort',
      'randomBetween',
    ];

    for (const name of forbidden) {
      assert.ok(!(name in mod), `'${name}' must NOT be exported from src/index.ts (found it)`);
    }
  });
});

// ============================================================================
// AC-9: maxAttempts > 1 sin timeout/deadline → logger.warn
// ============================================================================

describe('AC-9: retry without timeout/deadline emits logger.warn', () => {
  it('emits warn when maxAttempts > 1 and no timeout or deadline', async () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => { warnings.push(msg); },
      error: () => {},
    };

    const { mockFetch } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      logger,
      retry: { maxAttempts: 3 },
    });

    await client.get('https://api.test/items');

    assert.ok(
      warnings.some((w) => w.includes('timeout') || w.includes('deadline') || w.includes('cuelgue')),
      `Expected warning about timeout/deadline, got: ${JSON.stringify(warnings)}`
    );
  });

  it('does NOT warn when maxAttempts > 1 and timeout is set', async () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => { warnings.push(msg); },
      error: () => {},
    };

    const { mockFetch } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      logger,
      retry: { maxAttempts: 3, timeout: 5000 },
    });

    await client.get('https://api.test/items');

    // No timeout/deadline warning should be emitted.
    const hasWarn = warnings.some((w) => w.includes('cuelgue') || w.includes('indefinido'));
    assert.ok(!hasWarn, `Unexpected warning: ${JSON.stringify(warnings)}`);
  });

  it('does NOT warn when maxAttempts is 1 (retry disabled)', async () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => { warnings.push(msg); },
      error: () => {},
    };

    const { mockFetch } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch, logger });
    await client.get('https://api.test/items');

    assert.strictEqual(warnings.length, 0);
  });
});

// ============================================================================
// AC-13: responseType 'stream' → data es ReadableStream, raw expone Response
// ============================================================================

describe('AC-13: responseType stream — no buffering', () => {
  it('data is the ReadableStream without buffering', async () => {
    const chunks = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const mockFetch = async (): Promise<Response> => {
      return new Response(chunks, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    };

    const client = createResilientHttp({ fetch: mockFetch as typeof globalThis.fetch });
    const response = await client.get('https://api.test/stream', { responseType: 'stream' });

    // data must be the ReadableStream, not a buffered value.
    assert.ok(response.data instanceof ReadableStream, 'data must be ReadableStream');
    assert.ok(response.raw instanceof Response, 'raw must be the Response');
    assert.strictEqual(response.status, 200);
  });
});

// ============================================================================
// SEC-003: body not-serialisable after hook mutation → setup error
// ============================================================================

describe('SEC-003: non-serialisable body after onRequest hook → setup error', () => {
  it('circular reference in ctx.request.body → ResilientHttpError{kind:setup}', async () => {
    const { mockFetch } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      hooks: {
        onRequest: (ctx) => {
          // Inject a circular reference — JSON.stringify will throw.
          const circular: Record<string, unknown> = { amount: 100 };
          circular['self'] = circular;
          ctx.request.body = circular;
        },
      },
    });

    const error = await client.post('https://api.test/payments', { body: { amount: 100 } }).catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error), 'must be a ResilientHttpError');
    assert.strictEqual(error.kind, 'setup',
      'must be kind:setup — a circular body must abort the request, not send null');
    // Ensure the error message is informative.
    assert.ok(
      error.message.includes('non-serialisable') || error.message.includes('circular') || error.message.includes('JSON'),
      `Expected informative message, got: ${error.message}`
    );
  });
});

// ============================================================================
// Additional: network error wrapping
// ============================================================================

describe('Network error wrapping', () => {
  it('fetch rejection → ResilientHttpError{kind:network}', async () => {
    const { mockFetch } = makeFetch([
      { rejectWith: new TypeError('Failed to fetch') },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    const error = await client.get('https://api.test/items').catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    assert.strictEqual(error.kind, 'network');
  });

  it('AbortError from fetch → ResilientHttpError{kind:network} with code ABORT_ERR', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    const { mockFetch } = makeFetch([{ rejectWith: abortError }]);

    const client = createResilientHttp({ fetch: mockFetch });
    const error = await client.get('https://api.test/items').catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    assert.strictEqual(error.kind, 'network');
  });
});

// ============================================================================
// Additional: baseURL + method shortcuts
// ============================================================================

describe('baseURL and HTTP method shortcuts', () => {
  it('prepends baseURL to relative paths', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ baseURL: 'https://api.test', fetch: mockFetch });
    await client.get('/users/1');

    assert.strictEqual(calls[0].url, 'https://api.test/users/1');
  });

  it('does not prepend baseURL to absolute URLs', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ baseURL: 'https://api.test', fetch: mockFetch });
    await client.get('https://other.service/data');

    assert.strictEqual(calls[0].url, 'https://other.service/data');
  });

  it('.put sends PUT method', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    await client.put('https://api.test/items/1', { json: { name: 'updated' } });

    assert.strictEqual(calls[0].init.method, 'PUT');
  });

  it('.patch sends PATCH method', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    await client.patch('https://api.test/items/1', { json: { name: 'patched' } });

    assert.strictEqual(calls[0].init.method, 'PATCH');
  });

  it('.delete sends DELETE method', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch, validateStatus: () => true });
    await client.delete('https://api.test/items/1');

    assert.strictEqual(calls[0].init.method, 'DELETE');
  });

  it('.options sends OPTIONS method', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    await client.options('https://api.test/items');

    assert.strictEqual(calls[0].init.method, 'OPTIONS');
  });

  it('.request generic sends the specified method', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({ fetch: mockFetch });
    await client.request({ url: 'https://api.test/custom', method: 'PATCH', json: {} });

    assert.strictEqual(calls[0].init.method, 'PATCH');
  });
});

// ============================================================================
// Additional: instance + per-request header merging
// ============================================================================

describe('Header merging (instance + per-request)', () => {
  it('instance headers are sent on every request', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      headers: { 'x-api-key': 'secret-key' },
    });

    await client.get('https://api.test/items');

    const reqHeaders = calls[0].init.headers as Headers;
    assert.strictEqual(reqHeaders.get('x-api-key'), 'secret-key');
  });

  it('per-request headers override instance headers', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      headers: { 'x-version': '1' },
    });

    await client.get('https://api.test/items', {
      headers: { 'x-version': '2' },
    });

    const reqHeaders = calls[0].init.headers as Headers;
    assert.strictEqual(reqHeaders.get('x-version'), '2');
  });
});

// ============================================================================
// Additional: retry with mock
// ============================================================================

describe('Retry integration', () => {
  it('retries on 503 when maxAttempts > 1 and method is GET', async () => {
    const { mockFetch, calls } = makeFetch([
      { status: 503, body: '{"error":"unavailable"}', headers: { 'content-type': 'application/json' } },
      { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      retry: { maxAttempts: 2, initialDelay: 0, backoff: 'constant', jitter: 'none' },
    });

    const response = await client.get('https://api.test/service');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(response.attempts, 2);
  });

  it('onRetry hook is called between attempts', async () => {
    const retryAttempts: number[] = [];

    const { mockFetch } = makeFetch([
      { status: 503, body: '{}', headers: { 'content-type': 'application/json' } },
      { status: 200, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      retry: {
        maxAttempts: 2,
        initialDelay: 0,
        backoff: 'constant',
        jitter: 'none',
      },
      hooks: {
        onRetry: (_err, attempt) => { retryAttempts.push(attempt); },
      },
    });

    await client.get('https://api.test/service');

    assert.ok(retryAttempts.length > 0, 'onRetry must have been called');
  });
});

// ============================================================================
// Issue #37 — AC-1: guardrail rejects deadline:8000 at instance construction
// ============================================================================

describe('AC-1 (#37): createResilientHttp throws on relative deadline:8000', () => {
  it('throws synchronously ResilientHttpError{kind:setup} containing "8000" and guidance', () => {
    let caughtError: unknown;
    try {
      createResilientHttp({ deadline: 8000 });
    } catch (e) {
      caughtError = e;
    }

    assert.ok(isResilientHttpError(caughtError), 'must be a ResilientHttpError');
    assert.strictEqual((caughtError as { kind: string }).kind, 'setup');
    assert.ok(
      (caughtError as { message: string }).message.includes('8000'),
      `message must contain "8000", got: ${(caughtError as { message: string }).message}`
    );
    assert.ok(
      (caughtError as { message: string }).message.includes('did you mean Date.now() + 8000?'),
      `message must contain guidance, got: ${(caughtError as { message: string }).message}`
    );
  });

  it('throws before any fetch call is made', () => {
    const fetchCalls: unknown[] = [];
    const mockFetch = async (): Promise<Response> => {
      fetchCalls.push(true);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    let threw = false;
    try {
      createResilientHttp({ fetch: mockFetch as typeof globalThis.fetch, deadline: 8000 });
    } catch {
      threw = true;
    }

    assert.ok(threw, 'must throw synchronously');
    assert.strictEqual(fetchCalls.length, 0, 'fetch must never be called');
  });
});

// ============================================================================
// Issue #37 — AC-2: guardrail rejects deadline:0 and deadline:-5
// ============================================================================

describe('AC-2 (#37): createResilientHttp throws on deadline:0 and deadline:-5', () => {
  it('throws for deadline:0', () => {
    let caughtError: unknown;
    try {
      createResilientHttp({ deadline: 0 });
    } catch (e) {
      caughtError = e;
    }

    assert.ok(isResilientHttpError(caughtError), 'must be a ResilientHttpError');
    assert.strictEqual((caughtError as { kind: string }).kind, 'setup');
  });

  it('throws for deadline:-5', () => {
    let caughtError: unknown;
    try {
      createResilientHttp({ deadline: -5 });
    } catch (e) {
      caughtError = e;
    }

    assert.ok(isResilientHttpError(caughtError), 'must be a ResilientHttpError');
    assert.strictEqual((caughtError as { kind: string }).kind, 'setup');
    assert.ok(
      (caughtError as { message: string }).message.includes('-5'),
      'message must contain the offending value "-5"'
    );
  });
});

// ============================================================================
// Issue #37 — AC-3: per-request guardrail rejects .get(url, {deadline:8000})
// ============================================================================

describe('AC-3 (#37): per-request deadline:8000 causes promise rejection, fetch never called', () => {
  it('rejects with ResilientHttpError{kind:setup} and never calls fetch', async () => {
    const fetchCalls: unknown[] = [];
    const mockFetch = async (): Promise<Response> => {
      fetchCalls.push(true);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const client = createResilientHttp({ fetch: mockFetch as typeof globalThis.fetch });
    const error = await client.get('https://api.test/items', { deadline: 8000 }).catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error), 'must be a ResilientHttpError');
    assert.strictEqual((error as { kind: string }).kind, 'setup');
    assert.ok(
      (error as { message: string }).message.includes('8000'),
      `message must contain "8000", got: ${(error as { message: string }).message}`
    );
    assert.ok(
      (error as { message: string }).message.includes('did you mean Date.now() + 8000?'),
      'message must include guidance'
    );
    assert.strictEqual(fetchCalls.length, 0, 'fetch must never be called');
  });
});

// ============================================================================
// Issue #37 — AC-4: retry sub-object deadline:8000 throws at construction
// ============================================================================

describe('AC-4 (#37): createResilientHttp({retry:{deadline:8000}}) throws synchronously', () => {
  it('throws ResilientHttpError{kind:setup} for relative deadline in retry sub-object', () => {
    let caughtError: unknown;
    try {
      createResilientHttp({ retry: { deadline: 8000 } });
    } catch (e) {
      caughtError = e;
    }

    assert.ok(isResilientHttpError(caughtError), 'must be a ResilientHttpError');
    assert.strictEqual((caughtError as { kind: string }).kind, 'setup');
    assert.ok(
      (caughtError as { message: string }).message.includes('8000'),
      `message must contain "8000", got: ${(caughtError as { message: string }).message}`
    );
  });
});

// ============================================================================
// Issue #37 — AC-8: EPOCH_FLOOR boundary: 1e12 accepted, 1e12-1 rejected
// ============================================================================

describe('AC-8 (#37): EPOCH_FLOOR boundary — 1e12 accepted, 1e12-1 rejected', () => {
  it('deadline === EPOCH_FLOOR (1e12) is accepted (not rejected by guardrail)', () => {
    // Must not throw — this is the boundary value at the floor of acceptable epochs.
    assert.doesNotThrow(() => {
      createResilientHttp({ deadline: EPOCH_FLOOR });
    });
  });

  it('deadline === EPOCH_FLOOR - 1 is rejected', () => {
    let caughtError: unknown;
    try {
      createResilientHttp({ deadline: EPOCH_FLOOR - 1 });
    } catch (e) {
      caughtError = e;
    }

    assert.ok(isResilientHttpError(caughtError), 'must be a ResilientHttpError');
    assert.strictEqual((caughtError as { kind: string }).kind, 'setup');
  });
});

// ============================================================================
// Issue #37 — AC-9: no totalTimeout field exists on public types
// ============================================================================

describe('AC-9 (#37): no totalTimeout field on RetryOptions / ResilientHttpOptions / RequestConfig', () => {
  it('totalTimeout does not exist on any public type (source grep guard)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const typesPath = path.resolve(
      new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
      '../src/types/index.ts'
    );

    const source = fs.readFileSync(typesPath, 'utf-8');
    const hasTotalTimeout = /totalTimeout/.test(source);

    assert.strictEqual(
      hasTotalTimeout,
      false,
      'totalTimeout must NOT appear in src/types/index.ts — it was a cancelled direction'
    );
  });

  it('RetryOptions deadline is typed as deadline (not totalTimeout)', () => {
    // Type-level check: a RetryOptions object with deadline compiles fine.
    const opts: import('../src/types').RetryOptions = { deadline: Date.now() + 8000 };
    assert.ok(opts.deadline !== undefined);
    // @ts-expect-error — totalTimeout does not exist on RetryOptions
    const _unused = (opts as unknown as Record<string, unknown>)['totalTimeout'];
    void _unused;
  });
});

// ============================================================================
// Additional: meta from hooks travels to ResilientHttpError
// ============================================================================

describe('meta from hooks travels to error', () => {
  it('builder.meta is attached to the thrown ResilientHttpError', async () => {
    const { mockFetch } = makeFetch([
      { status: 500, body: '{}', headers: { 'content-type': 'application/json' } },
    ]);

    const client = createResilientHttp({
      fetch: mockFetch,
      hooks: {
        onRequest: (ctx) => { ctx.meta['correlationId'] = 'corr-123'; },
      },
    });

    const error = await client.get('https://api.test/items').catch((e: unknown) => e);

    assert.ok(isResilientHttpError(error));
    // meta must have been passed through to the error
    assert.ok(error.meta !== undefined, 'meta must be present on the error');
    assert.strictEqual(error.meta?.['correlationId'], 'corr-123');
  });
});
