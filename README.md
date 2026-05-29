# Resilient HTTP

A zero-dependency library for resilient HTTP operations.  
Works with **Node.js 24+**, **Bun 1.0+**, and browsers (ESM).

## Features

- **Single factory**: `createResilientHttp()` — one entry point, config-only surface
- **Retry with Backoff**: Exponential, linear, and constant backoff strategies
- **Jitter Algorithms**: Full, equal, decorrelated, and none (prevents thundering herd)
- **Safe Errors**: `ResilientHttpError` with three kinds, safe-by-default `toJSON()`, and a global brand that survives duplicate module installs
- **Hook System**: `onRequest / onResponse / onRetry / onFailure` interceptors
- **Idempotency Keys**: Frozen per logical operation — safe for payment retries
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

## Configuration

### Instance options (`ResilientHttpOptions`)

Passed once to `createResilientHttp()` — become the defaults for every request.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseURL` | `string` | — | Prepended to every relative request URL |
| `headers` | `Record<string, string>` | `{}` | Default headers for every request |
| `timeout` | `number` (ms) | — | Per-attempt timeout; no new attempt starts after expiry |
| `deadline` | `number` (ms epoch) | — | Absolute deadline; no new attempt starts after `Date.now() >= deadline` |
| `retry` | `RetryOptions` | `{}` | Retry configuration (see below) |
| `hooks` | `HookSet` | `{}` | Lifecycle hooks |
| `responseType` | `ResponseType` | `'auto'` | Body parsing mode |
| `validateStatus` | `(s: number) => boolean` | `s >= 200 && s < 300` | Custom success predicate |
| `fetch` | `typeof globalThis.fetch` | `globalThis.fetch` | Inject a custom fetch (tests, edge runtimes, etc.) |
| `logger` | `Logger` | — | Receives internal warnings (e.g. retry without timeout) |
| `redactHeaders` | `string[]` | `[]` | Additional header names to redact in `toJSON()` output |
| `redactQueryParams` | `string[]` | `[]` | Query param names whose values are hidden in `toJSON()` url |
| `idempotencyKey` | `true \| string \| () => string` | — | Idempotency key applied to all requests (see Payment Preset) |
| `idempotencyHeader` | `string` | `'Idempotency-Key'` | Custom header name for the key |

### Per-request overrides (`RequestConfig`)

Every method accepts an optional `RequestConfig` that overrides the instance options for that request only.

```typescript
const { data } = await client.post<Order>('/orders', {
  json: { item: 'widget', qty: 1 },          // JSON body (sets Content-Type automatically)
  retry: { maxAttempts: 1 },                  // override: no retry for this request
  timeout: 10_000,                            // override: longer timeout
  headers: { 'X-Trace-Id': traceId },        // merged with instance headers
  params: { dryRun: true },                   // appended as query string
  signal: controller.signal,                  // composed with timeout/deadline signal
});
```

### Retry options (`RetryOptions`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxAttempts` | `number` | `1` | Total attempts (1 = no retry) |
| `backoff` | `'exponential' \| 'linear' \| 'constant'` | `'exponential'` | Delay growth strategy |
| `initialDelay` | `number` (ms) | `1000` | Delay before the first retry |
| `maxDelay` | `number` (ms) | `30000` | Hard cap on any single delay |
| `multiplier` | `number` | `2` | Backoff multiplier |
| `jitter` | `'full' \| 'equal' \| 'decorrelated' \| 'none'` | `'full'` | Randomness to prevent thundering herd |
| `retryableStatuses` | `number[]` | `[408, 429, 500, 502, 503, 504]` | HTTP status codes eligible for retry |
| `retryableMethods` | `string[]` | `['GET','HEAD','PUT','DELETE','OPTIONS']` | Methods eligible for retry (POST excluded by default) |
| `respectRetryAfter` | `boolean` | `true` | Honour `Retry-After` response header |
| `maxRetryAfter` | `number` (ms) | `60000` | Max `Retry-After` the engine will honour; gives up if header exceeds this |
| `timeout` | `number` (ms) | — | Per-attempt timeout |
| `deadline` | `number` (ms epoch) | — | Absolute deadline |
| `shouldRetry` | `(ctx: RetryHookContext) => boolean \| Promise<boolean>` | — | Custom gate (cannot override `maxAttempts` or `deadline`) |
| `onRetry` | `(error, attempt, delay) => void` | — | Legacy callback before each retry sleep |
| `onFailure` | `(error, attempts) => void` | — | Callback when all attempts are exhausted |

### Response types (`ResponseType`)

`'auto'` (default) detects from `Content-Type`. Alternatives:

| Value | Parses as |
|-------|-----------|
| `'json'` | `JSON.parse()` |
| `'text'` | `response.text()` |
| `'arrayBuffer'` | `response.arrayBuffer()` |
| `'blob'` | `response.blob()` |
| `'stream'` | Returns `ReadableStream` without buffering |
| `'none'` | `data` is `null`; body is not read |

### Hook system (`HookSet`)

Hooks are ordered arrays (instance first, per-request appended). If a hook throws, the request aborts with `ResilientHttpError { kind: 'setup' }`. Observer hooks (`onRetry`, `onFailure`) never propagate — errors are captured internally.

```typescript
const client = createResilientHttp({
  hooks: {
    onRequest: async (ctx) => {
      // ctx.request is mutable: url, method, headers, body
      ctx.request.headers['X-Request-Id'] = ctx.requestId;
    },
    onResponse: async (ctx) => {
      // ctx.response is the raw Fetch Response (before validateStatus)
    },
    onRetry: (error, attempt, delay) => {
      console.warn(`Retry ${attempt} in ${delay}ms`, error);
    },
    onFailure: (error, attempts) => {
      console.error(`Failed after ${attempts} attempts`, error);
    },
  },
});
```

---

## Payment-safe preset

> Copy-paste this when calling any payment or billing endpoint.

```typescript
import { createResilientHttp } from 'resilient-http';
import { randomUUID } from 'node:crypto';

const paymentClient = createResilientHttp({
  baseURL: process.env['PAYMENT_API_URL'],
  timeout: 10_000,
  deadline: Date.now() + 25_000,    // hard wall: never exceed 25 s total
  retry: {
    maxAttempts: 3,
    backoff: 'exponential',
    jitter: 'full',
    // Limit Retry-After to 5 s — a provider asking for 60 s is a yellow flag
    maxRetryAfter: 5_000,
    // Only retry idempotent methods (POST excluded by default — critical!)
    retryableMethods: ['GET', 'HEAD', 'PUT', 'DELETE'],
  },
  // One key per logical operation, frozen for all retries.
  // If this were () => randomUUID(), each retry would get a NEW key
  // and the processor would treat them as separate charges.
  idempotencyKey: () => randomUUID(),
  redactQueryParams: ['token', 'signature', 'api_key'],
  headers: {
    'Content-Type': 'application/json',
  },
});

// Use PUT (idempotent) when the endpoint supports it.
// For POST endpoints, confirm server-side idempotency via idempotencyKey.
const { data } = await paymentClient.put<ChargeResult>('/charges/ch_123/capture', {
  json: { amount: 1000, currency: 'usd' },
});
```

Why each setting matters:

- **`timeout` + `deadline`**: prevents a slow payment gateway from hanging a request indefinitely. `timeout` caps each attempt; `deadline` caps the total operation.
- **`maxRetryAfter`**: a provider sending `Retry-After: 60` under load should not make your request wait a full minute — set a ceiling and give up early if the provider is degraded.
- **`retryableMethods` without POST**: POST is excluded by default because it is not idempotent. Only retry methods the server treats as safe to repeat.
- **`idempotencyKey: () => randomUUID()`**: the function is called **once** and the result is frozen for every retry attempt. This is what prevents double-charges. A pattern like `idempotencyKey: randomUUID()` (calling at config time) would use the same key for the lifetime of the client — also wrong for multi-request scenarios.

---

## Error handling

```typescript
import { createResilientHttp, isResilientHttpError } from 'resilient-http';

const client = createResilientHttp({ baseURL: 'https://api.example.com' });

try {
  const { data } = await client.get('/resource');
} catch (err) {
  if (isResilientHttpError(err)) {
    // Three kinds of errors:
    if (err.kind === 'response') {
      // Server replied with a non-2xx status
      console.error(err.statusCode, err.classification, err.isRetryable);
    } else if (err.kind === 'network') {
      // Request never reached the server (ECONNREFUSED, abort, timeout, etc.)
      console.error(err.code); // e.g. 'ECONNREFUSED', 'ABORT_ERR', 'TIMEOUT_ERR'
    } else {
      // kind === 'setup': error constructing the request (bad body, hook threw, etc.)
      console.error(err.message);
    }

    // Log-safe representation: body, cause, and meta are excluded
    const logPayload = err.toJSON();
    myLogger.error('request failed', logPayload);
  } else {
    throw err;
  }
}
```

### `ResilientHttpError` properties

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'response' \| 'network' \| 'setup'` | When/where the error occurred |
| `message` | `string` | Human-readable summary (capped at 512 chars) |
| `classification` | `ErrorClassification` | `'network' \| 'timeout' \| 'server' \| 'rate-limit' \| 'client' \| 'authentication' \| 'not-found' \| 'validation' \| 'cancelled' \| 'unknown'` |
| `isRetryable` | `boolean` | Built-in retryability assessment |
| `attempts` | `number` | Total attempts before this error |
| `statusCode` | `number \| undefined` | HTTP status (kind:'response' only) |
| `method` | `string \| undefined` | HTTP method |
| `url` | `string \| undefined` | Request URL (raw — see redaction note) |
| `headers` | `Record<string, string> \| undefined` | Response headers (kind:'response') |
| `body` | `unknown` | Raw response body (present on instance; excluded from `toJSON()`) |
| `code` | `string \| undefined` | Network error code (kind:'network') |
| `requestId` | `string \| undefined` | Stable ID for the logical operation |
| `attemptId` | `string \| undefined` | ID for the specific attempt |

### `isResilientHttpError(e)` — the right way to detect errors

Always prefer `isResilientHttpError(e)` over `e instanceof ResilientHttpError`. The guard uses `Symbol.for('resilient-http.error')` (a global-registry symbol), so it works correctly even when multiple copies of the package are installed (monorepos, version conflicts). `instanceof` breaks in those scenarios.

### `toJSON()` — safe by default

`toJSON()` is intentionally conservative — it never includes `body`, `cause`, or `meta`. This prevents secrets, PII, or large response payloads from leaking into logs or BFF wire responses.

```typescript
// SAFE: send to your logging infra directly
logger.error('payment failed', err.toJSON());

// ALSO SAFE with query param redaction enabled at instance level
// (redactQueryParams: ['token', 'api_key'] in createResilientHttp options)
logger.error('payment failed', err.toJSON()); // url field will have values redacted
```

### BFF / Next.js pattern — sanitize before sending to clients

`err.message` is derived from the server response body. A malicious or misbehaving upstream can inject content into the message. When your BFF forwards error details to an untrusted client (browser, mobile app), always map the message — never forward the raw `err.message`:

```typescript
// pages/api/charge.ts (Next.js API Route or App Router Route Handler)
import { isResilientHttpError } from 'resilient-http';

export async function POST(req: Request) {
  try {
    const result = await paymentClient.post('/charges', { json: await req.json() });
    return Response.json(result.data);
  } catch (err) {
    if (isResilientHttpError(err)) {
      // Log full context internally (body/cause omitted by toJSON() automatically)
      logger.error('charge failed', err.toJSON());

      // Return a safe, controlled message to the browser
      // DO NOT forward err.message — it is server-influenced and may contain
      // injection content, internal paths, or upstream error details.
      const clientMessage = err.kind === 'network'
        ? 'Service temporarily unavailable'
        : `Request failed with status ${err.statusCode ?? 'unknown'}`;

      return Response.json(
        { error: clientMessage },
        { status: err.statusCode ?? 502 }
      );
    }
    throw err;
  }
}
```

---

## Header redaction denylist

The following headers are **always** redacted in `toJSON()` output, regardless of configuration:

```
authorization
cookie
set-cookie
x-api-key
proxy-authorization
authentication
x-auth-token
x-api-token
api-key
www-authenticate
```

Additional names can be added per-instance via `redactHeaders: ['x-my-secret']`.

**Note on URL redaction:** The `url` field in `toJSON()` is emitted **without** query-param redaction unless you configure `redactQueryParams` on the instance. For payment endpoints whose URLs contain tokens or signatures, always set `redactQueryParams: ['token', 'signature', ...]` at the instance level. This is a known follow-up: the base denylist covers headers only; URL query params are opt-in.

---

## Migration from v1

v2 replaces the low-level primitives (`retry()`, `CircuitBreaker`, `extractError`, backoff/jitter functions) with a single `createResilientHttp()` factory that bundles retry, error extraction, idempotency, and hooks into one coherent client.

The v1 sub-path imports (`resilient-http/retry`, `resilient-http/errors`, `resilient-http/core`, `resilient-http/utils`) have been removed. The package now exports a single entry point (`resilient-http`).

See the [CHANGELOG](./CHANGELOG.md) for the full breaking-changes list.

---

## License

MIT
