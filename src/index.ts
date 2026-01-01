/**
 * resilient-http
 *
 * A zero-dependency library for resilient HTTP operations
 * with retry logic, circuit breaker, and error extraction.
 *
 * Works with Node.js, Bun, and browsers.
 *
 * @packageDocumentation
 */

// Types
export * from './types';

// Core algorithms
export type { BackoffConfig, JitterConfig } from './core';
export {
  DEFAULT_BACKOFF_CONFIG,
  exponentialBackoff,
  linearBackoff,
  constantBackoff,
  calculateBackoff,
  DEFAULT_JITTER_CONFIG,
  fullJitter,
  equalJitter,
  decorrelatedJitter,
  noJitter,
  applyJitter,
  calculateDelayWithJitter,
} from './core';

// Utilities
export { sleep, sleepWithAbort, randomBetween, randomUpTo, randomFloatBetween } from './utils';

// Error extraction
export {
  detectClientType,
  classifyError,
  isRetryableError,
  extractError,
  createErrorPredicate,
  defaultRetryPredicate,
  registerExtractor,
  unregisterExtractor,
  clearExtractors,
  getRegisteredExtractors,
} from './errors';

// Retry functionality
export { retry, retryWithSignal, withRetry } from './retry';

// Circuit breaker
export {
  CircuitBreaker,
  CircuitBreakerOpenError,
  withCircuitBreaker,
} from './circuit-breaker';
