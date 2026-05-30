/**
 * 03-base-url-and-params.ts
 *
 * Tool: baseURL + RequestConfig.params.
 *
 * Contract:
 *   - baseURL is prepended when the request path is not already absolute.
 *   - Trailing slash on baseURL and leading slash on the path are normalised.
 *   - params values are stringified with String() and appended via URLSearchParams.
 *   - null / undefined param values are silently dropped.
 *   - Existing query strings on the path are preserved; params are appended.
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — captures the URL that fetch actually received.
// ---------------------------------------------------------------------------

function makeUrlCapture(): {
  fetch: typeof globalThis.fetch;
  lastUrl: () => string;
} {
  let last = '';
  const fetch: typeof globalThis.fetch = async (input) => {
    last = typeof input === 'string' ? input : input.toString();
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, lastUrl: () => last };
}

// ---------------------------------------------------------------------------
// Example
// ---------------------------------------------------------------------------

/**
 * Demonstrates baseURL composition and query-string params.
 */
export async function example3(): Promise<void> {
  const cap = makeUrlCapture();

  const client = createResilientHttp({
    baseURL: 'https://api.example.com/v2',
    fetch: cap.fetch,
  });

  // Relative path — baseURL is prepended.
  await client.get('/users');
  console.log(cap.lastUrl()); // 'https://api.example.com/v2/users'

  // Query params — appended as a proper query string.
  await client.get('/search', {
    params: { q: 'widget', page: 2, active: true },
  });
  console.log(cap.lastUrl());
  // 'https://api.example.com/v2/search?q=widget&page=2&active=true'

  // Null values are dropped; undefined values are dropped.
  await client.get('/items', {
    params: { filter: null, sort: undefined, limit: 10 },
  });
  console.log(cap.lastUrl());
  // 'https://api.example.com/v2/items?limit=10'

  // Absolute URL — baseURL is NOT prepended.
  await client.get('https://other.example.com/resource');
  console.log(cap.lastUrl()); // 'https://other.example.com/resource'
}
