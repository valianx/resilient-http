/**
 * 17-composing-a-resilient-preset.ts
 *
 * Tool: Composing multiple options into a preset for a retry-sensitive operation.
 *
 * This example shows how to combine several resilient-http tools into a single
 * client configuration suited for operations where retrying incorrectly could
 * cause duplicate side-effects on the server.
 *
 * A typical case is any server-side operation that is NOT inherently idempotent
 * (e.g. an endpoint that creates a resource or charges an external service).
 * The tools used here are not specific to any business domain — they are
 * general-purpose resilience controls.
 *
 * Tools composed:
 *   - timeout + deadline     → bound each attempt and the total operation wall time.
 *   - maxRetryAfter          → refuse to wait an unbounded Retry-After delay when
 *                              the upstream is degraded.
 *   - retryableMethods       → restrict automatic retries to HTTP methods the
 *                              server treats as safe to repeat.
 *   - idempotencyKey         → ensure all retry attempts for one logical operation
 *                              carry the same key, so a server-side deduplication
 *                              layer can detect and discard duplicates.
 *   - redactQueryParams      → keep sensitive URL parameters out of error logs.
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — returns 503 twice then 200, simulating a transient blip.
// ---------------------------------------------------------------------------

function makeTransientFetch(): {
  fetch: typeof globalThis.fetch;
  callCount: () => number;
} {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    const status = calls < 3 ? 503 : 200;
    return new Response(JSON.stringify({ ok: status === 200 }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, callCount: () => calls };
}

// ---------------------------------------------------------------------------
// Helper: build the preset client.
//
// Each option is annotated with the reason it is included — rationale, not
// just mechanics.
// ---------------------------------------------------------------------------

function buildResilientPreset(baseURL: string, fetchImpl?: typeof globalThis.fetch) {
  return createResilientHttp({
    baseURL,
    fetch: fetchImpl,

    // Per-attempt timeout: prevents a slow upstream from hanging one attempt
    // indefinitely. Each retry starts with a fresh 10 s budget.
    timeout: 10_000,

    // Absolute wall-clock ceiling: even with three retries, the entire
    // operation cannot exceed 25 s. Once the deadline passes, no new attempt
    // is started regardless of attempts remaining.
    deadline: Date.now() + 25_000,

    retry: {
      maxAttempts: 3,
      backoff: 'exponential',
      jitter: 'full',     // spread retry load across replicas

      // Refuse to honour a Retry-After header longer than 5 s.
      // An upstream asking for a 60 s wait under load should not stall the
      // entire operation — give up instead and let the caller decide.
      maxRetryAfter: 5_000,

      // Only retry HTTP methods the server treats as safe to repeat.
      // POST is excluded from this list because it is not idempotent by
      // default. If you know a specific POST endpoint is safe to retry
      // (e.g. the server deduplicates via idempotencyKey), add 'POST'
      // explicitly and document the reason.
      retryableMethods: ['GET', 'HEAD', 'PUT', 'DELETE'],
    },

    // Idempotency key: the factory is called exactly once per logical
    // operation. The returned value is frozen and reused on every retry
    // attempt. This gives a server-side deduplication layer a stable
    // handle to detect and discard duplicate requests.
    //
    // Using `true` here generates a random UUID per operation automatically.
    // You can also pass a static string or a factory that derives the key
    // from the operation context (see 15-idempotency-key.ts).
    idempotencyKey: true,

    // Redact sensitive query parameters from the url field in toJSON().
    // Credentials or signatures that appear in the query string would
    // otherwise be visible in error logs.
    redactQueryParams: ['token', 'signature', 'api_key'],
  });
}

// ---------------------------------------------------------------------------
// Example A: PUT request — retried automatically (PUT is in retryableMethods).
// ---------------------------------------------------------------------------

export async function example17a(): Promise<void> {
  const { fetch, callCount } = makeTransientFetch();
  const client = buildResilientPreset('https://api.example.com', fetch);

  // PUT is idempotent — safe to retry with the same idempotency key.
  const { data } = await client.put<{ ok: boolean }>('/resources/r-001', {
    json: { value: 42 },
  });

  console.log(data?.ok);    // true — succeeded on the third attempt
  console.log(callCount()); // 3 — two transient 503s, then 200
}

// ---------------------------------------------------------------------------
// Example B: POST request — NOT retried by this preset.
// The method gate blocks automatic retry; the caller must handle the error
// and decide whether a new request is safe to issue.
// ---------------------------------------------------------------------------

export async function example17b(): Promise<void> {
  const { fetch, callCount } = makeTransientFetch();
  const client = buildResilientPreset('https://api.example.com', fetch);

  try {
    await client.post('/resources', { json: { value: 99 } });
  } catch {
    // POST is not in retryableMethods — the engine stopped after 1 attempt.
  }

  console.log(callCount()); // 1 — no retry was attempted
}

// ---------------------------------------------------------------------------
// Example C: idempotency key is frozen across retries.
// Verify that all attempts for one operation share the same key.
// ---------------------------------------------------------------------------

export async function example17c(): Promise<void> {
  const capturedKeys: string[] = [];

  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const headers = init?.headers;
    let key = '';
    if (headers instanceof Headers) {
      key = headers.get('Idempotency-Key') ?? '';
    } else if (headers && typeof headers === 'object') {
      const rec = headers as Record<string, string>;
      key = rec['Idempotency-Key'] ?? rec['idempotency-key'] ?? '';
    }
    capturedKeys.push(key);
    // Fail once then succeed so a retry fires.
    const status = capturedKeys.length < 2 ? 503 : 200;
    return new Response('{}', {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = buildResilientPreset('https://api.example.com', fetch);
  await client.put('/resources/r-002', { json: {} });

  // Both attempts carried the same key — the server-side dedup layer
  // would see the second request as a duplicate and return the cached result.
  console.log(capturedKeys.length >= 2);                    // true
  console.log(capturedKeys[0] === capturedKeys[1]);          // true
  console.log(capturedKeys[0].length > 0);                  // true
}
