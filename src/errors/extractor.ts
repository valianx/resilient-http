import type {
  StandardizedError,
  ErrorClassification,
  HttpClientType,
} from '../types';

/**
 * Network error codes that indicate retryable failures
 */
const RETRYABLE_NETWORK_CODES = new Set([
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
 * HTTP status codes that are typically retryable
 */
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

/**
 * Detect the HTTP client type from error shape
 */
export function detectClientType(error: unknown): HttpClientType {
  if (!error || typeof error !== 'object') {
    return 'generic';
  }

  const e = error as Record<string, unknown>;

  // Axios: has isAxiosError property
  if (e.isAxiosError === true) {
    return 'axios';
  }

  // Got: has name === 'HTTPError' or 'RequestError'
  if (e.name === 'HTTPError' || e.name === 'RequestError') {
    return 'got';
  }

  // Undici: has cause with specific undici error names
  if (e.cause && typeof e.cause === 'object') {
    const cause = e.cause as Record<string, unknown>;
    if (
      typeof cause.code === 'string' &&
      cause.code.startsWith('UND_ERR_')
    ) {
      return 'undici';
    }
  }

  // Fetch API: TypeError with specific messages
  if (
    e.name === 'TypeError' &&
    typeof e.message === 'string' &&
    (e.message.includes('fetch') || e.message.includes('network'))
  ) {
    return 'fetch';
  }

  // Node-fetch: has type property with specific values
  if (
    e.type === 'system' ||
    e.type === 'body-timeout' ||
    e.type === 'request-timeout'
  ) {
    return 'node-fetch';
  }

  return 'generic';
}

/**
 * Classify error based on status code and error properties
 */
export function classifyError(
  statusCode?: number,
  errorCode?: string
): ErrorClassification {
  // Network/timeout errors take precedence
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

  // Classify by status code
  if (statusCode) {
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
 * Determine if an error is retryable based on classification
 */
export function isRetryableError(
  classification: ErrorClassification,
  statusCode?: number
): boolean {
  // These classifications are typically retryable
  if (
    classification === 'network' ||
    classification === 'timeout' ||
    classification === 'server' ||
    classification === 'rate-limit'
  ) {
    return true;
  }

  // Specific status codes that are retryable
  if (statusCode && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return true;
  }

  return false;
}

/**
 * Extract message from various response body formats
 */
function extractMessageFromBody(body: unknown): string | undefined {
  if (!body) return undefined;

  if (typeof body === 'string') {
    return body;
  }

  if (typeof body === 'object') {
    const b = body as Record<string, unknown>;
    // Common error message field names
    if (typeof b.message === 'string') return b.message;
    if (typeof b.error === 'string') return b.error;
    if (typeof b.detail === 'string') return b.detail;
    if (typeof b.msg === 'string') return b.msg;
    if (typeof b.errorMessage === 'string') return b.errorMessage;

    // Nested error object
    if (b.error && typeof b.error === 'object') {
      const nested = b.error as Record<string, unknown>;
      if (typeof nested.message === 'string') return nested.message;
    }
  }

  return undefined;
}

/**
 * Extract standardized error from Axios error
 */
function extractAxiosError(error: Record<string, unknown>): StandardizedError {
  const response = error.response as Record<string, unknown> | undefined;
  const request = error.request as Record<string, unknown> | undefined;
  const config = error.config as Record<string, unknown> | undefined;

  let statusCode: number | undefined;
  let message = (error.message as string) || 'Unknown error';
  let headers: Record<string, string> | undefined;
  let body: unknown;
  let code = error.code as string | undefined;
  let url: string | undefined;
  let method: string | undefined;

  if (config) {
    url = config.url as string;
    method = config.method as string;
  }

  // Case 1: Server responded with error status
  if (response) {
    statusCode = response.status as number;
    headers = response.headers as Record<string, string>;
    body = response.data;

    const bodyMessage = extractMessageFromBody(body);
    if (bodyMessage) {
      message = bodyMessage;
    }
  }
  // Case 2: Request made but no response received
  else if (request) {
    // Handle specific network error codes
    switch (code) {
      case 'ECONNABORTED':
      case 'ETIMEDOUT':
        message = 'Request timeout';
        statusCode = 408;
        break;
      case 'ECONNREFUSED':
        message = 'Connection refused';
        statusCode = 503;
        break;
      case 'ECONNRESET':
        message = 'Connection reset';
        statusCode = 503;
        break;
      case 'ENOTFOUND':
        message = 'DNS lookup failed';
        statusCode = 503;
        break;
      case 'ERR_NETWORK':
        message = 'Network error';
        statusCode = 503;
        break;
      default:
        message = 'No response received';
        statusCode = 503;
    }
  }
  // Case 3: Request cancelled
  else if (error.name === 'AbortError' || code === 'ERR_CANCELED') {
    message = 'Request cancelled';
    statusCode = 499; // Client Closed Request
    code = 'ERR_CANCELED';
  }

  const classification = classifyError(statusCode, code);

  return {
    originalError: error,
    message,
    statusCode,
    method: method?.toUpperCase(),
    url,
    headers,
    body,
    code,
    classification,
    isRetryable: isRetryableError(classification, statusCode),
    clientType: 'axios',
  };
}

/**
 * Extract standardized error from Fetch API error
 */
function extractFetchError(error: Record<string, unknown>): StandardizedError {
  const message = (error.message as string) || 'Fetch error';
  const code = (error.cause as Record<string, unknown>)?.code as string | undefined;

  const classification = classifyError(undefined, code);

  return {
    originalError: error,
    message,
    code,
    classification,
    isRetryable: isRetryableError(classification),
    clientType: 'fetch',
  };
}

/**
 * Extract standardized error from Got error
 */
function extractGotError(error: Record<string, unknown>): StandardizedError {
  const response = error.response as Record<string, unknown> | undefined;
  const options = error.options as Record<string, unknown> | undefined;

  let statusCode: number | undefined;
  let message = (error.message as string) || 'Got error';
  let headers: Record<string, string> | undefined;
  let body: unknown;
  const code = error.code as string | undefined;

  if (response) {
    statusCode = response.statusCode as number;
    headers = response.headers as Record<string, string>;
    body = response.body;

    const bodyMessage = extractMessageFromBody(body);
    if (bodyMessage) {
      message = bodyMessage;
    }
  }

  const classification = classifyError(statusCode, code);

  return {
    originalError: error,
    message,
    statusCode,
    method: options?.method as string,
    url: options?.url?.toString(),
    headers,
    body,
    code,
    classification,
    isRetryable: isRetryableError(classification, statusCode),
    clientType: 'got',
  };
}

/**
 * Extract standardized error from Undici error
 */
function extractUndiciError(error: Record<string, unknown>): StandardizedError {
  const cause = error.cause as Record<string, unknown> | undefined;
  const code = cause?.code as string | undefined;
  const message = (error.message as string) || 'Undici error';

  const classification = classifyError(undefined, code);

  return {
    originalError: error,
    message,
    code,
    classification,
    isRetryable: isRetryableError(classification),
    clientType: 'undici',
  };
}

/**
 * Extract standardized error from node-fetch error
 */
function extractNodeFetchError(error: Record<string, unknown>): StandardizedError {
  const type = error.type as string | undefined;
  const message = (error.message as string) || 'Node-fetch error';
  const code = error.code as string | undefined;

  let statusCode: number | undefined;
  if (type === 'request-timeout' || type === 'body-timeout') {
    statusCode = 408;
  }

  const classification = classifyError(statusCode, code);

  return {
    originalError: error,
    message,
    statusCode,
    code,
    classification,
    isRetryable: isRetryableError(classification, statusCode),
    clientType: 'node-fetch',
  };
}

/**
 * Extract standardized error from generic error
 */
function extractGenericError(error: unknown): StandardizedError {
  if (error instanceof Error) {
    const e = error as Error & { code?: string; statusCode?: number; status?: number };
    const statusCode = e.statusCode || e.status;
    const code = e.code;
    const classification = classifyError(statusCode, code);

    return {
      originalError: error,
      message: e.message,
      statusCode,
      code,
      classification,
      isRetryable: isRetryableError(classification, statusCode),
      clientType: 'generic',
    };
  }

  // Handle non-Error objects
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    const message = extractMessageFromBody(e) || 'Unknown error';
    const statusCode = (e.statusCode || e.status) as number | undefined;
    const code = e.code as string | undefined;
    const classification = classifyError(statusCode, code);

    return {
      originalError: error,
      message,
      statusCode,
      code,
      classification,
      isRetryable: isRetryableError(classification, statusCode),
      clientType: 'generic',
    };
  }

  // Handle primitive errors
  return {
    originalError: error,
    message: String(error),
    classification: 'unknown',
    isRetryable: false,
    clientType: 'generic',
  };
}

/**
 * Extract and standardize error from any HTTP client
 *
 * Automatically detects the HTTP client type and extracts relevant information
 * into a consistent StandardizedError format.
 *
 * @param error - The error from any HTTP client
 * @returns Standardized error with classification and retryability
 *
 * @example
 * ```typescript
 * import { extractError } from 'resilient-http';
 *
 * try {
 *   await axios.get('/api/data');
 * } catch (error) {
 *   const standardized = extractError(error);
 *   console.log(standardized.classification); // 'network', 'server', etc.
 *   console.log(standardized.isRetryable);    // true/false
 * }
 * ```
 */
export function extractError(error: unknown): StandardizedError {
  const clientType = detectClientType(error);
  const e = error as Record<string, unknown>;

  switch (clientType) {
    case 'axios':
      return extractAxiosError(e);
    case 'fetch':
      return extractFetchError(e);
    case 'got':
      return extractGotError(e);
    case 'undici':
      return extractUndiciError(e);
    case 'node-fetch':
      return extractNodeFetchError(e);
    default:
      return extractGenericError(error);
  }
}

/**
 * Create a custom error predicate based on standardized error
 *
 * @param predicate - Function that receives standardized error and returns boolean
 * @returns RetryPredicate compatible function
 *
 * @example
 * ```typescript
 * const shouldRetry = createErrorPredicate((err) => {
 *   // Custom logic: retry on rate limit but not auth errors
 *   return err.classification === 'rate-limit';
 * });
 * ```
 */
export function createErrorPredicate(
  predicate: (error: StandardizedError) => boolean
): (error: unknown) => boolean {
  return (error: unknown) => {
    const standardized = extractError(error);
    return predicate(standardized);
  };
}

/**
 * Default retry predicate - checks if error is retryable
 */
export function defaultRetryPredicate(error: unknown): boolean {
  const standardized = extractError(error);
  return standardized.isRetryable;
}
