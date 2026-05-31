# Contributing to resilient-http

Thanks for your interest in contributing! This document explains how to set up
the project, the conventions we follow, and how changes get reviewed and shipped.

## Philosophy & scope (read this first)

`resilient-http` is intentionally small and **business-agnostic**. It wraps
`fetch` with retries (backoff/jitter), per-attempt timeout + total deadline,
idempotency-key, interceptor hooks, and standardized errors — **and nothing
else**. Two properties are non-negotiable:

- **Zero runtime dependencies.** The published package must not add any runtime
  dependency. (RxJS is an optional peer for observable integrations only.)
- **Request-only.** Orchestration — circuit breakers, bulkheads, rate-limiters,
  queues — lives in *consumer* code, not in this library. Userland recipes for
  those patterns live in [`docs/use-cases/`](./docs/use-cases).

Before proposing a feature, weigh it against that scope. Orchestration concerns
(circuit breakers, bulkheads, rate-limiters) and anything that would add a runtime
dependency are out of scope and will likely be declined — but a `docs/use-cases/`
recipe that shows how to build the pattern in userland is always welcome.

## Prerequisites

- **Node.js >= 24**
- **pnpm** (the repo pins `pnpm@11.x` via `packageManager`; run `corepack enable`
  to get the right version automatically)
- **Bun** (optional) — CI runs both Bun and the Node test runner. You can
  contribute with only Node installed.

## Setup

```bash
git clone https://github.com/valianx/resilient-http.git
cd resilient-http
pnpm install
```

## Golden commands

```bash
pnpm dev          # build in watch mode (tsup)
pnpm build        # build ESM + CJS + .d.ts (tsup)
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm format       # prettier --write src
pnpm test         # run tests with Bun
pnpm test:node    # run tests with the Node test runner (tsx)
```

Before opening a PR, make sure these all pass:

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test:node
```

## Project structure

```
src/
  index.ts            # public barrel — the ONLY public surface
  client/             # createResilientHttp factory, request builder, response
  retry/              # retry engine
  core/               # backoff, jitter, classify, message, signals
  hooks/              # hook runner
  errors/             # ResilientHttpError + isResilientHttpError
  utils/              # sleep, random
  types/              # all public + internal types
tests/                # *.test.ts (run by both Bun and Node runners)
docs/
  configuration.md    # full options reference
  use-cases/          # compilable, framework-agnostic examples
```

Anything not re-exported from `src/index.ts` is **internal** and may change
without a major version bump. Keep new internal helpers out of the barrel unless
they are meant to be public API.

## Conventions

- **TypeScript, strict.** No `any` in public types; prefer precise unions.
- **JSDoc** every public API (the `.d.ts` is the documentation consumers read).
- **Match the surrounding code** — comment density, naming, and idioms.
- **No new runtime dependencies.** A PR that adds one will be declined.
- **Conventional Commits** for commit messages and PR titles:
  `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:` …
  Example: `fix(errors): surface nested connection-level codes`.
- **Branch naming:** `feature/*`, `fix/*`, `docs/*`, `chore/*`, `test/*`.

### Security-sensitive areas

The error path is on the way to production logs and BFF wire responses. When
touching `src/errors/`, `src/core/message.ts`, or anything that feeds
`ResilientHttpError.toJSON()`:

- Never emit raw bodies, raw headers, raw query strings, host, or port into the
  `message` or `toJSON()` output without explicit redaction.
- Keep `toJSON()` safe-by-default: it must continue to exclude `body`, `cause`,
  and `meta`, and redact sensitive headers / query params.
- The message cap (`DEFAULT_MAX_MESSAGE_SIZE`) exists to stop large bodies from
  leaking via `message` — do not remove it.

## Tests

- Every behavior change needs a test. Bug fixes should add a **failing-first**
  regression test that the fix turns green.
- Tests live in `tests/` and must pass under **both** runners (`pnpm test` with
  Bun and `pnpm test:node`). The Node runner uses `node:test` + `node:assert`.
- Prefer an **injected fetch** (`config.fetch`) for deterministic tests; reserve
  real-network assertions for the separate e2e consumer repos
  (`resilient-http-e2e`, `resilient-http-e2e-nextjs`).
- Cover the failure modes, not just the happy path (timeouts, network errors,
  status classification, hook/keygen throwing, idempotency frozen across retries).

## Pull request process

1. Fork (or branch, if you have access) and create a topic branch.
2. Make your change with tests and JSDoc.
3. Run `pnpm lint && pnpm typecheck && pnpm build && pnpm test:node`.
4. Add an entry to [`CHANGELOG.md`](./CHANGELOG.md) under a new version heading
   describing the change (Keep a Changelog style; patch/minor/major per SemVer).
5. Open a PR against `main` with a Conventional-Commits title and a clear
   description (what changed, why, and how it was verified).
6. CI must be green (lint, typecheck, build, Node tests, Bun tests). `main` is
   protected — changes land only via reviewed PRs with passing checks.

We keep documents **consolidated**: no version markers, no "previously decided",
no inline changelog inside source files. Update the canonical doc in place.

## Releasing (maintainers)

- **Publish:** bump the version in `package.json`, update `CHANGELOG.md`, merge to
  `main`, then create a **GitHub Release** for the tag. The `publish.yml` workflow
  runs lint/typecheck/build/tests/publint/attw and publishes to npm with
  provenance using the `NPM_TOKEN` secret.
- **Deprecate a version:** Actions tab → **"Deprecate version"** → *Run workflow*
  → enter the version and a message (an empty message un-deprecates). This uses
  the repo token; no local npm auth is needed. (The npmjs.com UI has no deprecate
  button — `npm deprecate` is the only way.)

## Questions

Open an issue describing what you want to do before investing in a large change,
especially anything that touches the public API or the library's scope.
Thanks for contributing!
