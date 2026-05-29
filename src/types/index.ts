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
 * Minimal hook context passed to `shouldRetry` in the retry engine.
 * The full hook context for Phase 5 hooks is `HookContext`.
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

// ============================================================================
// Hook System Types (Phase 5)
// ============================================================================

/**
 * Mutable request spec carried inside a HookContext.
 * `onRequest` hooks may mutate any field to alter the outgoing request.
 */
export interface HookRequestSpec {
  /** Target URL (may be mutated by onRequest hooks). */
  url: string;
  /** HTTP method, upper-cased (may be mutated by onRequest hooks). */
  method: string;
  /**
   * Request headers. Mutating this object affects the outgoing request.
   * Use the standard Headers API for CRLF-safe header manipulation.
   */
  headers: Record<string, string>;
  /**
   * Request body. May be a string, Uint8Array, null, or any serialisable value.
   * Streams are rejected at request-builder level when retry is active.
   */
  body?: unknown;
}

/**
 * Full hook context passed to all Phase 5 hooks.
 *
 * Lifecycle per logical operation (one call to the resilient client):
 * - A new HookContext is created once.
 * - `request` fields are reset per attempt from the original spec.
 * - `attempt` is 1-based and increments on each retry.
 * - `attemptId` changes per attempt; `requestId` is stable for the operation.
 * - `meta` persists across all attempts and travels to the final ResilientHttpError.
 * - `error` and `response` carry the outcome of the PREVIOUS attempt (undefined on attempt 1).
 */
export interface HookContext {
  /**
   * Mutable request spec for this attempt.
   * `onRequest` hooks may mutate url, method, headers, or body.
   * Reset from the original spec at the start of each attempt.
   */
  request: HookRequestSpec;

  /** 1-based attempt number (1 = first try, 2 = first retry, …). */
  attempt: number;

  /** Unique ID for this specific attempt (changes each retry). */
  attemptId: string;

  /**
   * Stable ID for the entire logical operation (all retries share this ID).
   * Useful for correlating logs across attempts.
   */
  requestId: string;

  /**
   * Elapsed milliseconds since the first attempt started.
   * Useful for observability in onRetry/onFailure hooks.
   */
  elapsed: number;

  /**
   * Error from the previous attempt (undefined on the first attempt).
   * Present in onRequest (re-run after a failure), onRetry, and onFailure.
   */
  error?: unknown;

  /**
   * Response from the previous attempt (undefined on the first attempt or
   * when the previous attempt threw without producing a response).
   */
  response?: unknown;

  /**
   * Arbitrary metadata that persists across all attempts.
   * Hooks may read and write freely. This bag is attached to the final
   * ResilientHttpError so callers can propagate retry-lifecycle state.
   *
   * Never logged automatically — callers control if/how meta is used.
   */
  meta: Record<string, unknown>;
}

/**
 * Mutating hook invoked once per attempt (including retries), BEFORE the request is sent.
 * May mutate `ctx.request` (url, method, headers, body).
 * If it throws, the operation aborts with `ResilientHttpError { kind:'setup' }`.
 */
export type RequestHook = (ctx: HookContext) => void | Promise<void>;

/**
 * Mutating hook invoked after a response is received, BEFORE validateStatus.
 * May inspect or lightly mutate context.
 * If it throws, the operation aborts with `ResilientHttpError { kind:'setup' }`.
 */
export type ResponseHook = (ctx: HookContext) => void | Promise<void>;

/**
 * Read-only observer invoked before sleeping between attempts.
 * Receives `(error, attempt, nextDelay)` signature for backward compat.
 * If it throws, the error is silently captured — never propagated.
 */
export type RetryObserver = (
  error: unknown,
  attempt: number,
  nextDelay: number
) => void | Promise<void>;

/**
 * Read-only observer invoked when all attempts are exhausted or the engine gives up.
 * Receives `(error, attempts)` signature.
 * If it throws, the error is silently captured — never propagated.
 */
export type FailureObserver = (
  error: unknown,
  attempts: number
) => void | Promise<void>;

/**
 * Hook configuration object.
 * Each field accepts a single hook or an ordered array of hooks.
 */
export interface HookSet {
  /** Run before each attempt (mutator). */
  onRequest?: RequestHook | RequestHook[];
  /** Run after each response, before validateStatus (mutator). */
  onResponse?: ResponseHook | ResponseHook[];
  /** Run before sleeping between attempts (observer). */
  onRetry?: RetryObserver | RetryObserver[];
  /** Run when the operation is finally abandoned (observer). */
  onFailure?: FailureObserver | FailureObserver[];
}

/**
 * Idempotency-key configuration.
 *
 * - `true`       → generate a random UUID once per logical operation.
 * - `string`     → use this static value for all attempts.
 * - `() => string` → called ONCE; the returned value is frozen for all retries.
 *
 * The key is attached as the `Idempotency-Key` header (or custom `idempotencyHeader`)
 * BEFORE `onRequest` runs, so hooks can read it. If an `onRequest` hook overwrites
 * the header, the hook's value wins for that attempt.
 *
 * PAYMENT SAFETY: the provider function is evaluated exactly once, no matter how
 * many retries occur. This prevents a `() => randomUUID()` pattern from issuing
 * a different key per attempt, which would result in double-charges.
 */
export type IdempotencyKeyOption =
  | true
  | string
  | (() => string);

/**
 * Configuration for the request builder (Phase 5).
 */
export interface RequestBuilderOptions {
  /** Target URL. */
  url: string;
  /** HTTP method (will be upper-cased). */
  method: string;
  /** Initial headers to include in every request. */
  headers?: Record<string, string>;
  /**
   * Request body.
   * - Strings and Uint8Array are replayed directly across retries.
   * - JSON-serialisable objects are serialised once and replayed as a string.
   * - ReadableStream or Request objects require no retry (retry:false) or throw a
   *   setup error.
   * - null/undefined = no body.
   */
  body?: unknown;
  /** Idempotency-key configuration (see IdempotencyKeyOption). */
  idempotencyKey?: IdempotencyKeyOption;
  /**
   * Header name for the idempotency key (default: 'Idempotency-Key').
   */
  idempotencyHeader?: string;
  /** Hook set to execute per attempt. */
  hooks?: HookSet;
  /** Whether retry is active (affects body buffering validation). */
  retryActive?: boolean;
  /** Logger for hook observer errors. */
  logger?: Logger;
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

