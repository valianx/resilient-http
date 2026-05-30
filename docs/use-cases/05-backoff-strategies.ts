/**
 * 05-backoff-strategies.ts
 *
 * Tool: RetryOptions.backoff — backoff strategy selection.
 *
 * Formulas (before jitter is applied):
 *   exponential : delay = min(initialDelay * multiplier^attempt, maxDelay)
 *                 attempt is 0-based (first retry uses attempt 0).
 *                 Defaults: initialDelay=1000, multiplier=2, maxDelay=30000.
 *                 Example: 1000, 2000, 4000, 8000, …, capped at 30000.
 *
 *   linear      : delay = min(initialDelay + multiplier * attempt * initialDelay, maxDelay)
 *                 Example (multiplier=1): 1000, 2000, 3000, 4000, …
 *
 *   constant    : delay = initialDelay  (flat, ignores multiplier)
 *
 * Note: jitter is applied AFTER backoff. Use jitter:'none' to observe raw delays.
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — always returns 503 so retries fire every time.
// ---------------------------------------------------------------------------

function alwaysFailing(): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify({ error: 'down' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
}

// ---------------------------------------------------------------------------
// Example A: exponential backoff (default).
// ---------------------------------------------------------------------------

export async function example5a(): Promise<void> {
  const delays: number[] = [];

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: alwaysFailing(),
    retry: {
      maxAttempts: 4,
      backoff: 'exponential',
      initialDelay: 100,
      multiplier: 2,
      maxDelay: 30000,
      jitter: 'none',       // disable jitter to observe raw backoff values
      onRetry: (_err, _attempt, delay) => delays.push(delay),
    },
  });

  try {
    await client.get('/health');
  } catch {
    // Expected after 4 attempts.
  }

  // Attempt 0 (first retry): 100 * 2^0 = 100 ms
  // Attempt 1:               100 * 2^1 = 200 ms
  // Attempt 2:               100 * 2^2 = 400 ms
  console.log(delays); // [100, 200, 400]
}

// ---------------------------------------------------------------------------
// Example B: linear backoff.
// ---------------------------------------------------------------------------

export async function example5b(): Promise<void> {
  const delays: number[] = [];

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: alwaysFailing(),
    retry: {
      maxAttempts: 4,
      backoff: 'linear',
      initialDelay: 100,
      multiplier: 1,
      maxDelay: 30000,
      jitter: 'none',
      onRetry: (_err, _attempt, delay) => delays.push(delay),
    },
  });

  try {
    await client.get('/health');
  } catch {
    // Expected.
  }

  // linear: initialDelay + multiplier * attempt * initialDelay
  // attempt 0: 100 + 1*0*100 = 100
  // attempt 1: 100 + 1*1*100 = 200
  // attempt 2: 100 + 1*2*100 = 300
  console.log(delays); // [100, 200, 300]
}

// ---------------------------------------------------------------------------
// Example C: constant backoff.
// ---------------------------------------------------------------------------

export async function example5c(): Promise<void> {
  const delays: number[] = [];

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: alwaysFailing(),
    retry: {
      maxAttempts: 4,
      backoff: 'constant',
      initialDelay: 250,
      jitter: 'none',
      onRetry: (_err, _attempt, delay) => delays.push(delay),
    },
  });

  try {
    await client.get('/health');
  } catch {
    // Expected.
  }

  console.log(delays); // [250, 250, 250]
}
