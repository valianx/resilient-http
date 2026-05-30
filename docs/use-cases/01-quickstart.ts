/**
 * 01-quickstart.ts
 *
 * Tool: createResilientHttp — minimal client setup.
 *
 * Contract:
 *   - createResilientHttp(options?) returns a ResilientHttpClient.
 *   - A successful response yields ResilientResponse<T> with:
 *       data, status, headers, url, attempts, raw.
 *   - Default behaviour: no retries (maxAttempts = 1), 'auto' response-type.
 */

import { createResilientHttp } from 'resilient-http';
import type { ResilientResponse } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — no real network needed.
// ---------------------------------------------------------------------------

function mockFetch(payload: unknown, status = 200): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

// ---------------------------------------------------------------------------
// Example
// ---------------------------------------------------------------------------

interface User {
  id: number;
  name: string;
}

/**
 * Demonstrates the minimal usage pattern:
 *   1. Create a client with a base URL.
 *   2. Issue a GET request.
 *   3. Read the typed response.
 */
export async function example1(): Promise<void> {
  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: mockFetch({ id: 1, name: 'Alice' }),
  });

  const response: ResilientResponse<User> = await client.get<User>('/users/1');

  // Typed body
  console.log(response.data?.name);     // 'Alice'

  // Envelope fields
  console.log(response.status);         // 200
  console.log(response.attempts);       // 1  (first-try success)
  console.log(typeof response.raw);     // 'object'  (native Response)
}
