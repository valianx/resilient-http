import type { BackoffStrategy } from '../types';

/**
 * Configuration for backoff calculation
 */
export interface BackoffConfig {
  /** Initial delay in milliseconds */
  initialDelay: number;
  /** Maximum delay cap in milliseconds */
  maxDelay: number;
  /** Multiplier for exponential/linear backoff */
  multiplier: number;
  /** Backoff strategy */
  strategy: BackoffStrategy;
}

/**
 * Default backoff configuration
 */
export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
  strategy: 'exponential',
};

/**
 * Calculate exponential backoff delay
 * Formula: min(initialDelay * (multiplier ^ attempt), maxDelay)
 */
export function exponentialBackoff(
  attempt: number,
  config: BackoffConfig
): number {
  const delay = config.initialDelay * Math.pow(config.multiplier, attempt);
  return Math.min(delay, config.maxDelay);
}

/**
 * Calculate linear backoff delay
 * Formula: min(initialDelay + (multiplier * attempt * initialDelay), maxDelay)
 */
export function linearBackoff(attempt: number, config: BackoffConfig): number {
  const delay = config.initialDelay + config.multiplier * attempt * config.initialDelay;
  return Math.min(delay, config.maxDelay);
}

/**
 * Calculate constant backoff delay
 * Always returns the initial delay
 */
export function constantBackoff(
  _attempt: number,
  config: BackoffConfig
): number {
  return config.initialDelay;
}

/**
 * Calculate backoff delay based on strategy
 */
export function calculateBackoff(
  attempt: number,
  config: Partial<BackoffConfig> = {}
): number {
  const fullConfig: BackoffConfig = {
    ...DEFAULT_BACKOFF_CONFIG,
    ...config,
  };

  switch (fullConfig.strategy) {
    case 'exponential':
      return exponentialBackoff(attempt, fullConfig);
    case 'linear':
      return linearBackoff(attempt, fullConfig);
    case 'constant':
      return constantBackoff(attempt, fullConfig);
    default:
      return exponentialBackoff(attempt, fullConfig);
  }
}
