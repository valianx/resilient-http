/**
 * 21-userland-circuit-breaker.ts
 *
 * Tool: createResilientHttp wrapped in a userland circuit breaker.
 * Recipe: implement a simple open/half-open/closed breaker around the client.
 *
 * The resilient-http library is intentionally scoped to the HTTP request:
 * retry, backoff, jitter, hooks, and error extraction. Circuit-breaker
 * logic — tracking failure rates across MULTIPLE independent calls and
 * short-circuiting before even attempting a request — is orchestration
 * that lives in your application code, not in the library.
 *
 * This example shows one way to compose the two. The breaker below is
 * intentionally minimal (failure count, not failure rate) to keep the
 * example readable. Production breakers typically track a sliding window,
 * partial-open probe counts, and per-error-class policies.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';

// ---------------------------------------------------------------------------
// Minimal circuit breaker — counts consecutive failures, opens when threshold
// is exceeded, probes after a cooldown window, closes on success.
// ---------------------------------------------------------------------------

type BreakerState = 'closed' | 'open' | 'half-open';

class SimpleCircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
  ) {}

  /** Returns true if the breaker allows the call to proceed. */
  allowRequest(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = 'half-open';
        return true; // probe request
      }
      return false; // still open — short-circuit
    }

    // half-open: allow one probe
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  getState(): BreakerState {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Inline fetch mock — fails N times then succeeds.
// ---------------------------------------------------------------------------

function makeFlakyFetch(failCount: number): typeof globalThis.fetch {
  let calls = 0;
  return async () => {
    calls++;
    const status = calls <= failCount ? 503 : 200;
    return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
  };
}

// ---------------------------------------------------------------------------
// Example A: breaker opens after threshold failures, rejects subsequent calls.
// ---------------------------------------------------------------------------

export async function example21a(): Promise<void> {
  const breaker = new SimpleCircuitBreaker(
    2,    // open after 2 consecutive failures
    100,  // cooldown: 100 ms
  );

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeFlakyFetch(5), // always 503 for the first 5 calls
    retry: { maxAttempts: 1 }, // single attempt — retry is handled at the call site
  });

  async function callWithBreaker(path: string): Promise<number | 'circuit-open'> {
    if (!breaker.allowRequest()) {
      return 'circuit-open';
    }
    try {
      const { status } = await client.get(path);
      breaker.recordSuccess();
      return status;
    } catch (err) {
      if (isResilientHttpError(err)) {
        breaker.recordFailure();
      }
      throw err;
    }
  }

  // First two calls fail — breaker opens.
  for (let i = 0; i < 2; i++) {
    try {
      await callWithBreaker('/service');
    } catch {
      // expected — 503
    }
  }

  console.log(breaker.getState()); // 'open'

  // Third call is short-circuited before reaching the network.
  const result = await callWithBreaker('/service');
  console.log(result); // 'circuit-open'
}

// ---------------------------------------------------------------------------
// Example B: breaker half-opens after cooldown, closes on probe success.
// ---------------------------------------------------------------------------

export async function example21b(): Promise<void> {
  const breaker = new SimpleCircuitBreaker(1, 50); // open after 1 failure, 50 ms cooldown

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeFlakyFetch(1), // first call fails, then succeeds
    retry: { maxAttempts: 1 },
  });

  async function callWithBreaker(path: string): Promise<number | 'circuit-open'> {
    if (!breaker.allowRequest()) return 'circuit-open';
    try {
      const { status } = await client.get(path);
      breaker.recordSuccess();
      return status;
    } catch (err) {
      if (isResilientHttpError(err)) breaker.recordFailure();
      throw err;
    }
  }

  // Trigger the breaker to open.
  try { await callWithBreaker('/svc'); } catch { /* expected */ }
  console.log(breaker.getState()); // 'open'

  // Wait for cooldown to pass.
  await new Promise<void>((r) => setTimeout(r, 60));

  // Probe is allowed (half-open). The service is now healthy → closes.
  const probeResult = await callWithBreaker('/svc');
  console.log(probeResult);        // 200
  console.log(breaker.getState()); // 'closed'
}
