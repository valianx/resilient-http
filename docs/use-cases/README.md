# resilient-http — Use-Case Examples

Reference documentation for the stable v2 public API. Each file demonstrates one tool
or feature family in isolation, so you can read any file independently.

## Index

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
