import type { JitterStrategy } from '../types';
import { randomBetween, randomFloatBetween } from '../utils';

/**
 * Configuration for jitter calculation
 */
export interface JitterConfig {
  /** Base delay to apply jitter to */
  baseDelay: number;
  /** Jitter strategy */
  strategy: JitterStrategy;
  /** Previous delay for decorrelated jitter */
  previousDelay?: number;
  /** Initial delay for decorrelated jitter bounds */
  initialDelay?: number;
  /** Maximum delay cap */
  maxDelay?: number;
}

/**
 * Default jitter configuration
 */
export const DEFAULT_JITTER_CONFIG: Partial<JitterConfig> = {
  strategy: 'full',
  maxDelay: 30000,
};

/**
 * Full jitter (AWS recommended)
 * Returns random value between 0 and baseDelay
 * Provides maximum randomness to prevent thundering herd
 *
 * @see https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export function fullJitter(baseDelay: number): number {
  return randomBetween(0, Math.floor(baseDelay));
}

/**
 * Equal jitter
 * Returns baseDelay/2 + random(0, baseDelay/2)
 * Provides a balance between predictability and randomness
 */
export function equalJitter(baseDelay: number): number {
  const half = Math.floor(baseDelay / 2);
  return half + randomBetween(0, half);
}

/**
 * Decorrelated jitter
 * Returns random value between initialDelay and 3 * previousDelay
 * Each delay is derived from the previous one, creating smoother distribution
 *
 * Formula: min(maxDelay, random(initialDelay, previousDelay * 3))
 *
 * @see https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export function decorrelatedJitter(
  previousDelay: number,
  initialDelay: number,
  maxDelay: number
): number {
  const min = initialDelay;
  const max = previousDelay * 3;
  const jitteredDelay = randomFloatBetween(min, max);
  return Math.min(Math.floor(jitteredDelay), maxDelay);
}

/**
 * No jitter - returns the base delay unchanged
 */
export function noJitter(baseDelay: number): number {
  return baseDelay;
}

/**
 * Apply jitter to a base delay based on strategy
 *
 * @param baseDelay - The calculated backoff delay
 * @param strategy - Jitter strategy to apply
 * @param options - Additional options for decorrelated jitter
 * @returns Delay with jitter applied
 *
 * @example
 * ```typescript
 * // Full jitter (default)
 * const delay = applyJitter(1000, 'full');
 *
 * // Equal jitter
 * const delay = applyJitter(1000, 'equal');
 *
 * // Decorrelated jitter (needs previous delay)
 * const delay = applyJitter(1000, 'decorrelated', {
 *   previousDelay: 500,
 *   initialDelay: 100,
 *   maxDelay: 30000
 * });
 *
 * // No jitter
 * const delay = applyJitter(1000, 'none');
 * ```
 */
export function applyJitter(
  baseDelay: number,
  strategy: JitterStrategy = 'full',
  options: {
    previousDelay?: number;
    initialDelay?: number;
    maxDelay?: number;
  } = {}
): number {
  const { previousDelay = baseDelay, initialDelay = 1000, maxDelay = 30000 } = options;

  switch (strategy) {
    case 'full':
      return fullJitter(baseDelay);

    case 'equal':
      return equalJitter(baseDelay);

    case 'decorrelated':
      return decorrelatedJitter(previousDelay, initialDelay, maxDelay);

    case 'none':
      return noJitter(baseDelay);

    default:
      // Fallback to full jitter for unknown strategies
      return fullJitter(baseDelay);
  }
}

/**
 * Calculate delay with both backoff and jitter applied
 * Convenience function that combines backoff calculation with jitter
 */
export function calculateDelayWithJitter(config: JitterConfig): number {
  const { baseDelay, strategy, previousDelay, initialDelay, maxDelay } = config;

  return applyJitter(baseDelay, strategy, {
    previousDelay,
    initialDelay,
    maxDelay,
  });
}
