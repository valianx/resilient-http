/**
 * 06-jitter.ts
 *
 * Tool: RetryOptions.jitter — jitter strategy selection.
 *
 * Strategies:
 *   'full'         : random(0, baseDelay)     — maximum spread (AWS recommended).
 *   'equal'        : baseDelay/2 + random(0, baseDelay/2) — 50% floor + 50% random.
 *   'decorrelated' : random(initialDelay, previousDelay * 3), capped at maxDelay.
 *                    Each delay is derived from the previous one.
 *   'none'         : no jitter — raw backoff value is used as-is.
 *
 * Default: 'full'.
 *
 * Purpose: spreading retry storms across many clients so they do not all
 * hammer the server at the same instant (thundering herd).
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — always 503 so retries fire on every attempt.
// ---------------------------------------------------------------------------

function alwaysFailing(): typeof globalThis.fetch {
  return async () =>
    new Response('{}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
}

// ---------------------------------------------------------------------------
// Shared helper: collect the actual delays reported by onRetry.
// ---------------------------------------------------------------------------

async function collectDelays(
  jitter: 'full' | 'equal' | 'decorrelated' | 'none'
): Promise<number[]> {
  const delays: number[] = [];

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: alwaysFailing(),
    retry: {
      maxAttempts: 4,
      backoff: 'exponential',
      initialDelay: 1000,
      multiplier: 2,
      maxDelay: 30000,
      jitter,
      onRetry: (_err, _attempt, delay) => delays.push(delay),
    },
  });

  try {
    await client.get('/health');
  } catch {
    // Expected — engine exhausted all attempts.
  }

  return delays;
}

// ---------------------------------------------------------------------------
// Example A: full jitter — each delay is between 0 and the raw backoff value.
// ---------------------------------------------------------------------------

export async function example6a(): Promise<void> {
  const delays = await collectDelays('full');

  // All delays are >= 0 and <= the corresponding raw backoff value.
  // The precise values are random; we assert the bounds.
  const rawBackoffs = [1000, 2000, 4000]; // exponential, multiplier=2

  for (let i = 0; i < delays.length; i++) {
    const d = delays[i];
    console.assert(d >= 0 && d <= rawBackoffs[i], `delay ${d} out of [0, ${rawBackoffs[i]}]`);
  }

  console.log('full jitter delays (random sample):', delays);
}

// ---------------------------------------------------------------------------
// Example B: equal jitter — each delay is between half and full backoff value.
// ---------------------------------------------------------------------------

export async function example6b(): Promise<void> {
  const delays = await collectDelays('equal');
  const rawBackoffs = [1000, 2000, 4000];

  for (let i = 0; i < delays.length; i++) {
    const half = Math.floor(rawBackoffs[i] / 2);
    const d = delays[i];
    console.assert(d >= half && d <= rawBackoffs[i], `delay ${d} out of [${half}, ${rawBackoffs[i]}]`);
  }

  console.log('equal jitter delays (predictable floor):', delays);
}

// ---------------------------------------------------------------------------
// Example C: decorrelated jitter — each delay depends on the previous one.
// ---------------------------------------------------------------------------

export async function example6c(): Promise<void> {
  const delays = await collectDelays('decorrelated');

  // Decorrelated: delay_n = random(initialDelay, previousDelay * 3)
  // Values should stay within [initialDelay, maxDelay].
  for (const d of delays) {
    console.assert(d >= 0 && d <= 30000, `delay ${d} out of [0, 30000]`);
  }

  console.log('decorrelated jitter delays:', delays);
}

// ---------------------------------------------------------------------------
// Example D: no jitter — deterministic delays for testing or controlled envs.
// ---------------------------------------------------------------------------

export async function example6d(): Promise<void> {
  const delays = await collectDelays('none');

  // No randomness — raw exponential values.
  console.log(delays); // [1000, 2000, 4000]
}
