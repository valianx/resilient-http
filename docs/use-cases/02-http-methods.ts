/**
 * 02-http-methods.ts
 *
 * Tool: ResilientHttpClient method shortcuts + generic request().
 *
 * Contract:
 *   - Shortcuts: .get .post .put .patch .delete .head .options
 *   - Generic:   .request({ url, method, ...config })
 *   - All shortcuts accept (url: string, config?: RequestConfig).
 *   - The method string is always upper-cased internally.
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — records the method for each call.
// ---------------------------------------------------------------------------

function makeSpy(): {
  fetch: typeof globalThis.fetch;
  lastMethod: () => string;
} {
  let last = '';
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    last = (init?.method ?? 'GET').toUpperCase();
    return new Response(null, { status: 204 });
  };
  return { fetch, lastMethod: () => last };
}

// ---------------------------------------------------------------------------
// Example
// ---------------------------------------------------------------------------

/**
 * Demonstrates every HTTP method shortcut and the generic escape-hatch.
 */
export async function example2(): Promise<void> {
  const spy = makeSpy();
  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: spy.fetch,
  });

  // Standard shortcuts
  await client.get('/items');
  await client.post('/items', { json: { name: 'widget' } });
  await client.put('/items/1', { json: { name: 'widget v2' } });
  await client.patch('/items/1', { json: { name: 'w' } });
  await client.delete('/items/1');
  await client.head('/items');
  await client.options('/items');

  // Generic escape-hatch — useful when the method is dynamic.
  await client.request({ url: '/items', method: 'GET' });

  // The spy captures the last method; each call above used the correct verb.
  console.log(spy.lastMethod()); // 'GET'
}
