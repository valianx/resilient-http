/**
 * 09-timeout-and-deadline.ts
 *
 * Tools: timeout, deadline, RequestConfig.signal.
 *
 * Contract:
 *   - timeout: per-attempt maximum in milliseconds. When it fires, the fetch
 *     is aborted. The error is kind:'network' / classification:'timeout'.
 *   - deadline: absolute Unix-ms timestamp (Date.now()-compatible). No new
 *     attempt starts once Date.now() >= deadline. The effective per-attempt
 *     timeout is min(timeout, remaining-deadline-time).
 *   - signal: caller-supplied AbortSignal. Merged with the per-attempt signal.
 *     When the caller aborts, the current attempt is interrupted immediately
 *     and the engine stops retrying (no further attempts).
 *   - All three compose: the most restrictive signal fires first.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — hangs forever so the timeout fires.
// ---------------------------------------------------------------------------

function hangingFetch(): typeof globalThis.fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      // Abort when the signal fires.
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('This operation was aborted', 'AbortError'));
      });
    });
}

// ---------------------------------------------------------------------------
// Example A: per-attempt timeout — fetch is aborted, error is 'timeout'.
// ---------------------------------------------------------------------------

export async function example9a(): Promise<void> {
  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: hangingFetch(),
    timeout: 100, // 100 ms per attempt
    retry: { maxAttempts: 1 },
  });

  try {
    await client.get('/slow-resource');
  } catch (err) {
    if (isResilientHttpError(err)) {
      console.log(err.kind);           // 'network'
      console.log(err.classification); // 'timeout'
    }
  }
}

// ---------------------------------------------------------------------------
// Example B: absolute deadline — engine does not start a new attempt after
// the deadline expires, even if attempts remain.
// ---------------------------------------------------------------------------

export async function example9b(): Promise<void> {
  let attemptCount = 0;

  const fetch: typeof globalThis.fetch = async () => {
    attemptCount++;
    // Simulate a slow response that always fails.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return new Response('{}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    deadline: Date.now() + 80, // only 80 ms total budget
    retry: {
      maxAttempts: 5,
      initialDelay: 10,
      jitter: 'none',
    },
  });

  try {
    await client.get('/health');
  } catch {
    // Expected — deadline expired.
  }

  // The engine stopped before exhausting all 5 attempts.
  console.log(attemptCount < 5); // true
}

// ---------------------------------------------------------------------------
// Example C: caller AbortSignal — abort in flight cancels immediately.
// ---------------------------------------------------------------------------

export async function example9c(): Promise<void> {
  const controller = new AbortController();

  const fetch: typeof globalThis.fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      // Abort when either the caller or the per-attempt signal fires.
      const abort = () =>
        reject(new DOMException('This operation was aborted', 'AbortError'));
      init?.signal?.addEventListener('abort', abort);
    });

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
    retry: { maxAttempts: 3 },
  });

  // Abort after a short delay.
  setTimeout(() => controller.abort(), 50);

  try {
    await client.get('/stream', { signal: controller.signal });
  } catch (err) {
    if (isResilientHttpError(err)) {
      console.log(err.classification); // 'cancelled'
    }
  }
}
