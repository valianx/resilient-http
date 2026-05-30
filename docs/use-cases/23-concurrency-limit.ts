/**
 * 23-concurrency-limit.ts
 *
 * Tool: createResilientHttp wrapped in a userland concurrency limiter (bulkhead).
 * Recipe: bound the number of in-flight requests to prevent resource exhaustion.
 *
 * The library does not provide a maxConcurrency option — concurrency control is
 * application-level orchestration. A simple semaphore (token bucket) placed around
 * the client call is the idiomatic pattern. This example shows one implementation.
 *
 * Use this when your downstream dependency has a connection limit, your process
 * has a thread/memory budget, or you want to avoid thundering-herd on startup.
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Minimal semaphore — limits the number of concurrent async operations.
// ---------------------------------------------------------------------------

class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    // Suspend the caller until a slot opens.
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    this.running++;
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Run fn with the semaphore held; always releases on completion/error. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Inline fetch mock — tracks peak concurrency.
// ---------------------------------------------------------------------------

function makeConcurrentFetch(): {
  fetch: typeof globalThis.fetch;
  peakConcurrency: () => number;
} {
  let inFlight = 0;
  let peak = 0;

  const fetch: typeof globalThis.fetch = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Simulate a brief async operation.
    await new Promise<void>((r) => setTimeout(r, 10));
    inFlight--;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  return { fetch, peakConcurrency: () => peak };
}

// ---------------------------------------------------------------------------
// Example A: bound concurrent calls to 2 even when 5 are fired simultaneously.
// ---------------------------------------------------------------------------

export async function example23a(): Promise<void> {
  const { fetch, peakConcurrency } = makeConcurrentFetch();
  const semaphore = new Semaphore(2); // at most 2 concurrent in-flight requests

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch,
  });

  // Fire 5 concurrent requests — all will queue through the semaphore.
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      semaphore.run(() => client.get(`/items/${i}`)),
    ),
  );

  console.log(peakConcurrency() <= 2); // true — semaphore capped it
}

// ---------------------------------------------------------------------------
// Example B: wrap in a helper function for ergonomic use.
// ---------------------------------------------------------------------------

function createBoundedClient(
  options: Parameters<typeof createResilientHttp>[0],
  maxConcurrent: number,
) {
  const client    = createResilientHttp(options);
  const semaphore = new Semaphore(maxConcurrent);

  return {
    get: <T = unknown>(
      url: string,
      config?: Parameters<typeof client.get>[1],
    ) => semaphore.run(() => client.get<T>(url, config)),

    post: <T = unknown>(
      url: string,
      config?: Parameters<typeof client.post>[1],
    ) => semaphore.run(() => client.post<T>(url, config)),
  };
}

export async function example23b(): Promise<void> {
  const { fetch, peakConcurrency } = makeConcurrentFetch();

  const client = createBoundedClient(
    { baseURL: 'https://api.example.com', fetch },
    3, // max 3 in-flight
  );

  await Promise.all(
    Array.from({ length: 8 }, (_, i) => client.get(`/data/${i}`)),
  );

  console.log(peakConcurrency() <= 3); // true
}
