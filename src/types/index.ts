/**
 * Core type definitions for resilient-http
 */

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Generic logger interface - compatible with console, winston, pino, bunyan, etc.
 */
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
  debug?(message: string, context?: Record<string, unknown>): void;
}

// ============================================================================
// Backoff & Jitter Types
// ============================================================================

/** Backoff strategy for calculating delay between retries */
export type BackoffStrategy = 'exponential' | 'linear' | 'constant';

/**
 * Jitter strategy for adding randomness to delays
 * - 'full': Random value between 0 and calculated delay (AWS recommended)
 * - 'equal': 50% fixed + 50% random
 * - 'decorrelated': Random value based on previous delay
 * - 'none': No jitter applied
 */
export type JitterStrategy = 'full' | 'equal' | 'decorrelated' | 'none';

// ============================================================================
// Retry Types
// ============================================================================

/** Callback invoked before each retry attempt */
export type RetryCallback = (
  error: unknown,
  attempt: number,
  nextDelay: number
) => void;

/** Callback invoked when all retry attempts are exhausted */
export type FailureCallback = (error: unknown, attempts: number) => void;

/**
 * Minimal hook context passed to `shouldRetry` in Fase 2.
 * Will be extended in Fase 5 with full request/response metadata.
 */
export interface RetryHookContext {
  /** The error thrown by the most recent attempt. */
  error: unknown;
  /** 1-based attempt number that just failed. */
  attempt: number;
  /** HTTP status code of the failed response, if available. */
  statusCode?: number;
  /** HTTP method of the request, upper-cased (e.g. 'GET'). */
  method?: string;
  /** Whether the built-in gate would allow a retry for this error/method/status. */
  gateAllows: boolean;
}

/**
 * Configuration options for retry behavior (v2)
 */
export interface RetryOptions {
  /**
   * Total number of attempts (first attempt + retries).
   * Default: 1 (no retries — callers must opt in).
   */
  maxAttempts?: number;

  /** Backoff strategy (default: 'exponential') */
  backoff?: BackoffStrategy;

  /** Initial delay in milliseconds (default: 1000) */
  initialDelay?: number;

  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelay?: number;

  /** Backoff multiplier for exponential/linear (default: 2) */
  multiplier?: number;

  /** Jitter strategy (default: 'full') */
  jitter?: JitterStrategy;

  /**
   * HTTP status codes that are eligible for retry.
   * Default: [408, 429, 500, 502, 503, 504]
   */
  retryableStatuses?: number[];

  /**
   * HTTP methods that are eligible for retry.
   * Default: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']
   * POST is excluded by default to prevent double-charge on non-idempotent ops.
   */
  retryableMethods?: string[];

  /**
   * When true (default), honours `Retry-After` response headers.
   * The delay is only respected when it does not exceed `maxRetryAfter`.
   */
  respectRetryAfter?: boolean;

  /**
   * Maximum `Retry-After` value (in ms) the engine will honour.
   * If the header specifies a longer wait the engine gives up instead.
   * Default: 60000 (60 s).
   */
  maxRetryAfter?: number;

  /**
   * Custom gate. Receives context about the failed attempt and returns
   * `true` to allow a retry, `false` to stop.
   * If this callback throws, the engine fails-closed: it does NOT retry and
   * propagates the ORIGINAL operation error (not the callback error).
   * Note: `shouldRetry` cannot override `maxAttempts` or `deadline` hard caps.
   */
  shouldRetry?: (ctx: RetryHookContext) => boolean | Promise<boolean>;

  /** Per-attempt timeout in milliseconds (optional). */
  timeout?: number;

  /**
   * Absolute deadline as milliseconds from epoch (Date.now()-compatible).
   * The engine will not start a new attempt if `Date.now() >= deadline`.
   * Also, `effectiveTimeout = min(timeout, deadlineRemaining)` per attempt.
   */
  deadline?: number;

  /** Callback invoked before each retry (after the first failure). */
  onRetry?: RetryCallback;

  /** Callback invoked when all attempts are exhausted or engine gives up. */
  onFailure?: FailureCallback;

  /** Optional logger for debugging. */
  logger?: Logger;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error classification categories
 */
export type ErrorClassification =
  | 'network' // Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
  | 'timeout' // Request timeout
  | 'server' // 5xx errors
  | 'rate-limit' // 429 Too Many Requests
  | 'client' // 4xx errors (non-retryable by default)
  | 'authentication' // 401, 403
  | 'not-found' // 404
  | 'validation' // 400, 422
  | 'cancelled' // Request cancelled
  | 'unknown'; // Unable to classify

/**
 * Error kind discriminant.
 * - 'response': received a non-2xx HTTP response
 * - 'network':  fetch/request itself rejected (no response received)
 * - 'setup':    error constructing the request before any network activity
 */
export type ErrorKind = 'response' | 'network' | 'setup';

/**
 * Standardized error representation (v2).
 *
 * Implemented by ResilientHttpError. The interface is exported so consumers
 * can write typed error-handling utilities without depending on the class.
 */
export interface StandardizedError {
  /** Discriminant describing when / where the error occurred. */
  kind: ErrorKind;

  /** Human-readable error message. */
  message: string;

  /** Error classification (network, timeout, server, rate-limit, …). */
  classification: ErrorClassification;

  /** Whether this error is eligible for retry. */
  isRetryable: boolean;

  /** Total number of attempts made before this error was thrown. */
  attempts: number;

  /** HTTP status code — present only for kind:'response'. */
  statusCode?: number;

  /** HTTP method (upper-cased, e.g. 'GET'). */
  method?: string;

  /** Request URL (raw, not redacted). */
  url?: string;

  /** Response headers — present for kind:'response' when captured. */
  headers?: Record<string, string>;

  /**
   * Response body — present for kind:'response', capped at maxBodySize.
   * Not included in toJSON() by default.
   */
  body?: unknown;

  /** Network error code (e.g. 'ECONNREFUSED', 'ABORT_ERR'). */
  code?: string;

  /** Underlying cause error. Not included in toJSON() by default. */
  cause?: unknown;

  /** Opaque ID for the overall request (e.g. from a correlation header). */
  requestId?: string;

  /** Opaque ID for the specific attempt (e.g. a per-attempt trace ID). */
  attemptId?: string;

  /**
   * Arbitrary metadata for runtime use only.
   * Never included in toJSON() — must not appear in logs or wire responses.
   */
  meta?: Record<string, unknown>;

  /** Return a log/wire-safe JSON representation (no body, cause, or meta). */
  toJSON(): Record<string, unknown>;
}

