/**
 * 19-opentelemetry-tracing.ts
 *
 * Tool: onRequest hook + ctx.requestId / ctx.attemptId.
 * Recipe: inject W3C Trace Context headers (traceparent / tracestate) per attempt.
 *
 * Contract:
 *   - onRequest runs BEFORE each attempt, including retries.
 *   - ctx.requestId is STABLE for the entire logical operation (same across retries).
 *   - ctx.attemptId CHANGES per attempt — use it as the span ID so each retry
 *     produces a distinct child span under the same trace.
 *   - This example does NOT import the OpenTelemetry SDK — the pattern is expressed
 *     using plain string manipulation so the file compiles without extra dependencies.
 *     In a real application you would use the @opentelemetry/api SpanContext to derive
 *     traceId and spanId from an active span.
 *
 * W3C traceparent format: 00-{traceId:32hex}-{spanId:16hex}-{flags:2hex}
 */

import { createResilientHttp } from 'resilient-http';
import type { HookContext } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline utilities — illustrative only, not a real OTEL SDK.
// ---------------------------------------------------------------------------

/** Derive a 32-char lowercase hex trace ID from a UUID string. */
function toTraceId(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 32).padEnd(32, '0');
}

/** Derive a 16-char lowercase hex span ID from a UUID string. */
function toSpanId(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 16).padEnd(16, '0');
}

/** Build a W3C traceparent header value (sampled flag = 01). */
function buildTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

// ---------------------------------------------------------------------------
// Inline fetch mock — captures headers sent on each attempt.
// ---------------------------------------------------------------------------

function makeCaptureTraceFetch(responses: number[]): {
  fetch: typeof globalThis.fetch;
  capturedTraceparents: () => string[];
} {
  let i = 0;
  const captured: string[] = [];

  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const headers = init?.headers;
    let tp = '';
    if (headers instanceof Headers) {
      tp = headers.get('traceparent') ?? '';
    } else if (headers && typeof headers === 'object') {
      tp = (headers as Record<string, string>)['traceparent'] ?? '';
    }
    captured.push(tp);

    const status = responses[i] ?? responses[responses.length - 1];
    i++;
    return new Response('{}', {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { fetch, capturedTraceparents: () => [...captured] };
}

// ---------------------------------------------------------------------------
// Example A: each attempt carries a distinct spanId, same traceId.
// ---------------------------------------------------------------------------

export async function example19a(): Promise<void> {
  // Return 503 once then 200 so a retry fires.
  const { fetch, capturedTraceparents } = makeCaptureTraceFetch([503, 200]);

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: {
      maxAttempts: 2,
      initialDelay: 0,
    },
    hooks: {
      onRequest: (ctx: HookContext) => {
        const traceId = toTraceId(ctx.requestId);
        const spanId  = toSpanId(ctx.attemptId);
        ctx.request.headers['traceparent'] = buildTraceparent(traceId, spanId);
      },
    },
  });

  await client.get('/traced-endpoint');

  const tps = capturedTraceparents();
  console.log(tps.length); // 2 — one per attempt

  // Both attempts belong to the same trace.
  const traceId0 = tps[0].split('-')[1];
  const traceId1 = tps[1].split('-')[1];
  console.log(traceId0 === traceId1); // true — same logical operation

  // But each attempt has a distinct span.
  const spanId0 = tps[0].split('-')[2];
  const spanId1 = tps[1].split('-')[2];
  console.log(spanId0 !== spanId1); // true — distinct attempt spans
}

// ---------------------------------------------------------------------------
// Example B: also propagate tracestate and a custom X-Request-Id header.
// ---------------------------------------------------------------------------

export async function example19b(): Promise<void> {
  const capturedHeaders: Record<string, string>[] = [];

  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const headers = init?.headers;
    const rec: Record<string, string> = {};
    if (headers instanceof Headers) {
      headers.forEach((v, k) => { rec[k] = v; });
    } else if (headers && typeof headers === 'object') {
      Object.assign(rec, headers as Record<string, string>);
    }
    capturedHeaders.push(rec);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    hooks: {
      onRequest: (ctx: HookContext) => {
        const traceId = toTraceId(ctx.requestId);
        const spanId  = toSpanId(ctx.attemptId);

        ctx.request.headers['traceparent'] = buildTraceparent(traceId, spanId);
        // tracestate carries vendor-specific trace context (e.g. Datadog, Zipkin).
        ctx.request.headers['tracestate']  = `myapp=00f067aa0ba902b7`;
        // Stable request correlation ID for log correlation outside OTEL.
        ctx.request.headers['X-Request-Id'] = ctx.requestId;
      },
    },
  });

  await client.get('/multi-header-trace');

  const h = capturedHeaders[0];
  console.log(h?.['traceparent']?.startsWith('00-'));  // true
  console.log(h?.['tracestate']);                       // 'myapp=00f067aa0ba902b7'
  console.log(h?.['x-request-id']?.length > 0);        // true
}
