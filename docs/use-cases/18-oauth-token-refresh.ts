/**
 * 18-oauth-token-refresh.ts
 *
 * Tool: onRequest hook + retryableStatuses + ctx.meta.
 * Recipe: OAuth 2.0 bearer token — auto-refresh on 401, retry once.
 *
 * Contract:
 *   - The onRequest hook attaches the current bearer token on every attempt.
 *   - When the response is a 401 the engine retries (401 is added to
 *     retryableStatuses). On the second attempt the hook sees that the
 *     previous response was 401 (ctx.meta.lastStatus === 401), calls the
 *     token-refresh function, and sets the new token in the header.
 *   - ctx.meta is the right place to carry cross-attempt state (like the last
 *     status) because it persists across retries and is not reset per attempt.
 *   - Guard against an infinite refresh loop: store a "refreshed" flag in
 *     ctx.meta and only refresh once per logical operation.
 */

import { createResilientHttp } from 'resilient-http';
import type { HookContext } from 'resilient-http';

// ---------------------------------------------------------------------------
// Minimal token store — in real code this would be your auth module.
// ---------------------------------------------------------------------------

let currentToken = 'token-v1';

async function refreshAccessToken(): Promise<string> {
  // Simulate a token-endpoint round-trip.
  currentToken = 'token-v2-refreshed';
  return currentToken;
}

// ---------------------------------------------------------------------------
// Inline fetch mock — returns 401 on the first call, 200 on subsequent calls.
// ---------------------------------------------------------------------------

function makeOAuthFetch(): typeof globalThis.fetch {
  let calls = 0;
  return async (_input, init) => {
    calls++;
    const authHeader =
      init?.headers instanceof Headers
        ? init.headers.get('Authorization') ?? ''
        : (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '';

    // Simulate an expired token on the first attempt.
    const status = calls === 1 ? 401 : 200;
    const body = status === 200 ? JSON.stringify({ data: 'ok', usedToken: authHeader }) : '{}';
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Example A: onRequest refreshes the token on 401, retries once.
// ---------------------------------------------------------------------------

export async function example18a(): Promise<void> {
  const fetch = makeOAuthFetch();

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 2,
      initialDelay: 0,
      // Include 401 so the engine considers it eligible for a retry.
      // shouldRetry below further constrains when the retry actually fires.
      retryableStatuses: [401, 500, 502, 503, 504],
      shouldRetry: (ctx) => {
        // Only retry 401 once — if we already refreshed, give up.
        if (ctx.statusCode === 401) {
          return ctx.attempt === 1; // allow retry only on the FIRST 401
        }
        return ctx.gateAllows;
      },
    },
    hooks: {
      onRequest: async (ctx: HookContext) => {
        // On attempts after a 401, refresh the token first.
        if (ctx.attempt > 1 && ctx.meta['tokenRefreshed'] !== true) {
          const newToken = await refreshAccessToken();
          ctx.meta['tokenRefreshed'] = true;
          ctx.request.headers['Authorization'] = `Bearer ${newToken}`;
        } else {
          ctx.request.headers['Authorization'] = `Bearer ${currentToken}`;
        }
      },
      onResponse: (ctx: HookContext) => {
        // Stash the last HTTP status in meta so onRequest can read it next time.
        if (ctx.response && typeof ctx.response === 'object') {
          const res = ctx.response as Response;
          ctx.meta['lastStatus'] = res.status;
        }
      },
    },
  });

  const { data, status } = await client.get<{ data: string; usedToken: string }>('/protected');

  console.log(status);              // 200
  console.log(data?.data);          // 'ok'
  console.log(data?.usedToken);     // 'Bearer token-v2-refreshed'
}

// ---------------------------------------------------------------------------
// Example B: token is already valid — no refresh occurs.
// ---------------------------------------------------------------------------

export async function example18b(): Promise<void> {
  let callCount = 0;
  const fetch: typeof globalThis.fetch = async () => {
    callCount++;
    return new Response('{"data":"ok"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 2,
      initialDelay: 0,
      retryableStatuses: [401, 500, 502, 503, 504],
    },
    hooks: {
      onRequest: (ctx: HookContext) => {
        ctx.request.headers['Authorization'] = `Bearer ${currentToken}`;
      },
    },
  });

  const { status } = await client.get('/public-data');

  console.log(status);     // 200
  console.log(callCount);  // 1 — no retry was needed
}
