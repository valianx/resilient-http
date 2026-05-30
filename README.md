# Resilient HTTP

A zero-dependency library for resilient HTTP operations.  
Works with **Node.js 24+**, **Bun 1.0+**, and browsers (ESM).

## Features

- **Single factory**: `createResilientHttp()` — one entry point, config-only surface
- **Retry with Backoff**: Exponential, linear, and constant backoff strategies
- **Jitter Algorithms**: Full, equal, decorrelated, and none (prevents thundering herd)
- **Safe Errors**: `ResilientHttpError` with three kinds, safe-by-default `toJSON()`, and a global brand that survives duplicate module installs
- **Hook System**: `onRequest / onResponse / onRetry / onFailure` interceptors
- **Idempotency Keys**: Frozen per logical operation — all retry attempts reuse the same key
- **Zero Dependencies**: No external runtime dependencies
- **TypeScript First**: Full type definitions included

## Installation

```bash
# pnpm
pnpm add resilient-http

# npm
npm install resilient-http
```

**Requirement:** Node.js >= 24.0.0 (or Bun >= 1.0.0).

## Quick Start

```typescript
import { createResilientHttp } from 'resilient-http';

const client = createResilientHttp({
  baseURL: 'https://api.example.com',
  timeout: 5_000,
  retry: { maxAttempts: 3, backoff: 'exponential', jitter: 'full' },
});

const { data, status } = await client.get<{ id: number; name: string }>('/users/1');
console.log(status, data?.name);
```

## Error handling

Every failure throws a `ResilientHttpError` with one of three kinds:

```typescript
import { createResilientHttp, isResilientHttpError } from 'resilient-http';

const client = createResilientHttp({ baseURL: 'https://api.example.com' });

try {
  const { data } = await client.get('/resource');
} catch (err) {
  if (isResilientHttpError(err)) {
    if (err.kind === 'response') {
      // Server replied with a non-2xx status
      console.error(err.statusCode, err.classification, err.isRetryable);
    } else if (err.kind === 'network') {
      // Request never reached the server (ECONNREFUSED, abort, timeout, etc.)
      console.error(err.code);
    } else {
      // kind === 'setup': error constructing the request (bad body, hook threw, etc.)
      console.error(err.message);
    }

    // Log-safe representation: body, cause, and meta are excluded
    myLogger.error('request failed', err.toJSON());
  }
}
```

Use `isResilientHttpError(e)` — not `instanceof` — so the check works correctly even
when multiple copies of the package are installed (monorepos, version conflicts).

`toJSON()` is safe by default: it never includes `body`, `cause`, or `meta`, preventing
secrets or large payloads from leaking into logs. See the full error reference and the
BFF sanitization pattern in [docs/configuration.md](./docs/configuration.md#error-handling--resilienthttperror).

---

## Documentation

### [docs/configuration.md](./docs/configuration.md) — Full configuration reference

All options with types, defaults, and descriptions:
instance options (`ResilientHttpOptions`), per-request overrides (`RequestConfig`),
retry options (`RetryOptions`), response types, hook system, error properties,
redaction denylist.

### [docs/use-cases/](./docs/use-cases/) — Runnable examples

Each file demonstrates one tool or feature in isolation.

| File | Tool / feature illustrated |
|---|---|
| [`01-quickstart.ts`](./docs/use-cases/01-quickstart.ts) | Minimal client setup — `createResilientHttp` + a single GET |
| [`02-http-methods.ts`](./docs/use-cases/02-http-methods.ts) | All seven HTTP method shortcuts and the generic `request()` escape-hatch |
| [`03-base-url-and-params.ts`](./docs/use-cases/03-base-url-and-params.ts) | `baseURL` + query-string `params` composition |
| [`04-retry-and-method-gate.ts`](./docs/use-cases/04-retry-and-method-gate.ts) | `maxAttempts`, default method gate (POST not retried), explicit opt-in |
| [`05-backoff-strategies.ts`](./docs/use-cases/05-backoff-strategies.ts) | Exponential / linear / constant backoff formulas and defaults |
| [`06-jitter.ts`](./docs/use-cases/06-jitter.ts) | Full / equal / decorrelated / none jitter strategies |
| [`07-should-retry.ts`](./docs/use-cases/07-should-retry.ts) | `shouldRetry` custom gate — fail-closed contract when it throws |
| [`08-retry-after.ts`](./docs/use-cases/08-retry-after.ts) | Retry-After header honoring (429 only), `maxRetryAfter` cap, give-up |
| [`09-timeout-and-deadline.ts`](./docs/use-cases/09-timeout-and-deadline.ts) | Per-attempt `timeout`, total `deadline`, and caller `AbortSignal` |
| [`10-response-types.ts`](./docs/use-cases/10-response-types.ts) | `responseType` modes: auto / json / text / arrayBuffer / blob / stream / none |
| [`11-validate-status.ts`](./docs/use-cases/11-validate-status.ts) | Custom `validateStatus` — treat 4xx as success, or restrict 2xx range |
| [`12-errors.ts`](./docs/use-cases/12-errors.ts) | Three error kinds, `ErrorClassification`, `isResilientHttpError`, `toJSON` |
| [`13-redaction.ts`](./docs/use-cases/13-redaction.ts) | `redactHeaders`, `redactQueryParams`, BFF-safe `toJSON` output |
| [`14-hooks.ts`](./docs/use-cases/14-hooks.ts) | `onRequest` (mutator), `onResponse`, `onRetry`, `onFailure` observers |
| [`15-idempotency-key.ts`](./docs/use-cases/15-idempotency-key.ts) | `true` / static string / factory function frozen across retries |
| [`16-headers-and-logger.ts`](./docs/use-cases/16-headers-and-logger.ts) | Instance + per-request header merge, `Logger` interface |
| [`17-composing-a-resilient-preset.ts`](./docs/use-cases/17-composing-a-resilient-preset.ts) | Combining timeout, deadline, maxRetryAfter, retryableMethods, and idempotencyKey into a preset for a retry-sensitive operation |
| [`18-oauth-token-refresh.ts`](./docs/use-cases/18-oauth-token-refresh.ts) | Auto-refresh a bearer token on 401 via `onRequest` hook + `ctx.meta` guard |
| [`19-opentelemetry-tracing.ts`](./docs/use-cases/19-opentelemetry-tracing.ts) | Inject W3C `traceparent` / `tracestate` per attempt using `ctx.requestId` and `ctx.attemptId` |
| [`20-request-correlation.ts`](./docs/use-cases/20-request-correlation.ts) | Propagate `X-Request-Id` across all retry attempts; log it in `onRetry` / `onFailure` |
| [`21-userland-circuit-breaker.ts`](./docs/use-cases/21-userland-circuit-breaker.ts) | Userland open/half-open/closed breaker composed around the client |
| [`22-rate-limit-aware.ts`](./docs/use-cases/22-rate-limit-aware.ts) | Handle 429 with `respectRetryAfter` + `maxRetryAfter` cap |
| [`23-concurrency-limit.ts`](./docs/use-cases/23-concurrency-limit.ts) | Bound in-flight requests with a userland semaphore (bulkhead) |
| [`24-pagination.ts`](./docs/use-cases/24-pagination.ts) | Paginate cursor-based and offset-based APIs with per-page retry |
| [`25-streaming-download.ts`](./docs/use-cases/25-streaming-download.ts) | Download a large body as `ReadableStream` with `responseType:'stream'` |
| [`26-file-upload.ts`](./docs/use-cases/26-file-upload.ts) | Upload `Uint8Array` / JSON body with retry; stream-body trade-off |
| [`27-graphql-client.ts`](./docs/use-cases/27-graphql-client.ts) | Resilient GraphQL POST — detect application-level errors in a 200 response |
| [`28-bff-proxy.ts`](./docs/use-cases/28-bff-proxy.ts) | BFF proxy — sanitize upstream errors before returning to an untrusted client |
| [`29-webhook-delivery.ts`](./docs/use-cases/29-webhook-delivery.ts) | Deliver webhook events with retry, idempotency key, and `onFailure` audit |
| [`30-nestjs-provider.ts`](./docs/use-cases/30-nestjs-provider.ts) | NestJS `useFactory` provider + injection token; test-swap pattern |
| [`31-testing-with-mock-fetch.ts`](./docs/use-cases/31-testing-with-mock-fetch.ts) | Test your code with a `config.fetch` mock — assert attempts, headers, errors |

---

## Migration from v1

v2 replaces the low-level primitives (`retry()`, `CircuitBreaker`, `extractError`, backoff/jitter functions) with a single `createResilientHttp()` factory that bundles retry, error extraction, idempotency, and hooks into one coherent client.

The v1 sub-path imports (`resilient-http/retry`, `resilient-http/errors`, `resilient-http/core`, `resilient-http/utils`) have been removed. The package now exports a single entry point (`resilient-http`).

See the [CHANGELOG](./CHANGELOG.md) for the full breaking-changes list.

---

## License

MIT
