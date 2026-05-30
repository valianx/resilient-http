/**
 * 04-retry-and-method-gate.ts
 *
 * Tool: RetryOptions.maxAttempts + the built-in method gate.
 *
 * Contract:
 *   - maxAttempts defaults to 1 (no retries). Callers must opt in.
 *   - Default retryable methods: GET HEAD PUT DELETE OPTIONS.
 *   - POST is excluded by default. This is a tool to avoid dangerous retries
 *     on non-idempotent operations — the developer decides whether to opt in.
 *   - To retry POST: pass retryableMethods: ['GET','HEAD','PUT','DELETE','OPTIONS','POST'].
 *   - retryableStatuses defaults to [408, 429, 500, 502, 503, 504].
 *   - Unknown method (no method info available) → no retry (fail-safe).
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — returns a configurable status for each call.
// ---------------------------------------------------------------------------

function makeCountingFetch(responses: number[]): {
  fetch: typeof globalThis.fetch;
  callCount: () => number;
} {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    const status = responses[calls] ?? responses[responses.length - 1];
    calls++;
    return new Response(JSON.stringify({ error: 'transient' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, callCount: () => calls };
}

// ---------------------------------------------------------------------------
// Example A: GET retries on 503 (default gate allows it).
// ---------------------------------------------------------------------------

export async function example4a(): Promise<void> {
  // Two 503s then success.
  const { fetch, callCount } = makeCountingFetch([503, 503, 200]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: { maxAttempts: 3, initialDelay: 0 },
  });

  const res = await client.get('/status');
  console.log(res.status);      // 200
  console.log(callCount());     // 3 — two retries were made
}

// ---------------------------------------------------------------------------
// Example B: POST does NOT retry by default (method gate blocks it).
// The library provides the gate as a tool — the developer controls retries.
// ---------------------------------------------------------------------------

export async function example4b(): Promise<void> {
  // All responses are 503 — if retry happened we would see callCount > 1.
  const { fetch, callCount } = makeCountingFetch([503]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: { maxAttempts: 3, initialDelay: 0 },
  });

  try {
    await client.post('/orders', { json: { item: 'widget' } });
  } catch {
    // Expected: POST is not in the default retryable methods.
  }

  console.log(callCount()); // 1 — no retry was attempted for POST
}

// ---------------------------------------------------------------------------
// Example C: Explicit opt-in to retry POST when the developer knows the
// operation is safe to repeat (e.g. the endpoint is idempotent by design).
// ---------------------------------------------------------------------------

export async function example4c(): Promise<void> {
  const { fetch, callCount } = makeCountingFetch([503, 503, 200]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 3,
      initialDelay: 0,
      // Developer opts POST in after verifying the operation is safe to repeat.
      retryableMethods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'POST'],
    },
  });

  const res = await client.post('/idempotent-resource', { json: {} });
  console.log(res.status);   // 200
  console.log(callCount());  // 3
}
