/**
 * resilient-http
 *
 * A zero-dependency library for resilient HTTP operations
 * with retry logic and error classification.
 *
 * Works with Node.js 24+.
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
  ErrorKind,
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

// Error classification primitives (public API)
export { classifyError, isRetryableError } from './errors';

// ResilientHttpError — canonical error class (v2 public API)
export { ResilientHttpError, isResilientHttpError } from './errors';
export type { ResilientHttpErrorInit } from './errors';

// NOTE: retry engine (executeWithRetry / executeWithRetryAndSignal) is INTERNAL.
// It is NOT part of the public API. Use it only from within src/.
// NOTE: extractMessageFromBody is INTERNAL to src/ — not exposed here.
