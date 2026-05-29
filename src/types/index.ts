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

/** Detected HTTP client type */
export type HttpClientType =
  | 'axios'
  | 'fetch'
  | 'got'
  | 'node-fetch'
  | 'undici'
  | 'custom'
  | 'generic';

/**
 * Custom error extractor interface
 * Allows users to register extractors for custom HTTP clients
 */
export interface ErrorExtractor {
  /** Unique name for this extractor (used for clientType) */
  name: string;

  /**
   * Check if this extractor can handle the given error
   * Should return true if the error matches this client's error shape
   */
  canHandle(error: unknown): boolean;

  /**
   * Extract standardized error from the client-specific error
   * Only called if canHandle() returned true
   */
  extract(error: unknown): StandardizedError;
}

/**
 * Standardized error representation across all HTTP clients
 */
export interface StandardizedError {
  /** Original error object */
  originalError: unknown;

  /** Human-readable error message */
  message: string;

  /** HTTP status code (if available) */
  statusCode?: number;

  /** HTTP method */
  method?: string;

  /** Request URL */
  url?: string;

  /** Response headers */
  headers?: Record<string, string>;

  /** Response body */
  body?: unknown;

  /** Error code (ECONNREFUSED, ERR_NETWORK, etc.) */
  code?: string;

  /** Error classification */
  classification: ErrorClassification;

  /** Is this error retryable? */
  isRetryable: boolean;

  /** Detected HTTP client type */
  clientType: HttpClientType;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

