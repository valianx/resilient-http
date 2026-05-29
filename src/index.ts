/**
 * resilient-http
 *
 * A zero-dependency library for resilient HTTP operations.
 * Works with Node.js 24+, Bun 1.0+, and browsers (ESM).
 *
 * Public surface (config-only):
 * - createResilientHttp: the main client factory
 * - ResilientHttpError / isResilientHttpError: canonical error class + guard
 * - Types: ResilientHttpOptions, RequestConfig, ResilientResponse, and supporting types
 *
 * NOT exported (internal):
 * - executeWithRetry / executeWithRetryAndSignal (retry engine)
 * - RequestBuilder (request construction)
 * - runRequestHooks / runResponseHooks / runRetryObservers / runFailureObservers
 * - classifyError / isRetryableError / classifyError
 * - extractMessageFromBody
 * - buildAttemptSignal / isCallerAbort
 * - backoff/jitter primitives (still available via the ./core sub-path for advanced use)
 * - sleep / sleepWithAbort / randomBetween (available via ./utils sub-path)
 *
 * @packageDocumentation
 */

// ============================================================================
// Main client factory — the primary public API
// ============================================================================

export { createResilientHttp } from './client';

// ============================================================================
// Canonical error class + type guard
// ============================================================================

export { ResilientHttpError, isResilientHttpError } from './errors';
export type { ResilientHttpErrorInit } from './errors';

// ============================================================================
// Public types — config and response shapes
// ============================================================================

export type {
  // Client config
  ResilientHttpOptions,
  RequestConfig,
  ResilientResponse,
  ResilientHttpClient,
  ResponseType,

  // Retry config
  RetryOptions,
  BackoffStrategy,
  JitterStrategy,
  RetryCallback,
  FailureCallback,
  RetryHookContext,

  // Hook system
  HookSet,
  HookContext,
  HookRequestSpec,
  RequestHook,
  ResponseHook,
  RetryObserver,
  FailureObserver,
  IdempotencyKeyOption,

  // Logger
  Logger,

  // Error types
  ErrorClassification,
  ErrorKind,
  StandardizedError,
} from './types';
