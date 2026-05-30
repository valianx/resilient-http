/**
 * 16-headers-and-logger.ts
 *
 * Tools: instance + per-request header merging, Logger interface.
 *
 * Contract — header merging:
 *   - Instance headers (ResilientHttpOptions.headers) are set on every request.
 *   - Per-request headers (RequestConfig.headers) are merged shallowly.
 *   - Per-request values WIN on key conflicts (case-sensitive).
 *   - Keys __proto__, constructor, prototype are always blocked (prototype-
 *     pollution safety).
 *
 * Contract — Logger:
 *   interface Logger {
 *     error(message: string, context?: Record<string, unknown>): void;
 *     warn(message: string, context?: Record<string, unknown>): void;
 *     info?(message: string, context?: Record<string, unknown>): void;
 *     debug?(message: string, context?: Record<string, unknown>): void;
 *   }
 *   Compatible with console, winston, pino, bunyan, etc.
 *   The library uses logger.warn when retry is active without timeout/deadline
 *   (AC-9). It never calls logger.error internally.
 */

import { createResilientHttp } from 'resilient-http';
import type { Logger } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — captures the headers sent to each call.
// ---------------------------------------------------------------------------

function makeHeaderSpy(): {
  fetch: typeof globalThis.fetch;
  lastHeaders: () => Record<string, string>;
} {
  let last: Record<string, string> = {};
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    last = {};
    const h = init?.headers;
    if (h instanceof Headers) {
      h.forEach((v, k) => { last[k] = v; });
    } else if (h && typeof h === 'object') {
      Object.assign(last, h);
    }
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, lastHeaders: () => last };
}

// ---------------------------------------------------------------------------
// Example A: instance headers are sent on every request.
// ---------------------------------------------------------------------------

export async function example16a(): Promise<void> {
  const spy = makeHeaderSpy();

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: spy.fetch,
    headers: {
      'Authorization': 'Bearer instance-token',
      'X-App-Version': '2.0.2',
    },
  });

  await client.get('/resource');
  const h = spy.lastHeaders();

  console.log(h['authorization']);    // 'Bearer instance-token'
  console.log(h['x-app-version']);    // '2.0.2'
}

// ---------------------------------------------------------------------------
// Example B: per-request headers override instance headers on the same key.
// ---------------------------------------------------------------------------

export async function example16b(): Promise<void> {
  const spy = makeHeaderSpy();

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: spy.fetch,
    headers: {
      'Authorization': 'Bearer instance-token',
      'Accept': 'application/json',
    },
  });

  // Per-request Authorization overrides the instance value.
  await client.get('/admin', {
    headers: { 'Authorization': 'Bearer admin-token' },
  });

  const h = spy.lastHeaders();
  console.log(h['authorization']); // 'Bearer admin-token'  (overridden)
  console.log(h['accept']);        // 'application/json'    (from instance)
}

// ---------------------------------------------------------------------------
// Example C: json shorthand automatically sets Content-Type.
// No need to add 'Content-Type: application/json' manually when using `json`.
// ---------------------------------------------------------------------------

export async function example16c(): Promise<void> {
  const spy = makeHeaderSpy();

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: spy.fetch,
  });

  await client.post('/items', { json: { name: 'widget' } });
  const h = spy.lastHeaders();

  console.log(h['content-type']); // 'application/json'
}

// ---------------------------------------------------------------------------
// Example D: Logger — plugging in a structured logger.
// The library uses warn for the retry-without-bound advisory (AC-9).
// ---------------------------------------------------------------------------

export async function example16d(): Promise<void> {
  const warnMessages: string[] = [];

  const logger: Logger = {
    error: (msg) => console.error('[ERROR]', msg),
    warn: (msg) => {
      warnMessages.push(msg);
      console.warn('[WARN]', msg);
    },
    info: (msg) => console.info('[INFO]', msg),
    debug: (msg) => console.debug('[DEBUG]', msg),
  };

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: async () =>
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    logger,
    retry: {
      maxAttempts: 3,
      // No timeout or deadline — the library will warn via logger.warn.
    },
  });

  await client.get('/resource');

  // AC-9: the library emitted a warning because retry is active
  // without a timeout or deadline guard.
  console.log(warnMessages.length > 0); // true
  console.log(warnMessages[0]);
  // 'resilient-http: retry activo sin timeout/deadline: posible cuelgue indefinido'
}

// ---------------------------------------------------------------------------
// Example E: Logger minimal implementation — only error + warn required.
// info and debug are optional.
// ---------------------------------------------------------------------------

export async function example16e(): Promise<void> {
  const minimal: Logger = {
    error: (msg, ctx) => console.error(msg, ctx),
    warn: (msg, ctx) => console.warn(msg, ctx),
    // info and debug are optional — omitting them is fine.
  };

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: async () =>
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    logger: minimal,
  });

  const res = await client.get('/health');
  console.log(res.status); // 200
}
