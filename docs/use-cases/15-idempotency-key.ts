/**
 * 15-idempotency-key.ts
 *
 * Tool: IdempotencyKeyOption — idempotency key attachment.
 *
 * Contract:
 *   - true       → generate a random UUID (crypto.randomUUID) once per logical
 *                  operation. The SAME key is used for all retry attempts.
 *   - string     → use this static value for every request and retry.
 *   - () => string → called ONCE per logical operation; the returned value is
 *                   frozen for all retries. This prevents a pattern like
 *                   () => crypto.randomUUID() from issuing a different key
 *                   on each retry attempt.
 *
 *   The key is attached as the 'Idempotency-Key' header (or the custom
 *   idempotencyHeader name) BEFORE onRequest hooks run, so hooks can read it.
 *
 *   CRLF safety: header values are validated by the standard Headers API;
 *   a key containing CR or LF characters will cause the request to fail.
 *
 *   The key header name defaults to 'Idempotency-Key'. Override with
 *   idempotencyHeader at the instance level.
 */

import { createResilientHttp } from 'resilient-http';
import type { HookContext } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — captures headers sent to each attempt.
// ---------------------------------------------------------------------------

function makeHeaderCapture(): {
  fetch: typeof globalThis.fetch;
  capturedKeys: () => string[];
} {
  const keys: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const headers = init?.headers;
    let key = '';
    if (headers instanceof Headers) {
      key = headers.get('Idempotency-Key') ?? '';
    } else if (headers && typeof headers === 'object') {
      const rec = headers as Record<string, string>;
      key = rec['Idempotency-Key'] ?? rec['idempotency-key'] ?? '';
    }
    keys.push(key);
    // Return 503 twice then 200 so retries fire.
    const status = keys.length < 3 ? 503 : 200;
    return new Response('{}', {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, capturedKeys: () => [...keys] };
}

// ---------------------------------------------------------------------------
// Example A: true — UUID generated once, same key across all retry attempts.
// ---------------------------------------------------------------------------

export async function example15a(): Promise<void> {
  const { fetch, capturedKeys } = makeHeaderCapture();

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: { maxAttempts: 3, initialDelay: 0 },
    idempotencyKey: true,
  });

  await client.put('/resources/1', { json: { value: 42 } });

  const keys = capturedKeys();
  console.log(keys.length);                  // 3 — one per attempt
  console.log(keys[0] === keys[1]);           // true — same key across retries
  console.log(keys[1] === keys[2]);           // true
  console.log(keys[0].length > 0);           // true — non-empty UUID
}

// ---------------------------------------------------------------------------
// Example B: static string — caller supplies the key (e.g. from the request
// context or a database sequence).
// ---------------------------------------------------------------------------

export async function example15b(): Promise<void> {
  const { fetch, capturedKeys } = makeHeaderCapture();

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: { maxAttempts: 3, initialDelay: 0 },
    idempotencyKey: 'order-2024-05-30-00042',
  });

  await client.post('/orders', { json: { item: 'widget' } });

  const keys = capturedKeys();
  console.log(keys[0]); // 'order-2024-05-30-00042'
  console.log(keys.every((k) => k === 'order-2024-05-30-00042')); // true
}

// ---------------------------------------------------------------------------
// Example C: factory function — called ONCE, frozen for all retries.
// This is the safe pattern for dynamic keys.
// ---------------------------------------------------------------------------

export async function example15c(): Promise<void> {
  const { fetch, capturedKeys } = makeHeaderCapture();
  let factoryCalls = 0;

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: { maxAttempts: 3, initialDelay: 0 },
    idempotencyKey: () => {
      factoryCalls++;
      // In real code: derive from the operation context, not random.
      return `derived-key-${factoryCalls}`;
    },
  });

  await client.put('/resources/2', { json: { value: 99 } });

  // The factory was called exactly once, regardless of how many retries occurred.
  console.log(factoryCalls); // 1

  const keys = capturedKeys();
  // The frozen value was used on every attempt.
  console.log(keys.every((k) => k === 'derived-key-1')); // true
}

// ---------------------------------------------------------------------------
// Example D: custom header name — some providers use a different header name.
// ---------------------------------------------------------------------------

export async function example15d(): Promise<void> {
  const sentHeaders: Record<string, string>[] = [];

  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const headers = init?.headers;
    if (headers instanceof Headers) {
      const rec: Record<string, string> = {};
      headers.forEach((v, k) => { rec[k] = v; });
      sentHeaders.push(rec);
    }
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    idempotencyKey: 'my-operation-id',
    idempotencyHeader: 'X-Idempotency-Key', // custom header name
  });

  await client.post('/payments', { json: { amount: 50 } });

  console.log(sentHeaders[0]?.['x-idempotency-key']); // 'my-operation-id'
}

// ---------------------------------------------------------------------------
// Example E: onRequest hook can READ the key (set before hooks run).
// ---------------------------------------------------------------------------

export async function example15e(): Promise<void> {
  let observedKey = '';

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: async () =>
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    idempotencyKey: 'hook-visible-key',
    hooks: {
      onRequest: (ctx: HookContext) => {
        observedKey = ctx.request.headers['Idempotency-Key'] ?? '';
      },
    },
  });

  await client.post('/resource', { json: {} });
  console.log(observedKey); // 'hook-visible-key'
}
