/**
 * 28-bff-proxy.ts
 *
 * Tool: createResilientHttp + redactHeaders + isResilientHttpError + toJSON().
 * Recipe: Backend-For-Frontend (BFF) proxy — call an upstream API, sanitize the
 *         error before returning it to an untrusted client.
 *
 * Contract:
 *   - The BFF sits between a browser/mobile client and internal microservices.
 *     It must NEVER leak upstream error details (stack traces, internal URLs,
 *     auth tokens, server-side headers) to the browser.
 *   - toJSON() is safe by default: it omits body, cause, and meta.
 *   - redactHeaders removes sensitive response headers from toJSON() output.
 *   - The BFF shapes a small, sanitized error object: { code, message } only.
 *   - This example uses a framework-agnostic Request/Response interface so it
 *     compiles without framework dependencies (Next.js, Fastify, Express, etc.).
 *     In a real BFF you would return the sanitized body via your framework's
 *     response helper.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — simulates the upstream internal API.
// ---------------------------------------------------------------------------

type UpstreamState = 'ok' | 'server-error' | 'rate-limited';

function makeUpstreamFetch(state: UpstreamState): typeof globalThis.fetch {
  return async () => {
    if (state === 'ok') {
      return new Response(JSON.stringify({ userId: 42, email: 'user@example.com' }), {
        status: 200,
        headers: {
          'Content-Type':     'application/json',
          'X-Internal-Token': 'secret-token',   // must NOT reach the browser
        },
      });
    }

    if (state === 'rate-limited') {
      return new Response('{}', { status: 429, headers: { 'Retry-After': '5' } });
    }

    return new Response(JSON.stringify({ trace: 'long internal stack trace' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': 'internal-req-9f3a',    // internal correlation, keep for logs only
      },
    });
  };
}

// ---------------------------------------------------------------------------
// BFF proxy result — what the handler returns to the caller.
// ---------------------------------------------------------------------------

interface ProxyResult {
  status: number;
  body: unknown;
}

// ---------------------------------------------------------------------------
// The BFF proxy handler — safe to call from any server-side route handler.
// ---------------------------------------------------------------------------

function buildBffClient(fetchImpl?: typeof globalThis.fetch) {
  return createResilientHttp({
    baseURL: 'https://internal-api.example.internal',
    fetch: fetchImpl,
    retry: {
      maxAttempts: 3,
      initialDelay: 100,
      jitter: 'full',
    },
    // Redact internal headers so they never appear in toJSON() error output.
    redactHeaders: ['x-internal-token', 'authorization', 'cookie'],
  });
}

async function proxyUserRequest(
  userId: string,
  fetchImpl?: typeof globalThis.fetch,
): Promise<ProxyResult> {
  const client = buildBffClient(fetchImpl);

  try {
    const { data, status } = await client.get(`/users/${userId}`);
    return { status, body: data };
  } catch (err) {
    if (isResilientHttpError(err)) {
      // toJSON() already omits body, cause, meta, and redacted headers.
      // We further restrict to ONLY code + message for the browser.
      const safe = {
        code:    err.classification,
        message: mapClassificationToMessage(err.classification),
      };

      const httpStatus = mapClassificationToStatus(err.classification);
      return { status: httpStatus, body: safe };
    }

    // Unknown error — return a generic 500 without any internal detail.
    return { status: 500, body: { code: 'unknown', message: 'An unexpected error occurred.' } };
  }
}

function mapClassificationToMessage(
  c: ReturnType<typeof isResilientHttpError extends true ? never : never> extends never
    ? string
    : string,
): string {
  const messages: Record<string, string> = {
    'rate-limit':     'Too many requests. Please try again later.',
    'server':         'The service is temporarily unavailable.',
    'timeout':        'The request timed out. Please try again.',
    'network':        'A network error occurred. Please check your connection.',
    'authentication': 'You are not authorised to access this resource.',
    'not-found':      'The requested resource was not found.',
  };
  return messages[c] ?? 'An error occurred. Please try again.';
}

function mapClassificationToStatus(c: string): number {
  const map: Record<string, number> = {
    'rate-limit':     429,
    'server':         502,
    'timeout':        504,
    'network':        503,
    'authentication': 401,
    'not-found':      404,
    'client':         400,
    'validation':     422,
  };
  return map[c] ?? 500;
}

// ---------------------------------------------------------------------------
// Example A: upstream returns 200 — proxy forwards the data.
// ---------------------------------------------------------------------------

export async function example28a(): Promise<void> {
  const result = await proxyUserRequest('42', makeUpstreamFetch('ok'));

  console.log(result.status);                          // 200
  console.log((result.body as { userId: number }).userId); // 42
}

// ---------------------------------------------------------------------------
// Example B: upstream returns 500 — browser receives a sanitized error only.
// ---------------------------------------------------------------------------

export async function example28b(): Promise<void> {
  const result = await proxyUserRequest('42', makeUpstreamFetch('server-error'));

  console.log(result.status);                         // 502
  const body = result.body as { code: string; message: string };
  console.log(body.code);                              // 'server'
  console.log(body.message.includes('unavailable'));   // true
  // Internal stack trace or X-Internal-Token NEVER appear in the response.
}

// ---------------------------------------------------------------------------
// Example C: rate-limited upstream — browser receives a 429 with guidance.
// ---------------------------------------------------------------------------

export async function example28c(): Promise<void> {
  const result = await proxyUserRequest('42', makeUpstreamFetch('rate-limited'));

  console.log(result.status); // 429
  const body = result.body as { code: string };
  console.log(body.code);     // 'rate-limit'
}
