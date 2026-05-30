/**
 * 12-errors.ts
 *
 * Tool: ResilientHttpError + isResilientHttpError.
 *
 * Contract:
 *   Three error kinds (ErrorKind):
 *     'response' — server returned a non-2xx HTTP response.
 *     'network'  — fetch itself rejected (ECONNREFUSED, abort, timeout, etc.).
 *     'setup'    — error constructing the request before any network activity.
 *
 *   Classification (ErrorClassification):
 *     'network' | 'timeout' | 'server' | 'rate-limit' | 'client' |
 *     'authentication' | 'not-found' | 'validation' | 'cancelled' | 'unknown'
 *
 *   isResilientHttpError(e): type guard — use this, NOT instanceof.
 *     Reason: brand survives duplicate module installations; instanceof does not.
 *
 *   toJSON(): safe-by-default serialisation. Excludes body, cause, meta.
 *     Includes: name, kind, message, classification, isRetryable, attempts,
 *               statusCode?, method?, url?, code?, requestId?, attemptId?, headers?.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';
import type { ErrorClassification } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mocks.
// ---------------------------------------------------------------------------

function serverError(status: number, body = '{}'): typeof globalThis.fetch {
  return async () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

function networkError(code: string): typeof globalThis.fetch {
  return async () => {
    const err = new Error('Network failure') as Error & { code: string };
    err.code = code;
    throw err;
  };
}

// ---------------------------------------------------------------------------
// Example A: kind 'response' — HTTP error from the server.
// ---------------------------------------------------------------------------

export async function example12a(): Promise<void> {
  const client = createResilientHttp({
    fetch: serverError(404, '{"detail":"not found"}'),
  });

  try {
    await client.get('https://api.example.com/missing');
  } catch (err) {
    if (!isResilientHttpError(err)) return;

    console.log(err.kind);           // 'response'
    console.log(err.statusCode);     // 404
    console.log(err.classification); // 'not-found'
    console.log(err.isRetryable);    // false  (404 is not retryable)
    console.log(err.attempts);       // 1
  }
}

// ---------------------------------------------------------------------------
// Example B: kind 'response' — 500 server error (retryable).
// ---------------------------------------------------------------------------

export async function example12b(): Promise<void> {
  const client = createResilientHttp({
    fetch: serverError(500, '{"message":"Internal Server Error"}'),
  });

  try {
    await client.get('https://api.example.com/resource');
  } catch (err) {
    if (!isResilientHttpError(err)) return;

    console.log(err.kind);           // 'response'
    console.log(err.classification); // 'server'
    console.log(err.isRetryable);    // true
  }
}

// ---------------------------------------------------------------------------
// Example C: kind 'network' — connection refused.
// ---------------------------------------------------------------------------

export async function example12c(): Promise<void> {
  const client = createResilientHttp({
    fetch: networkError('ECONNREFUSED'),
  });

  try {
    await client.get('https://api.example.com/data');
  } catch (err) {
    if (!isResilientHttpError(err)) return;

    console.log(err.kind);           // 'network'
    console.log(err.code);           // 'ECONNREFUSED'
    console.log(err.classification); // 'network'
    console.log(err.isRetryable);    // true
  }
}

// ---------------------------------------------------------------------------
// Example D: classification table — quick reference.
// ---------------------------------------------------------------------------

export async function example12d(): Promise<void> {
  const table: Array<[number | undefined, string | undefined, ErrorClassification]> = [
    [429, undefined, 'rate-limit'],
    [401, undefined, 'authentication'],
    [403, undefined, 'authentication'],
    [404, undefined, 'not-found'],
    [400, undefined, 'validation'],
    [422, undefined, 'validation'],
    [500, undefined, 'server'],
    [502, undefined, 'server'],
    [503, undefined, 'server'],
    [undefined, 'ECONNREFUSED', 'network'],
    [undefined, 'ETIMEDOUT', 'timeout'],
    [undefined, 'ABORT_ERR', 'cancelled'],
  ];

  // Just document the mapping — no live network needed.
  console.log('Classification reference table:');
  for (const [status, code, expected] of table) {
    console.log(`  status=${status ?? '—'} code=${code ?? '—'} → ${expected}`);
  }
}

// ---------------------------------------------------------------------------
// Example E: toJSON() — safe serialisation for logs and BFF responses.
// ---------------------------------------------------------------------------

export async function example12e(): Promise<void> {
  const client = createResilientHttp({
    fetch: serverError(401),
  });

  try {
    await client.get('https://api.example.com/protected');
  } catch (err) {
    if (!isResilientHttpError(err)) return;

    const json = err.toJSON();

    // Fields present in toJSON():
    console.log(json['name']);           // 'ResilientHttpError'
    console.log(json['kind']);           // 'response'
    console.log(json['statusCode']);     // 401
    console.log(json['classification']); // 'authentication'
    console.log(json['isRetryable']);    // false

    // Fields EXCLUDED from toJSON() (may contain secrets or PII):
    console.log('body' in json);   // false
    console.log('cause' in json);  // false
    console.log('meta' in json);   // false
  }
}
