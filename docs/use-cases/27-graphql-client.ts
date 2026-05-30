/**
 * 27-graphql-client.ts
 *
 * Tool: createResilientHttp with JSON body + validateStatus + shouldRetry.
 * Recipe: resilient GraphQL client that detects application-level errors.
 *
 * Contract:
 *   - GraphQL always uses POST with { query, variables } as a JSON body.
 *   - GraphQL servers return HTTP 200 even when the response contains errors
 *     (the `errors` array in the body). validateStatus alone cannot detect this.
 *   - The safe pattern: fetch with responseType:'json', then inspect the body.
 *     If data.errors is non-empty, throw manually. Retry is NOT triggered for
 *     application-level GraphQL errors — only for transport errors (5xx, network).
 *   - POST is not in the default retryableMethods. Add it explicitly ONLY if you
 *     know the operation is idempotent (queries are safe; mutations usually are not).
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';

// ---------------------------------------------------------------------------
// Shared GraphQL response type.
// ---------------------------------------------------------------------------

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code: string } }>;
}

// ---------------------------------------------------------------------------
// Inline fetch mock — configurable response per call.
// ---------------------------------------------------------------------------

type FetchResponse = { status: number; body: unknown };

function makeGqlFetch(sequence: FetchResponse[]): typeof globalThis.fetch {
  let i = 0;
  return async () => {
    const r = sequence[i] ?? sequence[sequence.length - 1];
    i++;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Thin helper that wraps the resilient client for GraphQL.
// ---------------------------------------------------------------------------

interface GqlClientOptions {
  endpoint: string;
  fetch?: typeof globalThis.fetch;
}

function createGqlClient({ endpoint, fetch: fetchImpl }: GqlClientOptions) {
  const http = createResilientHttp({
    fetch: fetchImpl,
    retry: {
      maxAttempts: 3,
      initialDelay: 200,
      jitter: 'full',
      // Retry POST for QUERY operations only — safe because queries are read-only.
      // Mutations must be kept at maxAttempts: 1 (caller responsibility).
      retryableMethods: ['POST'],
      retryableStatuses: [500, 502, 503, 504], // NOT 200 — GQL errors arrive as 200
    },
  });

  return {
    async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const { data: body } = await http.post<GqlResponse<T>>(endpoint, {
        json: { query, variables },
      });

      // GraphQL application errors arrive as HTTP 200 with an `errors` array.
      if (body?.errors && body.errors.length > 0) {
        const first = body.errors[0];
        throw new Error(`GraphQL error: ${first.message} [${first.extensions?.code ?? 'UNKNOWN'}]`);
      }

      if (!body?.data) {
        throw new Error('GraphQL response missing data field');
      }

      return body.data;
    },
  };
}

// ---------------------------------------------------------------------------
// Example A: successful GraphQL query.
// ---------------------------------------------------------------------------

interface User {
  id: string;
  name: string;
}

export async function example27a(): Promise<void> {
  const gql = createGqlClient({
    endpoint: 'https://api.example.com/graphql',
    fetch: makeGqlFetch([
      { status: 200, body: { data: { user: { id: '1', name: 'Alice' } } } },
    ]),
  });

  const { user } = await gql.query<{ user: User }>(
    'query GetUser($id: ID!) { user(id: $id) { id name } }',
    { id: '1' },
  );

  console.log(user.name); // 'Alice'
}

// ---------------------------------------------------------------------------
// Example B: transport error (503) — engine retries; succeeds on second attempt.
// ---------------------------------------------------------------------------

export async function example27b(): Promise<void> {
  const gql = createGqlClient({
    endpoint: 'https://api.example.com/graphql',
    fetch: makeGqlFetch([
      { status: 503, body: {} },
      { status: 200, body: { data: { ping: 'pong' } } },
    ]),
  });

  const { ping } = await gql.query<{ ping: string }>('{ ping }');
  console.log(ping); // 'pong' — recovered from transient 503
}

// ---------------------------------------------------------------------------
// Example C: application-level error (HTTP 200, errors in body) — NOT retried.
// ---------------------------------------------------------------------------

export async function example27c(): Promise<void> {
  let callCount = 0;
  const fetch: typeof globalThis.fetch = async () => {
    callCount++;
    return new Response(
      JSON.stringify({ errors: [{ message: 'Not authorized', extensions: { code: 'FORBIDDEN' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const gql = createGqlClient({
    endpoint: 'https://api.example.com/graphql',
    fetch,
  });

  try {
    await gql.query('{ sensitiveData }');
  } catch (err) {
    const e = err as Error;
    console.log(e.message.includes('FORBIDDEN')); // true
    // This is NOT a ResilientHttpError — the HTTP layer succeeded (200).
    console.log(isResilientHttpError(err));        // false
  }

  // HTTP returned 200, so the retry engine never fired.
  console.log(callCount); // 1
}
