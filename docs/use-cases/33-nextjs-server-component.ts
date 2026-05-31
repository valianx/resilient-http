/**
 * 33-nextjs-server-component.ts  —  BACKEND (Next.js App Router)
 *
 * Recipe: fetch data from a React Server Component (and a Server Action) using
 * resilient-http. Server Components run only on the server, so the resilient
 * client and any secrets stay server-side and never reach the browser bundle.
 *
 * This file is framework-neutral so it compiles without `react`/`next`: the
 * `loadDashboard` function is the body of an `async function Page()` Server
 * Component, and `createOrder` is the body of a `'use server'` Server Action.
 * The commented JSX shows where each would be used.
 *
 * Runtime: server.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';
import type { ResilientHttpClient } from 'resilient-http';

const api: ResilientHttpClient = createResilientHttp({
  baseURL: 'https://api.internal.example',
  timeout: 5000,
  retry: { maxAttempts: 3, jitter: 'equal' },
  // A server-only auth header; safe here because this never ships to the client.
  headers: { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN ?? ''}` },
  // Keep the token out of logs.
  redactHeaders: ['authorization'],
});

interface Dashboard {
  widgets: Array<{ id: string; title: string }>;
}

/**
 * Body of an async Server Component:
 *
 *   export default async function Page() {
 *     const data = await loadDashboard();
 *     return <Dashboard data={data} />;   // JSX omitted to compile standalone
 *   }
 */
export async function loadDashboard(): Promise<Dashboard | null> {
  try {
    const res = await api.get<Dashboard>('/dashboard');
    return res.data ?? null;
  } catch (err) {
    if (isResilientHttpError(err) && err.statusCode === 404) {
      return null; // render an empty state instead of throwing
    }
    throw err; // let the nearest error.tsx boundary handle it
  }
}

interface Order {
  id: string;
}

/**
 * Body of a Server Action:
 *
 *   'use server';
 *   export async function createOrderAction(formData: FormData) {
 *     return createOrder({ sku: String(formData.get('sku')) });
 *   }
 *
 * Writes opt into retries and pin an idempotency key so a retried submit does
 * not create duplicate orders.
 */
export async function createOrder(input: { sku: string }): Promise<Order> {
  const res = await api.post<Order>('/orders', {
    json: input,
    idempotencyKey: true,
    retry: { maxAttempts: 3, retryableMethods: ['POST'] },
  });
  return res.data as Order;
}
