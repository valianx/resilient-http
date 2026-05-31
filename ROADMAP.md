# Roadmap

`resilient-http` is intentionally small and **business-agnostic**: it wraps
`fetch` with retries (backoff/jitter), per-attempt timeout + total deadline,
idempotency-key, interceptor hooks, and standardized errors — nothing more.
Orchestration (circuit breakers, bulkheads, queues) lives in consumer code by
design. This roadmap therefore favors **correctness, safety, and observability**
over new features. We will not add scope that belongs in the application layer.

Status legend: ✅ done · 🔜 planned · 💭 decision needed · ❄️ deliberately out of scope

## Current state (v2.0.3)

- ✅ Published to npm with provenance; `latest = 2.0.3`.
- ✅ Versions with known bugs deprecated (`2.0.0` timeout no-op, `2.0.1`
  Retry-After). `2.0.2`, `2.0.3` active.
- ✅ Two end-to-end consumer suites prove framework- and runtime-agnosticism:
  `resilient-http-e2e` (NestJS, Node) and `resilient-http-e2e-nextjs`
  (Next.js — Node server runtime via Vitest + real browser via Playwright).
- ✅ Docs: slim README, `docs/configuration.md`, and `docs/use-cases/` (34
  examples incl. Backend/Frontend framework integration).

## Planned / open

### 💭 Decision: safer default for URL redaction in `toJSON()`
Today `redactQueryParams` is **opt-in** — only the named params are redacted, so
a URL carrying a secret in an *unnamed* query param is emitted as-is by
`toJSON()`. Options to evaluate before wide adoption:
- redact-all-query by default (most conservative; opt back in per-param), or
- a built-in denylist of common secret param names (`token`, `apikey`, `sig`…).
This touches a security-sensitive default and may be a minor breaking change to
serialized output, so it is a conscious decision, not an automatic fix.

### 💭 Decision: remove or keep the unexported circuit-breaker source
`src/circuit-breaker/` still exists but is **intentionally not exported** from
the public barrel (v2 moved orchestration to consumer code). It is currently dead
weight plus a test (`tests/circuit-breaker.test.ts`) for a non-public surface.
Decide: delete it for consistency with the stated philosophy, or keep it as an
internal/experimental module with a documented reason. (Likewise audit
`tests/error-extraction.test.ts` — the extractor was removed in the v2 refactor;
confirm the test now targets the migrated `core/classify` or remove it.)

### 🔜 Regression test for the network-error message fix (2.0.3) in the e2e repos
The 2.0.3 fix (surface nested `ECONNREFUSED`/`ENOTFOUND` codes in
`kind:'network'` messages) is covered by unit tests in this repo. Add a
real-connection-refused regression test to both e2e consumer repos so the
behavior is also verified against a real runtime end-to-end.

### 💭 Decision: deprecate the v1 line
`1.0.0` is the pre-v2 API (different surface). It is **not** deprecated — it has
no bugs, it is just old, and `npm install` already resolves to v2. Deprecate only
if we want to actively signal "v1 is unmaintained; migrate to v2". The manual
`deprecate.yml` workflow is in place if/when we choose to.

## Deliberately out of scope (❄️)

- Circuit breakers, bulkheads, rate-limiters as built-ins — these are
  orchestration concerns for the consumer; the library only owns the request.
  (Userland recipes live in `docs/use-cases/`.)
- Being an HTTP client — the library wraps any `fetch`, it does not replace one.
- Runtime dependencies — zero-dependency is a core property.

## Operational notes

- **Release**: create a GitHub Release for the tag → `publish.yml` runs
  lint/typecheck/build/test/publint/attw and publishes with provenance.
- **Deprecate**: Actions tab → "Deprecate version" → Run workflow (version +
  message; empty message un-deprecates). No local npm auth needed.
