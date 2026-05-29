/**
 * resilient-http
 *
 * A zero-dependency library for resilient HTTP operations
 * with retry logic and error extraction.
 *
 * Works with Node.js 22+.
 *
 * @packageDocumentation
 */

// Types
export type {
  Logger,
  BackoffStrategy,
  JitterStrategy,
  RetryCallback,
  FailureCallback,
  RetryHookContext,
  RetryOptions,
  ErrorClassification,
  HttpClientType,
  ErrorExtractor,
  StandardizedError,
} from './types';

// Core algorithms (public API)
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

// Error extraction (public API)
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

// NOTE: retry engine (executeWithRetry / executeWithRetryAndSignal) is INTERNAL.
// It is NOT part of the public API. Use it only from within src/.
