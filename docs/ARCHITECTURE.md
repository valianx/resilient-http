# resilient-http — Architecture Note (v2.x)

**Version:** 2.x
**Last Updated:** 2026-06-11
**License:** MIT
**Type:** Open-source npm package

---

## Overview

`resilient-http` is a zero-dependency, request-only HTTP resilience library for Node.js 22+,
Bun 1.0+, and browsers. It wraps any `fetch`-compatible call with retry (backoff + jitter),
per-attempt timeouts, absolute deadlines, caller-abort compositing, `Retry-After` respect,
structured error extraction, and a lifecycle hook system.

**Permanently out of scope (removed in v2.0.0):** circuit breakers, bulkheads, rate limiters,
distributed state stores, RxJS integration, multi-extractor chains. Orchestration belongs in
consumer code.

---

## Design Principles

- **Zero runtime dependencies** — no external packages at runtime.
- **Dual ESM + CommonJS output** via tsup; conditional exports for Node / Bun / browsers.
- **Node.js 22+** minimum floor — uses `AbortSignal.any` (available since Node 20.3).
- **Config-only public surface** — one factory (`createResilientHttp`), one error class
  (`ResilientHttpError`), one guard (`isResilientHttpError`).
- **Fail-safe method gate** — unknown HTTP method → no retry, to prevent double-submit on
  non-idempotent operations. Default retryable methods: `GET HEAD PUT DELETE OPTIONS`
  (POST and PATCH excluded).
- **Exposes-everything error philosophy** — `toJSON()` surfaces `cause`, `body`, and `meta`;
  the consumer owns redaction. Built-in controls: sensitive-header denylist +
  512-char message cap.

---

## Module Tree

```
src/
├── index.ts                  # Public barrel: createResilientHttp, ResilientHttpError, types
├── types/
│   └── index.ts              # All TypeScript type definitions (no runtime code)
├── client/
│   ├── index.ts              # Client barrel re-export
│   ├── create.ts             # createResilientHttp factory + method shortcuts
│   ├── request-builder.ts    # RequestBuilder — constructs fetch Request per attempt
│   └── response.ts           # parseResponse — body parsing, validateStatus
├── hooks/
│   ├── index.ts              # Hooks barrel re-export
│   └── run.ts                # runRequestHooks / runResponseHooks / runRetryObservers / runFailureObservers
├── retry/
│   ├── index.ts              # Internal barrel (not re-exported from src/index.ts)
│   └── engine.ts             # executeWithRetry / executeWithRetryAndSignal — core loop
├── core/
│   ├── index.ts              # Core barrel (not re-exported from src/index.ts)
│   ├── backoff.ts            # calculateBackoff — exponential / linear / constant formulas
│   ├── jitter.ts             # applyJitter — full / equal / decorrelated / none algorithms
│   ├── classify.ts           # classifyError / isRetryableError + RETRYABLE_STATUS_CODES set
│   ├── validate.ts           # validateDeadline guardrail (rejects relative values < 1e12)
│   ├── signals.ts            # buildAttemptSignal / isCallerAbort — AbortSignal composition
│   └── message.ts            # extractMessageFromBody — response-body → human message
├── errors/
│   ├── index.ts              # Errors barrel re-export
│   └── resilient-http-error.ts  # ResilientHttpError class + isResilientHttpError guard
└── utils/
    ├── index.ts              # Utils barrel re-export
    ├── sleep.ts              # sleep() / sleepWithAbort()
    └── random.ts             # randomBetween() / randomFloatBetween()
```

---

## Error-Kind Model

Every failure the client surfaces is a `ResilientHttpError` with one of three `kind` values:

| Kind | When |
|------|------|
| `'response'` | The server replied; status code failed `validateStatus`. |
| `'network'` | The request never reached the server (connection refused, timeout, abort, DNS failure, etc.). |
| `'setup'` | An error constructing or configuring the request (bad body serialization, hook threw, invalid deadline, etc.). |

---

## Retry Engine (`src/retry/engine.ts`)

The engine is the hot path. Key behaviors:

1. **Method gate** — checked via `classifyAttemptError` before every retry decision.
   Unknown method → `isRetryable: false`. Never bypass.
2. **Signal composition** — `buildAttemptSignal` merges caller signal + per-attempt
   timeout + deadline into one composite `AbortSignal` via `AbortSignal.any`.
3. **`Retry-After` parsing** — supports delta-seconds and HTTP-date formats (RFC 9110).
   If `retryAfterMs > maxRetryAfter` the engine gives up rather than waiting.
4. **Deadline hard cap** — checked before each attempt and before sleeping. Sleeping
   through a deadline is not permitted.
5. **`shouldRetry` fail-closed** — if the custom hook throws, the engine stops retrying
   and re-throws the original operation error.
6. **Never throws `undefined`** — when the deadline hard-cap breaks the loop before
   any attempt runs, a `DOMException('TimeoutError')` is thrown.

---

## Dependency Hierarchy (no circular deps)

```
utils        (no deps)
types        (no deps)
core         → types, utils
errors       → types
hooks        → types
retry/engine → types, core, utils
client       → types, core, errors, hooks, retry/engine, utils
```

---

## Build Configuration

- **Build tool:** tsup 8.x — dual ESM + CJS, sourcemaps, `.d.ts` + `.d.cts` generated.
- **TypeScript target:** ES2022 / lib ES2023, `moduleResolution: Bundler`.
- **Package manager:** pnpm (frozen lockfile in CI).
- **Test runners:** Bun test (primary) + Node.js `--test` runner (secondary).
- **CI matrix:** Node 22 / 24 / 26 + Bun job.
- **Mutation testing:** Stryker 9.x, nightly report-only.

---

## Public API (v2.x)

```typescript
import {
  createResilientHttp,      // factory
  ResilientHttpError,       // error class
  isResilientHttpError,     // brand guard (prefer over instanceof)
} from 'resilient-http';

// Supporting types
import type {
  ResilientHttpOptions,
  RequestConfig,
  ResilientResponse,
  ResilientHttpClient,
  ResponseType,
  RetryOptions,
  HookSet,
  HookContext,
  ErrorClassification,
  ErrorKind,
  StandardizedError,
} from 'resilient-http';
```

There are no sub-path imports. `src/index.ts` is the sole public entry point.
