/**
 * 07-should-retry.ts
 *
 * Tool: RetryOptions.shouldRetry — custom retry gate.
 *
 * Contract:
 *   - shouldRetry(ctx: RetryHookContext) => boolean | Promise<boolean>
 *   - Called AFTER the built-in gate (method + status classification).
 *   - ctx.gateAllows: true when the built-in gate would permit a retry.
 *   - Returning false stops retries; returning true allows them.
 *   - FAIL-CLOSED: if shouldRetry throws, the engine does NOT retry and
 *     re-throws the ORIGINAL operation error (not the callback error).
 *   - shouldRetry cannot override maxAttempts or deadline hard caps.
 *
 * RetryHookContext fields:
 *   error      — the error thrown by the most recent attempt
 *   attempt    — 1-based attempt number that just failed
 *   statusCode — HTTP status if available
 *   method     — HTTP method (upper-cased)
 *   gateAllows — whether the built-in gate would allow a retry
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';
import type { RetryHookContext } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — configurable response sequence.
// ---------------------------------------------------------------------------

function makeSequenceFetch(responses: Array<{ status: number }>): {
  fetch: typeof globalThis.fetch;
  callCount: () => number;
} {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    const spec = responses[calls] ?? responses[responses.length - 1];
    calls++;
    return new Response('{}', {
      status: spec.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, callCount: () => calls };
}

// ---------------------------------------------------------------------------
// Example A: custom gate — only retry on 503, not on 500.
// ---------------------------------------------------------------------------

export async function example7a(): Promise<void> {
  const { fetch, callCount } = makeSequenceFetch([{ status: 500 }]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 3,
      initialDelay: 0,
      shouldRetry: (ctx: RetryHookContext) => {
        // Only retry when the server returned exactly 503.
        return ctx.statusCode === 503;
      },
    },
  });

  try {
    await client.get('/resource');
  } catch {
    // Expected — 500 is rejected by the custom gate.
  }

  console.log(callCount()); // 1 — no retry (gate returned false for 500)
}

// ---------------------------------------------------------------------------
// Example B: fail-closed — if shouldRetry throws, engine stops retrying
// and re-throws the original operation error.
// ---------------------------------------------------------------------------

export async function example7b(): Promise<void> {
  const { fetch, callCount } = makeSequenceFetch([{ status: 503 }]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 3,
      initialDelay: 0,
      shouldRetry: (_ctx: RetryHookContext) => {
        // Simulate a buggy gate that throws unexpectedly.
        throw new Error('gate exploded');
      },
    },
  });

  let caughtError: unknown;
  try {
    await client.get('/resource');
  } catch (err) {
    caughtError = err;
  }

  // Fail-closed: the engine did not retry and re-threw the ORIGINAL 503 error.
  if (isResilientHttpError(caughtError)) {
    console.log(caughtError.statusCode);     // 503
    console.log(caughtError.classification); // 'server'
  }
  console.log(callCount()); // 1 — no retry attempted
}

// ---------------------------------------------------------------------------
// Example C: async shouldRetry — consult a feature flag or rate-limit store.
// ---------------------------------------------------------------------------

export async function example7c(): Promise<void> {
  let allowRetry = true;
  const { fetch, callCount } = makeSequenceFetch([{ status: 503 }, { status: 200 }]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 3,
      initialDelay: 0,
      shouldRetry: async (_ctx: RetryHookContext): Promise<boolean> => {
        // Could check a circuit-breaker state, feature flag, or budget.
        return allowRetry;
      },
    },
  });

  const res = await client.get('/resource');
  console.log(res.status);   // 200
  console.log(callCount());  // 2

  // Turn off retries externally.
  allowRetry = false;
}
