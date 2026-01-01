# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `halfOpenMaxRequests` option for CircuitBreaker to limit concurrent probe requests in half-open state (default: 1)
- `bucketCount` option for CircuitBreaker to configure sliding window granularity (default: 10)
- Input validation for all CircuitBreaker configuration options with sensible clamping
- Comprehensive tests for half-open request limiting, sliding window buckets, and state transitions
- Custom error extractor registry via `registerExtractor()`, `unregisterExtractor()`, `clearExtractors()`, `getRegisteredExtractors()`
- `ErrorExtractor` interface for integrating custom HTTP clients
- `StateStore` interface for distributed circuit breaker state persistence
- `InMemoryStateStore` default implementation for single-instance deployments
- `CircuitBreakerState` and `BucketData` types for state persistence
- `createInitialState()` and `createInitialBuckets()` helper functions
- `stateStore`, `circuitId`, and `syncInterval` options for CircuitBreaker (distributed support)

### Changed

- **BREAKING**: CircuitBreaker now uses sliding window buckets instead of individual request records
  - Memory complexity reduced from O(N) to O(buckets) where N = requests in window
  - At 2000 RPS with 60s window: ~400 bytes instead of ~9.6MB
  - CPU complexity for pruning reduced from O(N) to O(buckets)
- CircuitBreaker now limits requests in half-open state to prevent thundering herd on recovery
- `getState()` now uses a transition flag to prevent race conditions during concurrent calls

### Deprecated

### Removed

### Fixed

- Race condition in `getState()` that could cause multiple concurrent state transitions
- Memory leak in high-throughput scenarios where individual request records accumulated

### Security
