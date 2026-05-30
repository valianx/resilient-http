/**
 * 08-retry-after.ts
 *
 * Tool: RetryOptions.respectRetryAfter + maxRetryAfter — Retry-After header handling.
 *
 * Fixed in v2.0.2: the Retry-After header is now correctly read from the error
 * object's direct headers field (ResilientHttpError exposes headers directly, not
 * nested under .response). The fix also supports both native Headers objects and
 * plain record objects produced by headersToRecord().
 *
 * Contract:
 *   - respectRetryAfter defaults to true.
 *   - The header is honoured ONLY on 429 (rate-limit) responses.
 *   - If Retry-After > maxRetryAfter (default 60 000 ms), the engine gives up
 *     instead of waiting — it does NOT retry.
 *   - Delta-seconds format: "Retry-After: 5" → wait 5 000 ms.
 *   - HTTP-date format: "Retry-After: <absolute-date>" → wait until that date.
 *   - 503 with Retry-After is NOT honoured (only 429 triggers the path).
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — emits Retry-After on 429.
// ---------------------------------------------------------------------------

function makeRateLimitFetch(
  retryAfterSeconds: number,
  responses: number[]
): {
  fetch: typeof globalThis.fetch;
  callCount: () => number;
} {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    const status = responses[calls] ?? responses[responses.length - 1];
    calls++;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (status === 429) {
      headers['Retry-After'] = String(retryAfterSeconds);
    }
    return new Response('{}', { status, headers });
  };
  return { fetch, callCount: () => calls };
}

// ---------------------------------------------------------------------------
// Example A: Retry-After respected — engine waits the indicated delay.
// The delay in onRetry will match the header value (converted to ms).
// ---------------------------------------------------------------------------

export async function example8a(): Promise<void> {
  const delays: number[] = [];

  // First call returns 429 with Retry-After: 2; second returns 200.
  const { fetch, callCount } = makeRateLimitFetch(2, [429, 200]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 2,
      maxRetryAfter: 10_000, // allow up to 10 s
      onRetry: (_err, _attempt, delay) => delays.push(delay),
    },
  });

  const res = await client.get('/data');
  console.log(res.status);   // 200
  console.log(callCount());  // 2
  console.log(delays);       // [2000]  — 2 s from the Retry-After header
}

// ---------------------------------------------------------------------------
// Example B: Retry-After exceeds maxRetryAfter — engine gives up immediately.
// ---------------------------------------------------------------------------

export async function example8b(): Promise<void> {
  const { fetch, callCount } = makeRateLimitFetch(120, [429]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 3,
      maxRetryAfter: 60_000, // default cap: 60 s
    },
  });

  let errorCaught = false;
  try {
    await client.get('/data');
  } catch {
    errorCaught = true;
  }

  // Retry-After was 120 s > 60 s cap → engine gave up after the first attempt.
  console.log(errorCaught); // true
  console.log(callCount()); // 1  — no retry was made
}

// ---------------------------------------------------------------------------
// Example C: Retry-After on a 503 is NOT honoured (only 429 triggers the path).
// ---------------------------------------------------------------------------

export async function example8c(): Promise<void> {
  const delays: number[] = [];

  // Server sends Retry-After on 503; the engine should ignore it.
  const fetch: typeof globalThis.fetch = async () =>
    new Response('{}', {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    });

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 2,
      initialDelay: 50,
      jitter: 'none',
      onRetry: (_err, _attempt, delay) => delays.push(delay),
    },
  });

  try {
    await client.get('/data');
  } catch {
    // Expected.
  }

  // Delay was NOT 60 000 ms (from the header) — normal backoff was used instead.
  console.log(delays[0] !== 60_000); // true — header ignored for 503
}

// ---------------------------------------------------------------------------
// Example D: opt out of Retry-After handling entirely.
// ---------------------------------------------------------------------------

export async function example8d(): Promise<void> {
  const delays: number[] = [];
  const { fetch } = makeRateLimitFetch(30, [429, 200]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 2,
      initialDelay: 100,
      jitter: 'none',
      respectRetryAfter: false,   // ignore Retry-After header
      onRetry: (_err, _attempt, delay) => delays.push(delay),
    },
  });

  await client.get('/data');
  // Delay was normal backoff, not the 30 s from the header.
  console.log(delays[0] !== 30_000); // true
}
