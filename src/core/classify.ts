import type { ErrorClassification } from '../types';

/**
 * Network error codes that indicate retryable failures.
 * Migrated here from the removed errors/extractor.ts in Phase 3.
 */
export const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_NETWORK',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * HTTP status codes that are retryable in v2.
 * 409 (Conflict) is intentionally excluded — it is not a transient failure.
 */
export const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

/**
 * Classify an error based on its HTTP status code and error code.
 * Migrated here from the removed errors/extractor.ts in Phase 3.
 */
export function classifyError(
  statusCode?: number,
  errorCode?: string
): ErrorClassification {
  if (errorCode) {
    if (
      errorCode === 'ETIMEDOUT' ||
      errorCode === 'ECONNABORTED' ||
      errorCode === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return 'timeout';
    }
    if (RETRYABLE_NETWORK_CODES.has(errorCode)) {
      return 'network';
    }
    if (errorCode === 'ERR_CANCELED' || errorCode === 'ABORT_ERR') {
      return 'cancelled';
    }
  }

  if (statusCode !== undefined) {
    if (statusCode === 429) return 'rate-limit';
    if (statusCode === 401 || statusCode === 403) return 'authentication';
    if (statusCode === 404) return 'not-found';
    if (statusCode === 400 || statusCode === 422) return 'validation';
    if (statusCode >= 500) return 'server';
    if (statusCode >= 400) return 'client';
  }

  return 'unknown';
}

/**
 * Determine if an error is retryable based on its classification and status code.
 * Migrated here from the removed errors/extractor.ts in Phase 3.
 */
export function isRetryableError(
  classification: ErrorClassification,
  statusCode?: number
): boolean {
  if (
    classification === 'network' ||
    classification === 'timeout' ||
    classification === 'server' ||
    classification === 'rate-limit'
  ) {
    return true;
  }

  if (statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return true;
  }

  return false;
}
