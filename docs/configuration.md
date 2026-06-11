# Configuration Reference

Complete reference for every option accepted by `resilient-http`.

---

## Table of contents

- [Instance options — `ResilientHttpOptions`](#instance-options--resilienthttpoptions)
- [Per-request overrides — `RequestConfig`](#per-request-overrides--requestconfig)
- [Retry options — `RetryOptions`](#retry-options--retryoptions)
- [Response types — `ResponseType`](#response-types--responsetype)
- [Hook system — `HookSet`](#hook-system--hookset)
- [Error handling — `ResilientHttpError`](#error-handling--resilienthttperror)
  - [`ResilientHttpError` properties](#resilienthttperror-properties)
  - [`isResilientHttpError(e)`](#isresilienthttperrore)
  - [`toJSON()` — full error, headers redacted](#tojson--full-error-headers-redacted)
  - [BFF / server-side pattern](#bff--server-side-pattern)
- [Redaction denylist](#redaction-denylist)

---

## Instance options — `ResilientHttpOptions`

Passed once to `createResilientHttp()`. Every field becomes the default for all requests
made through that client instance.

```typescript
import { createResilientHttp } from 'resilient-http';

const client = createResilientHttp({
  baseURL: 'https://api.example.com',
  timeout: 5_000,
  retry: { maxAttempts: 3, backoff: 'exponential', jitter: 'full' },
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `baseURL` | `string` | — | Prepended to every relative request URL. See [03-base-url-and-params.ts](./use-cases/03-base-url-and-params.ts). |
| `headers` | `Record<string, string>` | `{}` | Default headers merged into every request. Per-request headers override on a key-by-key basis. See [16-headers-and-logger.ts](./use-cases/16-headers-and-logger.ts). |
| `timeout` | `number` (ms) | — | Per-attempt timeout. No new attempt starts after expiry. See [09-timeout-and-deadline.ts](./use-cases/09-timeout-and-deadline.ts). |
| `deadline` | `number` (ms epoch) | — | Absolute deadline as `Date.now()`-compatible timestamp. No new attempt starts once `Date.now() >= deadline`. See [09-timeout-and-deadline.ts](./use-cases/09-timeout-and-deadline.ts). |
| `retry` | `RetryOptions` | `{}` | Retry configuration — see [Retry options](#retry-options--retryoptions). |
| `hooks` | `HookSet` | `{}` | Lifecycle hooks — see [Hook system](#hook-system--hookset). |
| `responseType` | `ResponseType` | `'auto'` | Body parsing mode — see [Response types](#response-types--responsetype). |
| `validateStatus` | `(s: number) => boolean` | `s >= 200 && s < 300` | Custom success predicate. See [11-validate-status.ts](./use-cases/11-validate-status.ts). |
| `fetch` | `typeof globalThis.fetch` | `globalThis.fetch` | Inject a custom fetch implementation (tests, edge runtimes, etc.). |
| `logger` | `Logger` | — | Receives internal warnings (e.g. retry configured without timeout). See [16-headers-and-logger.ts](./use-cases/16-headers-and-logger.ts). |
| `redactHeaders` | `string[]` | `[]` | Additional header names to redact in `toJSON()` output. Merged with the built-in denylist. See [13-redaction.ts](./use-cases/13-redaction.ts). |
| `redactQueryParams` | `string[]` | `[]` | Query-param names whose values are replaced with `[REDACTED]` in the `toJSON()` url field. See [13-redaction.ts](./use-cases/13-redaction.ts). |
| `idempotencyKey` | `true \| string \| (() => string)` | — | Idempotency key applied to all requests. The key is frozen per logical operation — all retry attempts reuse the same key. See [15-idempotency-key.ts](./use-cases/15-idempotency-key.ts). |
| `idempotencyHeader` | `string` | `'Idempotency-Key'` | Header name used to attach the idempotency key. See [15-idempotency-key.ts](./use-cases/15-idempotency-key.ts). |

### `idempotencyKey` variants

| Value | Behaviour |
|---|---|
| `true` | Generate a random UUID once per logical operation; same key across all retries. |
| `string` | Use this static value for every request on this client instance. |
| `() => string` | Called **once** per logical operation; the returned value is frozen for all retries. |

---

## Per-request overrides — `RequestConfig`

Every method shortcut accepts an optional `RequestConfig` that overrides instance options
for that request only.

```typescript
const { data } = await client.post<Order>('/orders', {
  json: { item: 'widget', qty: 1 },      // JSON body (sets Content-Type automatically)
  retry: { maxAttempts: 1 },             // override: disable retry for this request
  timeout: 10_000,                        // override: longer per-attempt timeout
  headers: { 'X-Trace-Id': traceId },   // merged with instance headers
  params: { dryRun: true },              // appended as query string
  signal: controller.signal,             // composed with timeout/deadline signal
});
```

| Option | Type | Description |
|---|---|---|
| `method` | `string` | Override the HTTP method (prefer the method shortcuts instead). |
| `params` | `Record<string, string \| number \| boolean \| null \| undefined>` | Query-string parameters appended to the URL via `URLSearchParams`. See [03-base-url-and-params.ts](./use-cases/03-base-url-and-params.ts). |
| `headers` | `Record<string, string>` | Merged shallowly with instance headers; per-request values win on conflicts. See [16-headers-and-logger.ts](./use-cases/16-headers-and-logger.ts). |
| `body` | `unknown` | Raw request body. Serialisable objects are JSON-encoded; strings/`Uint8Array` pass through. Streams require retry to be OFF (`maxAttempts === 1`). |
| `json` | `unknown` | Shorthand JSON body — object is encoded and `Content-Type: application/json` is set automatically. Takes precedence over `body` when both are present. |
| `responseType` | `ResponseType` | Override the response parsing mode for this request. |
| `validateStatus` | `(s: number) => boolean` | Override the success predicate for this request. See [11-validate-status.ts](./use-cases/11-validate-status.ts). |
| `timeout` | `number` (ms) | Override the per-attempt timeout. |
| `deadline` | `number` (ms epoch) | Override the absolute deadline. |
| `retry` | `RetryOptions` | Override the retry configuration. |
| `hooks` | `HookSet` | Additional hooks appended after instance hooks. |
| `signal` | `AbortSignal` | Caller-supplied abort signal; composed with the per-attempt timeout/deadline signal. See [09-timeout-and-deadline.ts](./use-cases/09-timeout-and-deadline.ts). |
| `idempotencyKey` | `IdempotencyKeyOption` | Override the idempotency key for this request. |

---

## Retry options — `RetryOptions`

Nested under `retry` at both instance level and per-request level.

| Option | Type | Default | Description |
|---|---|---|---|
| `maxAttempts` | `number` | `1` | Total attempts (1 = no retry). Callers must opt in to retries. See [04-retry-and-method-gate.ts](./use-cases/04-retry-and-method-gate.ts). |
| `backoff` | `'exponential' \| 'linear' \| 'constant'` | `'exponential'` | Delay growth strategy between attempts. See [05-backoff-strategies.ts](./use-cases/05-backoff-strategies.ts). |
| `initialDelay` | `number` (ms) | `1000` | Delay before the first retry. See [05-backoff-strategies.ts](./use-cases/05-backoff-strategies.ts). |
| `maxDelay` | `number` (ms) | `30000` | Hard cap on any single inter-attempt delay. See [05-backoff-strategies.ts](./use-cases/05-backoff-strategies.ts). |
| `multiplier` | `number` | `2` | Growth multiplier for `exponential` and `linear` strategies. See [05-backoff-strategies.ts](./use-cases/05-backoff-strategies.ts). |
| `jitter` | `'full' \| 'equal' \| 'decorrelated' \| 'none'` | `'full'` | Randomness applied to computed delays to spread retry load. See [06-jitter.ts](./use-cases/06-jitter.ts). |
| `retryableStatuses` | `number[]` | `[408, 429, 500, 502, 503, 504]` | HTTP status codes eligible for retry. See [04-retry-and-method-gate.ts](./use-cases/04-retry-and-method-gate.ts). |
| `retryableMethods` | `string[]` | `['GET','HEAD','PUT','DELETE','OPTIONS']` | HTTP methods eligible for retry. `POST` is excluded by default because it is not idempotent. See [04-retry-and-method-gate.ts](./use-cases/04-retry-and-method-gate.ts). |
| `respectRetryAfter` | `boolean` | `true` | Honour the `Retry-After` response header when present. See [08-retry-after.ts](./use-cases/08-retry-after.ts). |
| `maxRetryAfter` | `number` (ms) | `60000` | Maximum `Retry-After` value the engine will honour. The engine gives up rather than waiting longer. See [08-retry-after.ts](./use-cases/08-retry-after.ts). |
| `timeout` | `number` (ms) | — | Per-attempt timeout (alternative placement; same effect as the top-level option). |
| `deadline` | `number` (ms epoch) | — | Absolute deadline (alternative placement). |
| `shouldRetry` | `(ctx: RetryHookContext) => boolean \| Promise<boolean>` | — | Custom retry gate. Return `false` to stop. If this function throws, the engine fails closed — it does NOT retry. Cannot override `maxAttempts` or `deadline`. See [07-should-retry.ts](./use-cases/07-should-retry.ts). |
| `onRetry` | `(error, attempt, delay) => void` | — | Legacy observer callback invoked before each retry sleep. Prefer `hooks.onRetry` for new code. |
| `onFailure` | `(error, attempts) => void` | — | Callback invoked when all attempts are exhausted. |

### Backoff strategies

| Strategy | Formula |
|---|---|
| `exponential` | `initialDelay × multiplier^(attempt-1)`, capped at `maxDelay` |
| `linear` | `initialDelay × attempt`, capped at `maxDelay` |
| `constant` | `initialDelay` on every attempt |

Jitter is applied after the formula. See [05-backoff-strategies.ts](./use-cases/05-backoff-strategies.ts) and [06-jitter.ts](./use-cases/06-jitter.ts).

---

## Response types — `ResponseType`

Controls how the response body is parsed. Set at instance level or per-request.

| Value | Parses as |
|---|---|
| `'auto'` (default) | Detects from `Content-Type`: `application/json` → JSON, `text/*` → text, otherwise `ArrayBuffer`. |
| `'json'` | `JSON.parse()` — throws on non-JSON bodies. |
| `'text'` | `response.text()`. |
| `'arrayBuffer'` | `response.arrayBuffer()`. |
| `'blob'` | `response.blob()`. |
| `'stream'` | Returns `ReadableStream` without buffering the body. |
| `'none'` | `data` is `null`; body is not read. |

See [10-response-types.ts](./use-cases/10-response-types.ts).

---

## Hook system — `HookSet`

Hooks execute in order: instance hooks run first, per-request hooks append after.

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

| Hook | Signature | When it runs | Error behaviour |
|---|---|---|---|
| `onRequest` | `(ctx: HookContext) => void \| Promise<void>` | Once per attempt, before the request is sent. May mutate `ctx.request`. | Throwing aborts with `ResilientHttpError { kind: 'setup' }`. |
| `onResponse` | `(ctx: HookContext) => void \| Promise<void>` | After each response is received, before `validateStatus`. May inspect context. | Throwing aborts with `ResilientHttpError { kind: 'setup' }`. |
| `onRetry` | `(error, attempt, delay) => void \| Promise<void>` | Before sleeping between attempts. Read-only observer. | Errors are silently captured — never propagated. |
| `onFailure` | `(error, attempts) => void \| Promise<void>` | When all attempts are exhausted. Read-only observer. | Errors are silently captured — never propagated. |

Each field accepts a single hook or an ordered array of hooks.

See [14-hooks.ts](./use-cases/14-hooks.ts).

### `HookContext` fields

| Field | Type | Description |
|---|---|---|
| `request` | `HookRequestSpec` | Mutable request spec (url, method, headers, body). Reset from the original spec at the start of each attempt. |
| `attempt` | `number` | 1-based attempt number. |
| `attemptId` | `string` | Unique ID for this specific attempt. |
| `requestId` | `string` | Stable ID for the entire logical operation (all retries share this). |
| `elapsed` | `number` | Milliseconds elapsed since the first attempt started. |
| `error` | `unknown` | Error from the previous attempt (`undefined` on the first attempt). |
| `response` | `unknown` | Response from the previous attempt (`undefined` on first attempt or when the attempt threw). |
| `meta` | `Record<string, unknown>` | Arbitrary metadata that persists across all attempts. Attached to the final `ResilientHttpError`. Never logged automatically. |

---

## Error handling — `ResilientHttpError`

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
      // Request never reached the server
      console.error(err.code); // e.g. 'ECONNREFUSED', 'ABORT_ERR', 'TIMEOUT_ERR'
    } else {
      // kind === 'setup': error constructing the request (bad body, hook threw, etc.)
      console.error(err.message);
    }

    // toJSON() exposes the full structured error (cause/body/meta) for diagnosis;
    // sensitive headers are redacted and the message is capped. Sanitize before
    // sending to an untrusted client (see "BFF / server-side pattern" below).
    const logPayload = err.toJSON();
    myLogger.error('request failed', logPayload);
  } else {
    throw err;
  }
}
```

See [12-errors.ts](./use-cases/12-errors.ts) for the full walkthrough.

### `ResilientHttpError` properties

| Property | Type | Description |
|---|---|---|
| `kind` | `'response' \| 'network' \| 'setup'` | When/where the error occurred. |
| `message` | `string` | Human-readable summary, capped at 512 characters. |
| `classification` | `ErrorClassification` | `'network' \| 'timeout' \| 'server' \| 'rate-limit' \| 'client' \| 'authentication' \| 'not-found' \| 'validation' \| 'cancelled' \| 'unknown'` |
| `isRetryable` | `boolean` | Built-in retryability assessment. |
| `attempts` | `number` | Total attempts made before this error was thrown. |
| `statusCode` | `number \| undefined` | HTTP status code (`kind: 'response'` only). |
| `method` | `string \| undefined` | HTTP method. |
| `url` | `string \| undefined` | Request URL — raw, not redacted (see `toJSON()` for the redacted version). |
| `headers` | `Record<string, string> \| undefined` | Response headers (`kind: 'response'` only). |
| `body` | `unknown` | Raw response body. Present on the instance and **included in `toJSON()`** (v2.2+). |
| `code` | `string \| undefined` | Network error code (`kind: 'network'` only). |
| `requestId` | `string \| undefined` | Stable ID for the logical operation. |
| `attemptId` | `string \| undefined` | ID for the specific attempt that failed. |
| `meta` | `Record<string, unknown> \| undefined` | Arbitrary metadata from hooks. **Included in `toJSON()`** (v2.2+). |

### `isResilientHttpError(e)`

Always prefer `isResilientHttpError(e)` over `e instanceof ResilientHttpError`.
The guard uses `Symbol.for('resilient-http.error')` — a global-registry symbol — so it
works correctly even when multiple copies of the package are installed (monorepos, version
conflicts). `instanceof` breaks in those scenarios.

### `toJSON()` — full error, headers redacted

`toJSON()` returns the **full structured error** — including `cause` (serialized),
`body`, and `meta` — so failures are diagnosable. It is **not** a redaction boundary:
the library cannot know which fields are sensitive in your app, so it exposes the data
and lets you decide what to redact. The two controls it *does* own are applied
automatically:

- **Sensitive headers** are replaced with `[REDACTED]` (built-in denylist + your
  `redactHeaders`).
- **`message`** is capped at 512 characters, so a large body cannot leak via the summary.

```typescript
// Safe for server-side logging: headers redacted, message capped
logger.error('request failed', err.toJSON());
```

The `url` field is redacted when `redactQueryParams` is configured. **Do not forward
`toJSON()` verbatim to an untrusted client** — build a sanitized projection (see below).

### BFF / server-side pattern

`err.message` is derived from the server response body, and `toJSON()` now includes
`body`, `cause`, and `meta`. A misbehaving upstream may embed sensitive content. When
returning error details to an untrusted client (browser, mobile app), **never forward
`err.message` or `err.toJSON()` verbatim** — build a controlled projection:

```typescript
// Example: Next.js App Router route handler
import { isResilientHttpError } from 'resilient-http';

export async function POST(req: Request) {
  try {
    const result = await apiClient.post('/resource', { json: await req.json() });
    return Response.json(result.data);
  } catch (err) {
    if (isResilientHttpError(err)) {
      // Full context logged internally — toJSON() includes body/cause/meta, so keep it server-side
      logger.error('request failed', err.toJSON());

      // Return a controlled message to the browser
      // DO NOT forward err.message — it is server-influenced
      const clientMessage =
        err.kind === 'network'
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

See [13-redaction.ts](./use-cases/13-redaction.ts) for the BFF sanitization pattern.

---

## Redaction denylist

The following headers are **always** redacted in `toJSON()` output regardless of
configuration:

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

Additional names can be added per instance via `redactHeaders: ['x-my-secret']`.

Additional query-param names can be redacted via `redactQueryParams: ['token', 'api_key']`.

See [13-redaction.ts](./use-cases/13-redaction.ts).
