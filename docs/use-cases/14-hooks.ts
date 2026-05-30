/**
 * 14-hooks.ts
 *
 * Tool: HookSet — onRequest, onResponse, onRetry, onFailure.
 *
 * Contract:
 *   onRequest  (mutator): called BEFORE each attempt. May mutate ctx.request
 *              (url, method, headers, body). Re-runs on every retry with a fresh
 *              copy of the original request spec. Throws → abort with kind:'setup'.
 *   onResponse (mutator): called AFTER a response is received, BEFORE validateStatus.
 *              May inspect or lightly mutate ctx. Throws → abort with kind:'setup'.
 *   onRetry    (observer): called BEFORE sleeping between attempts.
 *              Signature: (error, attempt, nextDelay). Throws are silently captured.
 *   onFailure  (observer): called when the engine gives up (all attempts exhausted
 *              or a hard cap fires). Signature: (error, attempts). Throws are silently
 *              captured.
 *
 *   ctx.attempt     — 1-based attempt number.
 *   ctx.requestId   — stable across all retries for one logical operation.
 *   ctx.attemptId   — changes per attempt.
 *   ctx.elapsed     — ms since the first attempt started.
 *   ctx.meta        — arbitrary bag that persists across all attempts.
 */

import { createResilientHttp } from 'resilient-http';
import type { HookContext } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — configurable response sequence.
// ---------------------------------------------------------------------------

function makeSequenceFetch(statuses: number[]): typeof globalThis.fetch {
  let i = 0;
  return async () => {
    const status = statuses[i] ?? statuses[statuses.length - 1];
    i++;
    return new Response('{}', {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Example A: onRequest — inject a dynamic header on every attempt.
// ---------------------------------------------------------------------------

export async function example14a(): Promise<void> {
  const capturedHeaders: string[] = [];

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeSequenceFetch([200]),
    hooks: {
      onRequest: (ctx: HookContext) => {
        // Add a per-attempt correlation header.
        ctx.request.headers['X-Attempt-Id'] = ctx.attemptId;
        capturedHeaders.push(ctx.request.headers['X-Attempt-Id']);
      },
    },
  });

  await client.get('/resource');
  console.log(capturedHeaders.length); // 1
  console.log(typeof capturedHeaders[0]); // 'string'
}

// ---------------------------------------------------------------------------
// Example B: onRequest — inject an OpenTelemetry traceparent header.
// The hook runs per attempt, so each retry carries the same trace context
// (traceparent is stable for the logical operation; use ctx.requestId to
// derive a span ID that links all attempts under one trace).
// ---------------------------------------------------------------------------

export async function example14b(): Promise<void> {
  // Minimal traceparent generator (illustrative only).
  function makeTraceparent(traceId: string, spanId: string): string {
    return `00-${traceId}-${spanId}-01`;
  }

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeSequenceFetch([200]),
    hooks: {
      onRequest: (ctx: HookContext) => {
        // Use requestId as the trace ID (stable across retries).
        const traceId = ctx.requestId.replace(/-/g, '').slice(0, 32).padEnd(32, '0');
        // Use attemptId as the span ID (changes per retry).
        const spanId = ctx.attemptId.replace(/-/g, '').slice(0, 16).padEnd(16, '0');
        ctx.request.headers['traceparent'] = makeTraceparent(traceId, spanId);
      },
    },
  });

  await client.get('/traced-resource');
}

// ---------------------------------------------------------------------------
// Example C: onResponse — inspect the response before validateStatus.
// ---------------------------------------------------------------------------

export async function example14c(): Promise<void> {
  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeSequenceFetch([200]),
    hooks: {
      onResponse: (ctx: HookContext) => {
        if (ctx.response && typeof ctx.response === 'object') {
          const res = ctx.response as Response;
          // Log the status before the library makes a success/failure decision.
          console.log(`attempt ${ctx.attempt}: status=${res.status}`);
        }
      },
    },
  });

  await client.get('/resource');
}

// ---------------------------------------------------------------------------
// Example D: onRetry + onFailure — observability without side effects.
// ---------------------------------------------------------------------------

export async function example14d(): Promise<void> {
  const retryLog: Array<{ attempt: number; delay: number }> = [];
  let finalAttempts = 0;

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeSequenceFetch([503, 503, 200]),
    retry: {
      maxAttempts: 3,
      initialDelay: 0,
    },
    hooks: {
      onRetry: (_err, attempt, delay) => {
        retryLog.push({ attempt, delay });
      },
      onFailure: (_err, attempts) => {
        finalAttempts = attempts;
      },
    },
  });

  await client.get('/flaky');

  console.log(retryLog.length); // 2 — two retries before success
  console.log(finalAttempts);   // 0 — onFailure not called (succeeded)
}

// ---------------------------------------------------------------------------
// Example E: ctx.meta — carry state across attempts.
// ---------------------------------------------------------------------------

export async function example14e(): Promise<void> {
  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeSequenceFetch([503, 200]),
    retry: {
      maxAttempts: 2,
      initialDelay: 0,
    },
    hooks: {
      onRequest: (ctx: HookContext) => {
        // Record the time of the first attempt in meta.
        if (ctx.attempt === 1) {
          ctx.meta['startedAt'] = Date.now();
        }
      },
      onRetry: (_err, _attempt, _delay) => {
        // meta is readable in observers too — but observers receive
        // (error, attempt, delay), not ctx. Use the onRequest hook
        // to propagate meta state into the next attempt's headers if needed.
      },
    },
  });

  await client.get('/resource');
}
