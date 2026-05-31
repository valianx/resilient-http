/**
 * 32-nextjs-route-handler.ts  —  BACKEND (Next.js App Router)
 *
 * Recipe: consume resilient-http from a Next.js App Router route handler
 * (`app/api/.../route.ts`). The handler runs on the server runtime (Node or
 * Edge); the library uses that runtime's native fetch.
 *
 * A route handler is a plain `(Request) => Response | Promise<Response>`, which
 * is exactly the shape resilient-http is designed around — nothing Next-specific
 * is required. This file compiles standalone (no `next` dependency): the exported
 * `GET`/`POST` are the same functions you would put in `app/api/users/route.ts`.
 *
 * Runtime: server. The client is created once at module scope and reused across
 * requests, so connection setup is not repeated per request.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';
import type { ResilientHttpClient } from 'resilient-http';

const api: ResilientHttpClient = createResilientHttp({
  baseURL: 'https://api.upstream.example',
  timeout: 4000,
  retry: { maxAttempts: 3, jitter: 'full' },
});

interface User {
  id: string;
  name: string;
}

// app/api/users/route.ts -> export async function GET(request: Request)
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id') ?? '1';

  try {
    const res = await api.get<User>(`/users/${id}`);
    return Response.json(res.data, {
      // Surface resilience metadata to the caller if useful.
      headers: { 'x-resilient-attempts': String(res.attempts) },
    });
  } catch (err) {
    if (isResilientHttpError(err)) {
      // The real upstream status and a stable classification are preserved; the
      // body is on err.body for your logs, while toJSON() stays safe-by-default.
      return Response.json(
        { error: 'upstream_failed', kind: err.kind, reason: err.classification },
        { status: err.statusCode ?? 502 },
      );
    }
    return Response.json({ error: 'unknown' }, { status: 500 });
  }
}

// A write route opts POST into retries explicitly and pins an idempotency key so
// a retried create is de-duplicated upstream.
export async function POST(request: Request): Promise<Response> {
  const payload = (await request.json().catch(() => ({}))) as Partial<User>;

  try {
    const res = await api.post<User>('/users', {
      json: payload,
      idempotencyKey: true, // generated once, frozen across retries
      retry: { maxAttempts: 3, retryableMethods: ['POST'] },
    });
    return Response.json(res.data, { status: 201 });
  } catch (err) {
    if (isResilientHttpError(err)) {
      return Response.json(
        { error: 'create_failed', kind: err.kind },
        { status: err.statusCode ?? 502 },
      );
    }
    return Response.json({ error: 'unknown' }, { status: 500 });
  }
}
