/**
 * 34-nextjs-client-component.ts  —  FRONTEND (Next.js App Router)
 *
 * Recipe: use resilient-http inside a Client Component (`'use client'`), where
 * the code runs in the browser and the library uses the BROWSER's native fetch /
 * AbortSignal / Headers. The same factory and the same options behave identically
 * to the server — that is the point of a framework- and runtime-agnostic library.
 *
 * This file is framework-neutral so it compiles without `react`: `loadProfile`
 * is what an event handler / effect in a `'use client'` component would call. The
 * commented snippet shows the surrounding component.
 *
 * Runtime: browser.
 *
 * Browser notes:
 *  - Prefer a same-origin route (e.g. your own /api/...) for writes: a POST with
 *    a json body uses a non-CORS-safelisted Content-Type, so a cross-origin POST
 *    requires an OPTIONS preflight. Same-origin needs none.
 *  - Never put server secrets in a Client Component; only public, browser-safe
 *    config belongs here.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';
import type { ResilientHttpClient } from 'resilient-http';

// Same-origin: calls the app's own route handlers (see 32-nextjs-route-handler).
const api: ResilientHttpClient = createResilientHttp({
  baseURL: '/api',
  timeout: 8000,
  retry: { maxAttempts: 3, jitter: 'full' },
});

interface Profile {
  id: string;
  name: string;
}

export interface LoadResult {
  data?: Profile;
  error?: { message: string; status?: number };
}

/**
 * Body of a click/effect handler in a Client Component:
 *
 *   'use client';
 *   export function ProfileCard({ id }: { id: string }) {
 *     const [state, setState] = useState<LoadResult>({});
 *     useEffect(() => { loadProfile(id).then(setState); }, [id]);
 *     return <div>{state.data?.name ?? state.error?.message}</div>; // JSX omitted
 *   }
 *
 * The browser's AbortSignal aborts a real in-flight fetch when `timeout` elapses,
 * and the standardized error gives you a non-null message plus the real status to
 * render a friendly state.
 */
export async function loadProfile(id: string): Promise<LoadResult> {
  try {
    const res = await api.get<Profile>(`/users?id=${encodeURIComponent(id)}`);
    return { data: res.data ?? undefined };
  } catch (err) {
    if (isResilientHttpError(err)) {
      // message is always a meaningful string; statusCode is present for a
      // response error (undefined for a network/timeout abort).
      return { error: { message: err.message, status: err.statusCode } };
    }
    return { error: { message: 'Unexpected error' } };
  }
}

/**
 * An abortable load tied to the component lifecycle: pass an AbortController's
 * signal so navigating away cancels the request. Caller-abort surfaces as a
 * network error with classification 'cancelled'.
 */
export async function loadProfileAbortable(
  id: string,
  signal: AbortSignal,
): Promise<LoadResult> {
  try {
    const res = await api.get<Profile>(`/users?id=${encodeURIComponent(id)}`, {
      signal,
    });
    return { data: res.data ?? undefined };
  } catch (err) {
    if (isResilientHttpError(err)) {
      return { error: { message: err.message, status: err.statusCode } };
    }
    return { error: { message: 'Unexpected error' } };
  }
}
