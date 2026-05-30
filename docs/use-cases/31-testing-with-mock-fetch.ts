/**
 * 31-testing-with-mock-fetch.ts
 *
 * Tool: config.fetch injection for testing.
 * Recipe: test YOUR code that uses a resilient HTTP client by injecting a mock fetch.
 *
 * Contract:
 *   - createResilientHttp accepts a `fetch` option that replaces globalThis.fetch.
 *   - Inject a custom fetch implementation to control responses without a real server.
 *   - The mock can assert on: the URL called, the HTTP method, headers sent, the body,
 *     and the number of attempts (by counting mock invocations).
 *   - This pattern works with any test runner (Bun test, Node test, Jest, Vitest).
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';
import type { ResilientHttpClient, ResilientHttpOptions } from 'resilient-http';

// ---------------------------------------------------------------------------
// The subject-under-test: a thin service wrapper around the resilient client.
// ---------------------------------------------------------------------------

interface Product {
  id: number;
  name: string;
  price: number;
}

class ProductService {
  private readonly http: ResilientHttpClient;

  constructor(options: ResilientHttpOptions) {
    this.http = createResilientHttp(options);
  }

  async getProduct(id: number): Promise<Product> {
    const { data } = await this.http.get<Product>(`/products/${id}`);
    if (!data) throw new Error('Empty response');
    return data;
  }

  async createProduct(payload: Omit<Product, 'id'>): Promise<Product> {
    const { data } = await this.http.post<Product>('/products', { json: payload });
    if (!data) throw new Error('Empty response');
    return data;
  }
}

// ---------------------------------------------------------------------------
// Mock fetch builder — configurable per test case.
// ---------------------------------------------------------------------------

interface MockFetchOptions {
  status:  number;
  body:    unknown;
  headers?: Record<string, string>;
}

interface MockFetchCapture {
  fetch:        typeof globalThis.fetch;
  callCount:    () => number;
  lastUrl:      () => string;
  lastMethod:   () => string;
  lastHeaders:  () => Record<string, string>;
  lastBody:     () => unknown;
}

function buildMockFetch(sequence: MockFetchOptions[]): MockFetchCapture {
  let calls = 0;
  let lastUrl    = '';
  let lastMethod = '';
  let lastHeaders: Record<string, string> = {};
  let lastBody: unknown = undefined;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls++;
    lastUrl    = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    lastMethod = (init?.method ?? 'GET').toUpperCase();
    lastBody   = init?.body;

    if (init?.headers instanceof Headers) {
      lastHeaders = {};
      init.headers.forEach((v, k) => { lastHeaders[k] = v; });
    } else if (init?.headers && typeof init.headers === 'object') {
      lastHeaders = { ...(init.headers as Record<string, string>) };
    }

    const r = sequence[calls - 1] ?? sequence[sequence.length - 1];
    return new Response(JSON.stringify(r.body), {
      status:  r.status,
      headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) },
    });
  };

  return {
    fetch,
    callCount:   () => calls,
    lastUrl:     () => lastUrl,
    lastMethod:  () => lastMethod,
    lastHeaders: () => ({ ...lastHeaders }),
    lastBody:    () => lastBody,
  };
}

// ---------------------------------------------------------------------------
// Example A: happy path — verify data is returned and only one call is made.
// ---------------------------------------------------------------------------

export async function example31a(): Promise<void> {
  const mock = buildMockFetch([
    { status: 200, body: { id: 1, name: 'Widget', price: 9.99 } },
  ]);

  const service = new ProductService({
    baseURL: 'https://api.example.com',
    fetch:   mock.fetch,
  });

  const product = await service.getProduct(1);

  console.log(product.name);               // 'Widget'
  console.log(product.price);              // 9.99
  console.log(mock.callCount());           // 1
  console.log(mock.lastUrl().includes('/products/1')); // true
  console.log(mock.lastMethod());          // 'GET'
}

// ---------------------------------------------------------------------------
// Example B: retry behaviour — assert that the client retried on 503.
// ---------------------------------------------------------------------------

export async function example31b(): Promise<void> {
  const mock = buildMockFetch([
    { status: 503, body: {} },
    { status: 503, body: {} },
    { status: 200, body: { id: 2, name: 'Gadget', price: 49.99 } },
  ]);

  const service = new ProductService({
    baseURL: 'https://api.example.com',
    fetch:   mock.fetch,
    retry:   { maxAttempts: 3, initialDelay: 0, jitter: 'none' },
  });

  const product = await service.getProduct(2);

  console.log(product.name);     // 'Gadget'
  console.log(mock.callCount()); // 3 — two failures, then success
}

// ---------------------------------------------------------------------------
// Example C: assert headers sent — e.g. verify auth or content-type.
// ---------------------------------------------------------------------------

export async function example31c(): Promise<void> {
  const mock = buildMockFetch([
    { status: 201, body: { id: 99, name: 'Doohickey', price: 5.00 } },
  ]);

  const service = new ProductService({
    baseURL: 'https://api.example.com',
    fetch:   mock.fetch,
    headers: {
      'Authorization': 'Bearer test-token',
      'X-Client-Ver':  '2.0.0',
    },
  });

  await service.createProduct({ name: 'Doohickey', price: 5.00 });

  const h = mock.lastHeaders();
  console.log(h['authorization']);   // 'Bearer test-token'
  console.log(h['x-client-ver']);    // '2.0.0'
  console.log(mock.lastMethod());    // 'POST'
}

// ---------------------------------------------------------------------------
// Example D: error path — verify that all retries are exhausted and the
//             error classification is correct.
// ---------------------------------------------------------------------------

export async function example31d(): Promise<void> {
  const mock = buildMockFetch([
    { status: 500, body: { message: 'internal error' } },
    { status: 500, body: { message: 'internal error' } },
    { status: 500, body: { message: 'internal error' } },
  ]);

  const service = new ProductService({
    baseURL: 'https://api.example.com',
    fetch:   mock.fetch,
    retry:   { maxAttempts: 3, initialDelay: 0 },
  });

  try {
    await service.getProduct(404);
  } catch (err) {
    if (isResilientHttpError(err)) {
      console.log(err.classification); // 'server'
      console.log(err.attempts);       // 3
      console.log(err.statusCode);     // 500
    }
  }

  console.log(mock.callCount()); // 3
}
