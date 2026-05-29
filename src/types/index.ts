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

/** Predicate to determine if an error should trigger a retry */
export type RetryPredicate = (error: unknown, attempt: number) => boolean;

/** Callback invoked before each retry attempt */
export type RetryCallback = (
  error: unknown,
  attempt: number,
  nextDelay: number
) => void;

/** Callback invoked when all retry attempts are exhausted */
export type FailureCallback = (error: unknown, attempts: number) => void;

/**
 * Configuration options for retry behavior
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;

  /** Initial delay in milliseconds (default: 1000) */
  initialDelay?: number;

  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelay?: number;

  /** Backoff strategy (default: 'exponential') */
  backoffStrategy?: BackoffStrategy;

  /** Backoff multiplier for exponential/linear (default: 2) */
  backoffMultiplier?: number;

  /** Jitter strategy (default: 'full') */
  jitter?: JitterStrategy;

  /** Custom predicate to determine if error is retryable */
  shouldRetry?: RetryPredicate;

  /** Timeout for each attempt in milliseconds (optional) */
  timeout?: number;

  /** Callback before each retry */
  onRetry?: RetryCallback;

  /** Callback on final failure */
  onFailure?: FailureCallback;

  /** Optional logger for debugging */
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

