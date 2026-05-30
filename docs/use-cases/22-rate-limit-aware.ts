/**
 * 22-rate-limit-aware.ts
 *
 * Tool: respectRetryAfter + maxRetryAfter + retryableStatuses.
 * Recipe: handle 429 Too Many Requests with server-driven back-pressure.
 *
 * Contract:
 *   - respectRetryAfter (default: true) — when the upstream sends a 429 with a
 *     Retry-After header, the engine waits that many seconds before the next attempt.
 *   - maxRetryAfter — cap in milliseconds. If the server asks for a longer wait
 *     than this value the engine gives up immediately (throws) rather than blocking
 *     for an unbounded duration.
 *   - 429 is in the default retryableStatuses list, so no extra configuration is
 *     needed to enable retrying on rate-limit responses.
 *   - The classification for 429 errors is 'rate-limit'.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — returns 429 with Retry-After then 200.
// ---------------------------------------------------------------------------

function makeRateLimitFetch(retryAfterSeconds: number): typeof globalThis.fetch {
  let calls = 0;
  return async () => {
    calls++;
    if (calls === 1) {
      return new Response('{"error":"rate limited"}', {
        status: 429,
        headers: {
          'Content-Type':  'application/json',
          'Retry-After':   String(retryAfterSeconds),
        },
      });
    }
    return new Response('{"result":"ok"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Example A: engine honours Retry-After and retries successfully.
// ---------------------------------------------------------------------------

export async function example22a(): Promise<void> {
  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeRateLimitFetch(0), // Retry-After: 0 — retry immediately
    retry: {
      maxAttempts: 2,
      respectRetryAfter: true,      // default, shown explicitly for clarity
      maxRetryAfter: 5_000,         // give up if server asks > 5 s
    },
  });

  const { data, status } = await client.get<{ result: string }>('/rate-limited-resource');

  console.log(status);        // 200
  console.log(data?.result);  // 'ok'
}

// ---------------------------------------------------------------------------
// Example B: server demands a wait longer than maxRetryAfter — engine gives up.
// ---------------------------------------------------------------------------

export async function example22b(): Promise<void> {
  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    // Server says: wait 60 seconds (60 s > maxRetryAfter cap).
    fetch: makeRateLimitFetch(60),
    retry: {
      maxAttempts: 3,
      respectRetryAfter: true,
      maxRetryAfter: 5_000, // cap at 5 s — 60 s exceeds it
    },
  });

  try {
    await client.get('/expensive-resource');
  } catch (err) {
    if (isResilientHttpError(err)) {
      console.log(err.statusCode);      // 429
      console.log(err.classification);  // 'rate-limit'
      console.log(err.isRetryable);     // false — engine gave up due to maxRetryAfter
    }
  }
}

// ---------------------------------------------------------------------------
// Example C: shouldRetry gate — only retry rate-limits on idempotent methods.
// ---------------------------------------------------------------------------

export async function example22c(): Promise<void> {
  const fetch = makeRateLimitFetch(0);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 2,
      initialDelay: 0,
      respectRetryAfter: true,
      maxRetryAfter: 2_000,
      shouldRetry: (ctx) => {
        // Never retry a 429 on a POST — the consumer must decide if it is safe.
        if (ctx.statusCode === 429 && ctx.method === 'POST') return false;
        return ctx.gateAllows;
      },
    },
  });

  // GET is retried.
  const { status } = await client.get('/limited');
  console.log(status); // 200

  // POST on a fresh 429 fetch — not retried.
  const fetch2 = makeRateLimitFetch(0);
  const client2 = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: fetch2,
    retry: {
      maxAttempts: 2,
      initialDelay: 0,
      retryableMethods: ['GET', 'HEAD', 'PUT', 'DELETE', 'POST'], // allow POST for demo
      shouldRetry: (ctx) => {
        if (ctx.statusCode === 429 && ctx.method === 'POST') return false;
        return ctx.gateAllows;
      },
    },
  });

  try {
    await client2.post('/limited', { json: {} });
  } catch (err) {
    if (isResilientHttpError(err)) {
      console.log(err.statusCode);     // 429
      console.log(err.classification); // 'rate-limit'
    }
  }
}
