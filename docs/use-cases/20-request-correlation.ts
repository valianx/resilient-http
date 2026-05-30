/**
 * 20-request-correlation.ts
 *
 * Tool: onRequest hook + ctx.requestId / ctx.attemptId + onRetry / onFailure.
 * Recipe: propagate X-Request-Id across all retry attempts and log it in observers.
 *
 * Contract:
 *   - ctx.requestId is stable for the entire logical operation (unchanged across retries).
 *   - ctx.attemptId changes per attempt and is a good candidate for a per-hop trace ID.
 *   - Attaching ctx.requestId as X-Request-Id lets the upstream service correlate all
 *     retry attempts of the same logical request in its own logs.
 *   - onRetry and onFailure receive (error, attempt, nextDelay) — they do not receive ctx
 *     directly. Store the requestId in a closure if you need it in the observers.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';
import type { HookContext } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — returns 503 twice then 200.
// ---------------------------------------------------------------------------

function makeFlaky(succeedAfter: number): typeof globalThis.fetch {
  let calls = 0;
  return async () => {
    calls++;
    const status = calls <= succeedAfter ? 503 : 200;
    return new Response('{}', {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Example A: correlate retry log entries by requestId.
// ---------------------------------------------------------------------------

export async function example20a(): Promise<void> {
  // Capture what the hook puts in the header so we can verify it.
  const sentRequestIds: string[] = [];
  const retryLog: Array<{ attempt: number; requestId: string }> = [];

  let operationRequestId = ''; // set from the first onRequest call

  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const headers = init?.headers;
    let rid = '';
    if (headers instanceof Headers) {
      rid = headers.get('X-Request-Id') ?? '';
    } else if (headers && typeof headers === 'object') {
      rid = (headers as Record<string, string>)['X-Request-Id'] ?? '';
    }
    sentRequestIds.push(rid);
    const status = sentRequestIds.length <= 2 ? 503 : 200;
    return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
  };

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 3,
      initialDelay: 0,
      onRetry: (_err, attempt, _delay) => {
        retryLog.push({ attempt, requestId: operationRequestId });
        console.log(`[retry] attempt=${attempt} requestId=${operationRequestId}`);
      },
    },
    hooks: {
      onRequest: (ctx: HookContext) => {
        // Capture the stable requestId on the first attempt so observers can use it.
        if (ctx.attempt === 1) {
          operationRequestId = ctx.requestId;
        }
        ctx.request.headers['X-Request-Id']   = ctx.requestId;
        ctx.request.headers['X-Attempt-Id']   = ctx.attemptId;
      },
    },
  });

  await client.get('/flaky-endpoint');

  // All three attempts sent the same X-Request-Id.
  const unique = new Set(sentRequestIds);
  console.log(unique.size);                     // 1 — same ID across all attempts
  console.log(sentRequestIds.length);           // 3 — three attempts total
  console.log(retryLog.length);                 // 2 — two retries were logged
  console.log(retryLog[0].requestId.length > 0); // true
}

// ---------------------------------------------------------------------------
// Example B: log the requestId in onFailure when all attempts are exhausted.
// ---------------------------------------------------------------------------

export async function example20b(): Promise<void> {
  let failureRequestId = '';
  let failureAttempts  = 0;

  let operationId = '';

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeFlaky(0), // always returns 503
    retry: {
      maxAttempts: 2,
      initialDelay: 0,
      onFailure: (_err, attempts) => {
        failureRequestId = operationId;
        failureAttempts  = attempts;
        console.log(`[failure] all ${attempts} attempts failed. requestId=${operationId}`);
      },
    },
    hooks: {
      onRequest: (ctx: HookContext) => {
        if (ctx.attempt === 1) operationId = ctx.requestId;
        ctx.request.headers['X-Request-Id'] = ctx.requestId;
      },
    },
  });

  try {
    await client.get('/always-down');
  } catch (err) {
    if (isResilientHttpError(err)) {
      console.log(err.classification); // 'server'
    }
  }

  console.log(failureAttempts > 0);             // true
  console.log(failureRequestId.length > 0);     // true
}
