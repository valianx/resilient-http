# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] — 2026-05-29

### Breaking Changes

- **API surface replaced.** The v1 public API has been removed: `retry()`, `retryWithSignal()`, `withRetry()`, `CircuitBreaker`, `withCircuitBreaker()`, `registerExtractor()`, multi-client error extractors (`AxiosExtractor`, `GotExtractor`, etc.), `StateStore` / `InMemoryStateStore`, and the RxJS observable integration are all gone. The library now exposes a single factory: `createResilientHttp()`.
- **Retry status codes.** HTTP 409 Conflict removed from the default `retryableStatuses` list. Only server-side idempotent errors (503, 504, etc.) are retried by default.
- **Node.js minimum.** Engine requirement bumped to `>=24.0.0` (was `>=18.0.0`).
- **Package manager.** Migrated from yarn to pnpm (`pnpm@11.1.3`). `yarn.lock` removed; `pnpm-lock.yaml` is the canonical lockfile.

### Added

- `createResilientHttp()` factory — fetch-first wrapper with unified retry + backoff configuration.
- Changesets for automated versioning and CHANGELOG generation going forward.

### Removed

- `retry()`, `retryWithSignal()`, `withRetry()` — removed from public API.
- `CircuitBreaker` class and `withCircuitBreaker()` — removed.
- Custom error extractor registry (`registerExtractor`, `unregisterExtractor`, `clearExtractors`, `getRegisteredExtractors`).
- `StateStore` / `InMemoryStateStore` / `CircuitBreakerState` / `BucketData` types.
- Multi-client error extractors (Axios, Got, Undici, node-fetch specific).
- `halfOpenMaxRequests`, `bucketCount` CircuitBreaker options.
- Sub-path exports: `resilient-http/circuit-breaker`, `resilient-http/observable`.

### Changed

- Zero runtime dependencies maintained — pnpm is a dev toolchain change only.
- CI now runs exclusively on Node 24 (`matrix: node-version: [24]`).

## [1.0.0] — Initial release

- `retry()`, `retryWithSignal()`, `withRetry()` with exponential/linear/constant backoff and full/equal/decorrelated/none jitter.
- `CircuitBreaker` with sliding window buckets, half-open limiting, and distributed `StateStore` interface.
- Multi-client error extraction (Axios, Fetch, Got, Undici, node-fetch) with custom extractor registry.
- Works with Node.js 18+, Bun 1.0+, and browsers (ESM).
