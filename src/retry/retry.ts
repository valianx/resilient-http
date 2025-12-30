import type {
  RetryOptions,
  RetryPredicate,
  RetryCallback,
  FailureCallback,
  Logger,
  BackoffStrategy,
  JitterStrategy,
} from '../types';
import { sleep, sleepWithAbort } from '../utils';
import { calculateBackoff } from '../core/backoff';
import { applyJitter } from '../core/jitter';
import { extractError, defaultRetryPredicate } from '../errors';

/**
 * Internal retry configuration with all defaults applied
 */
interface ResolvedRetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffStrategy: BackoffStrategy;
  backoffMultiplier: number;
  jitter: JitterStrategy;
  shouldRetry: RetryPredicate;
  timeout?: number;
  onRetry?: RetryCallback;
  onFailure?: FailureCallback;
  logger?: Logger;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: ResolvedRetryConfig = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffStrategy: 'exponential',
  backoffMultiplier: 2,
  jitter: 'full',
  shouldRetry: defaultRetryPredicate,
};

/**
 * Resolve partial options to full configuration
 */
function resolveConfig(options: RetryOptions = {}): ResolvedRetryConfig {
  return {
    ...DEFAULT_RETRY_CONFIG,
    ...options,
    shouldRetry: options.shouldRetry ?? defaultRetryPredicate,
  };
}

/**
 * Calculate delay for a given attempt
 */
function calculateDelay(
  attempt: number,
  previousDelay: number,
  config: ResolvedRetryConfig
): number {
  // Calculate base backoff
  const baseDelay = calculateBackoff(attempt, {
    initialDelay: config.initialDelay,
    maxDelay: config.maxDelay,
    multiplier: config.backoffMultiplier,
    strategy: config.backoffStrategy,
  });

  // Apply jitter
  return applyJitter(baseDelay, config.jitter, {
    previousDelay,
    initialDelay: config.initialDelay,
    maxDelay: config.maxDelay,
  });
}

/**
 * Execute function with timeout
 */
async function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeout?: number,
  signal?: AbortSignal
): Promise<T> {
  if (!timeout) {
    return fn();
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Link to parent signal if provided
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const result = await fn();
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Retry a function with configurable backoff and jitter
 *
 * Provides resilient execution of async functions with automatic retries,
 * exponential backoff, and jitter to prevent thundering herd problems.
 *
 * @param fn - Async function to execute
 * @param options - Retry configuration options
 * @returns Promise resolving to function result
 * @throws Last error if all retries exhausted
 *
 * @example
 * ```typescript
 * import { retry } from 'resilient-http';
 *
 * // Basic usage
 * const result = await retry(() => fetch('/api/data'));
 *
 * // With configuration
 * const result = await retry(
 *   () => axios.get('/api/data'),
 *   {
 *     maxAttempts: 5,
 *     initialDelay: 500,
 *     backoffStrategy: 'exponential',
 *     jitter: 'full',
 *     onRetry: (error, attempt, delay) => {
 *       console.log(`Retry ${attempt} in ${delay}ms`);
 *     }
 *   }
 * );
 *
 * // With abort signal
 * const controller = new AbortController();
 * const result = await retry(
 *   () => fetch('/api/data', { signal: controller.signal }),
 *   { maxAttempts: 3 }
 * );
 * // Cancel: controller.abort();
 * ```
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const config = resolveConfig(options);
  let lastError: unknown;
  let previousDelay = config.initialDelay;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      // Execute with optional timeout
      const result = await executeWithTimeout(fn, config.timeout);
      return result;
    } catch (error) {
      lastError = error;
      const standardizedError = extractError(error);

      // Check if we should retry
      const shouldRetry = config.shouldRetry(error, attempt);
      const hasMoreAttempts = attempt < config.maxAttempts - 1;

      if (!shouldRetry || !hasMoreAttempts) {
        // Log final failure
        config.logger?.error('Retry exhausted', {
          attempt: attempt + 1,
          maxAttempts: config.maxAttempts,
          error: standardizedError.message,
          classification: standardizedError.classification,
        });

        // Invoke failure callback
        config.onFailure?.(error, attempt + 1);
        break;
      }

      // Calculate delay for next attempt
      const delay = calculateDelay(attempt, previousDelay, config);
      previousDelay = delay;

      // Log retry attempt
      config.logger?.warn('Retrying request', {
        attempt: attempt + 1,
        maxAttempts: config.maxAttempts,
        nextDelay: delay,
        error: standardizedError.message,
        classification: standardizedError.classification,
      });

      // Invoke retry callback
      config.onRetry?.(error, attempt + 1, delay);

      // Wait before next attempt
      await sleep(delay);
    }
  }

  // Throw the last error
  throw lastError;
}

/**
 * Retry with abort signal support
 *
 * Similar to retry() but allows cancellation via AbortSignal.
 * Useful for implementing request cancellation or cleanup.
 *
 * @param fn - Async function to execute
 * @param signal - AbortSignal for cancellation
 * @param options - Retry configuration options
 * @returns Promise resolving to function result
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 *
 * // Start retryable operation
 * const promise = retryWithSignal(
 *   () => fetch('/api/data'),
 *   controller.signal,
 *   { maxAttempts: 5 }
 * );
 *
 * // Cancel after 5 seconds
 * setTimeout(() => controller.abort(), 5000);
 *
 * try {
 *   const result = await promise;
 * } catch (error) {
 *   if (error.name === 'AbortError') {
 *     console.log('Request cancelled');
 *   }
 * }
 * ```
 */
export async function retryWithSignal<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  options: RetryOptions = {}
): Promise<T> {
  const config = resolveConfig(options);
  let lastError: unknown;
  let previousDelay = config.initialDelay;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    // Check if aborted before attempt
    if (signal.aborted) {
      throw new DOMException('Retry aborted', 'AbortError');
    }

    try {
      const result = await executeWithTimeout(fn, config.timeout, signal);
      return result;
    } catch (error) {
      // Check if abort was the cause
      if (signal.aborted) {
        throw new DOMException('Retry aborted', 'AbortError');
      }

      lastError = error;
      const standardizedError = extractError(error);

      const shouldRetry = config.shouldRetry(error, attempt);
      const hasMoreAttempts = attempt < config.maxAttempts - 1;

      if (!shouldRetry || !hasMoreAttempts) {
        config.logger?.error('Retry exhausted', {
          attempt: attempt + 1,
          maxAttempts: config.maxAttempts,
          error: standardizedError.message,
        });

        config.onFailure?.(error, attempt + 1);
        break;
      }

      const delay = calculateDelay(attempt, previousDelay, config);
      previousDelay = delay;

      config.logger?.warn('Retrying request', {
        attempt: attempt + 1,
        maxAttempts: config.maxAttempts,
        nextDelay: delay,
        error: standardizedError.message,
      });

      config.onRetry?.(error, attempt + 1, delay);

      // Wait with abort support
      try {
        await sleepWithAbort(delay, signal);
      } catch {
        throw new DOMException('Retry aborted', 'AbortError');
      }
    }
  }

  throw lastError;
}

/**
 * Create a retryable version of a function
 *
 * Returns a new function that automatically retries on failure.
 * Useful for wrapping existing functions with retry behavior.
 *
 * @param fn - Function to make retryable
 * @param options - Retry configuration options
 * @returns Wrapped function with retry behavior
 *
 * @example
 * ```typescript
 * const fetchWithRetry = withRetry(
 *   async (url: string) => {
 *     const response = await fetch(url);
 *     return response.json();
 *   },
 *   { maxAttempts: 3, initialDelay: 500 }
 * );
 *
 * // Use like normal function - retries automatically
 * const data = await fetchWithRetry('/api/data');
 * ```
 */
export function withRetry<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions = {}
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => retry(() => fn(...args), options);
}
