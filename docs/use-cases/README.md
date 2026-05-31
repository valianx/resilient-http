# resilient-http — Use-Case Examples

Reference documentation for the stable v2 public API. Each file demonstrates one tool
or feature family in isolation, so you can read any file independently.

## Index

### Core features

| File | Tool / feature illustrated |
|------|---------------------------|
| `01-quickstart.ts` | Minimal client setup — `createResilientHttp` + a single GET |
| `02-http-methods.ts` | All seven HTTP method shortcuts and the generic `request()` escape-hatch |
| `03-base-url-and-params.ts` | `baseURL` + query-string `params` composition |
| `04-retry-and-method-gate.ts` | `maxAttempts`, default method gate (POST not retried), explicit opt-in |
| `05-backoff-strategies.ts` | Exponential / linear / constant backoff formulas and defaults |
| `06-jitter.ts` | Full / equal / decorrelated / none jitter strategies |
| `07-should-retry.ts` | `shouldRetry` custom gate — fail-closed contract when it throws |
| `08-retry-after.ts` | Retry-After header honoring (429 only), `maxRetryAfter` cap, give-up |
| `09-timeout-and-deadline.ts` | Per-attempt `timeout`, total `deadline`, and caller `AbortSignal` |
| `10-response-types.ts` | `responseType` modes: auto / json / text / arrayBuffer / blob / stream / none |
| `11-validate-status.ts` | Custom `validateStatus` — treat 4xx as success, or restrict 2xx range |
| `12-errors.ts` | Three error kinds, `ErrorClassification`, `isResilientHttpError`, `toJSON` |
| `13-redaction.ts` | `redactHeaders`, `redactQueryParams`, BFF-safe `toJSON` output |
| `14-hooks.ts` | `onRequest` (mutator), `onResponse`, `onRetry`, `onFailure` observers |
| `15-idempotency-key.ts` | `true` / static string / factory function frozen across retries |
| `16-headers-and-logger.ts` | Instance + per-request header merge, `Logger` interface |
| `17-composing-a-resilient-preset.ts` | Combining timeout, deadline, maxRetryAfter, retryableMethods, and idempotencyKey into a preset for a retry-sensitive operation |

### Auth & observability

| File | Recipe |
|------|--------|
| `18-oauth-token-refresh.ts` | Auto-refresh a bearer token on 401 via `onRequest` hook + `ctx.meta` guard |
| `19-opentelemetry-tracing.ts` | Inject W3C `traceparent` / `tracestate` per attempt using `ctx.requestId` (stable trace) and `ctx.attemptId` (per-attempt span) |
| `20-request-correlation.ts` | Propagate `X-Request-Id` across all retry attempts; log it in `onRetry` / `onFailure` |

### Resilience patterns

| File | Recipe |
|------|--------|
| `21-userland-circuit-breaker.ts` | Compose a simple open/half-open/closed breaker around the client in userland (the library covers the request; orchestration lives in your code) |
| `22-rate-limit-aware.ts` | Handle 429 with `respectRetryAfter` + `maxRetryAfter` cap; per-method 429 gate via `shouldRetry` |
| `23-concurrency-limit.ts` | Bound in-flight requests with a userland semaphore (bulkhead pattern; the library has no built-in `maxConcurrency`) |

### Data patterns

| File | Recipe |
|------|--------|
| `24-pagination.ts` | Paginate cursor-based and offset-based APIs — each page request is independently retried |
| `25-streaming-download.ts` | Download a large body as `ReadableStream` with `responseType:'stream'` — chunk-by-chunk, no buffering |
| `26-file-upload.ts` | Upload `Uint8Array` / JSON with retry; stream-body trade-off explained |
| `27-graphql-client.ts` | Resilient GraphQL POST — detect application-level errors in a 200 response; query vs mutation retry trade-off |

### Integration patterns

| File | Recipe |
|------|--------|
| `28-bff-proxy.ts` | Backend-For-Frontend proxy — call an upstream API and sanitize errors before returning to an untrusted client |
| `29-webhook-delivery.ts` | Deliver webhook events with retry, idempotency key per event, and `onFailure` audit hook |
| `30-nestjs-provider.ts` | NestJS `useFactory` provider + injection token; test-swap pattern (NestJS types declared locally — no runtime dep) |
| `31-testing-with-mock-fetch.ts` | Test your code that uses the client by injecting a `config.fetch` mock; assert attempts, headers, and error classification |

### Framework integration (by runtime)

`resilient-http` is framework- and runtime-agnostic: the same factory and the same
options run on a server (route handlers, Server Components, DI providers) and in a
real browser (Client Components). These examples are grouped by where they run.

**Backend (server runtime)**

| File | Recipe |
|------|--------|
| `28-bff-proxy.ts` | Backend-For-Frontend proxy (any fetch server) |
| `30-nestjs-provider.ts` | NestJS `useFactory` provider (DI) |
| `32-nextjs-route-handler.ts` | Next.js App Router route handler — GET with resilience metadata, POST opting into retries with a frozen idempotency key |
| `33-nextjs-server-component.ts` | Next.js Server Component data load + Server Action, with a server-only redacted auth header |

**Frontend (browser runtime)**

| File | Recipe |
|------|--------|
| `34-nextjs-client-component.ts` | Next.js Client Component (`'use client'`) using the browser's native fetch; same-origin call + an abortable variant tied to the component lifecycle |

> The behavior is identical in both runtimes; the only differences are environmental
> (CORS and secret handling in the browser, connection reuse on the server). An
> end-to-end suite that runs the library in both a Node server runtime and a real
> browser lives in the `resilient-http-e2e-nextjs` project.

## Philosophy

`resilient-http` is **business-agnostic**. It provides composable tools; you decide
how to combine them for your use case. These examples show what each tool does —
they are not prescriptions for any particular business domain.

## How to read these examples

Every file:

- Imports exclusively from `'../../src/index'` (source, not the built dist).
- Uses an inline `mockFetch` so no real network is needed.
- Exports named `async function exampleN()` functions that could be called in a test
  runner, or read top-to-bottom as documentation.

## Publication note

These files are **not published to npm**. The package `files` field contains only
`dist/`, `README.md`, and `LICENSE`. The `docs/` directory is repository-only
reference material.
