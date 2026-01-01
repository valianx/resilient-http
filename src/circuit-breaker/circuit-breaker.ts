import type {
  CircuitBreakerOptions,
  CircuitState,
  CircuitMetrics,
  Logger,
} from '../types';

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message = 'Circuit breaker is open') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CircuitBreakerOpenError);
    }
  }
}

/**
 * Bucket for sliding window counter
 * Stores aggregated success/failure counts for a time slice
 */
interface Bucket {
  success: number;
  failure: number;
  timestamp: number;
}

/**
 * Resolved circuit breaker configuration with validated defaults
 */
interface ResolvedCircuitConfig {
  failureThreshold: number;
  minimumRequests: number;
  rollingWindow: number;
  resetTimeout: number;
  successThreshold: number;
  halfOpenMaxRequests: number;
  bucketCount: number;
  bucketDuration: number;
  onOpen?: () => void;
  onClose?: () => void;
  onHalfOpen?: () => void;
  logger?: Logger;
}

/**
 * Default circuit breaker configuration
 */
const DEFAULT_CIRCUIT_CONFIG = {
  failureThreshold: 50,
  minimumRequests: 10,
  rollingWindow: 60000,
  resetTimeout: 30000,
  successThreshold: 3,
  halfOpenMaxRequests: 1,
  bucketCount: 10,
};

/**
 * Validate and clamp a number to a range
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Validate circuit breaker options and return resolved config
 */
function validateAndResolveConfig(options: CircuitBreakerOptions): ResolvedCircuitConfig {
  const failureThreshold = clamp(
    options.failureThreshold ?? DEFAULT_CIRCUIT_CONFIG.failureThreshold,
    1,
    100
  );

  const minimumRequests = Math.max(
    1,
    options.minimumRequests ?? DEFAULT_CIRCUIT_CONFIG.minimumRequests
  );

  const rollingWindow = Math.max(
    1000,
    options.rollingWindow ?? DEFAULT_CIRCUIT_CONFIG.rollingWindow
  );

  const resetTimeout = Math.max(
    100,
    options.resetTimeout ?? DEFAULT_CIRCUIT_CONFIG.resetTimeout
  );

  const successThreshold = Math.max(
    1,
    options.successThreshold ?? DEFAULT_CIRCUIT_CONFIG.successThreshold
  );

  const halfOpenMaxRequests = Math.max(
    1,
    options.halfOpenMaxRequests ?? DEFAULT_CIRCUIT_CONFIG.halfOpenMaxRequests
  );

  const bucketCount = clamp(
    options.bucketCount ?? DEFAULT_CIRCUIT_CONFIG.bucketCount,
    2,
    60
  );

  const bucketDuration = Math.floor(rollingWindow / bucketCount);

  return {
    failureThreshold,
    minimumRequests,
    rollingWindow,
    resetTimeout,
    successThreshold,
    halfOpenMaxRequests,
    bucketCount,
    bucketDuration,
    onOpen: options.onOpen,
    onClose: options.onClose,
    onHalfOpen: options.onHalfOpen,
    logger: options.logger,
  };
}

/**
 * Circuit Breaker implementation with Sliding Window Counter
 *
 * Prevents cascading failures by monitoring request success/failure rates
 * and temporarily stopping requests when failure threshold is exceeded.
 *
 * Uses a memory-efficient sliding window bucket approach instead of storing
 * individual request records. This provides O(1) memory complexity regardless
 * of request throughput.
 *
 * States:
 * - CLOSED: Normal operation, requests are allowed
 * - OPEN: Failure threshold exceeded, requests are blocked
 * - HALF-OPEN: Testing if service has recovered (limited probe requests)
 *
 * @example
 * ```typescript
 * import { CircuitBreaker } from 'resilient-http';
 *
 * const breaker = new CircuitBreaker({
 *   failureThreshold: 50,      // Open at 50% failure rate
 *   minimumRequests: 10,       // Need 10 requests before opening
 *   resetTimeout: 30000,       // Try again after 30s
 *   halfOpenMaxRequests: 1,    // Allow 1 probe request in half-open
 *   onOpen: () => console.log('Circuit opened!'),
 *   onClose: () => console.log('Circuit closed!'),
 * });
 *
 * // Execute with circuit breaker
 * try {
 *   const result = await breaker.execute(() => fetch('/api/data'));
 * } catch (error) {
 *   if (error instanceof CircuitBreakerOpenError) {
 *     console.log('Service unavailable');
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private buckets: Bucket[];
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private halfOpenSuccesses = 0;
  private halfOpenActiveRequests = 0;
  private config: ResolvedCircuitConfig;
  private transitionInProgress = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.config = validateAndResolveConfig(options);
    // Initialize buckets array
    this.buckets = new Array(this.config.bucketCount).fill(null).map(() => ({
      success: 0,
      failure: 0,
      timestamp: 0,
    }));
  }

  /**
   * Get current circuit state
   * Note: This method may trigger state transitions when conditions are met
   */
  getState(): CircuitState {
    this.checkStateTransition();
    return this.state;
  }

  /**
   * Check if state transition is needed and execute it
   * Uses a flag to prevent concurrent transition issues
   */
  private checkStateTransition(): void {
    // Prevent concurrent transitions
    if (this.transitionInProgress) return;

    // Check if we should transition from open to half-open
    if (this.state === 'open' && this.shouldAttemptReset()) {
      this.transitionInProgress = true;
      try {
        this.transitionTo('half-open');
      } finally {
        this.transitionInProgress = false;
      }
    }
  }

  /**
   * Get circuit metrics for monitoring
   */
  getMetrics(): CircuitMetrics {
    const now = Date.now();
    const cutoff = now - this.config.rollingWindow;

    let successfulRequests = 0;
    let failedRequests = 0;

    // Sum counts from valid buckets
    for (const bucket of this.buckets) {
      if (bucket.timestamp > cutoff) {
        successfulRequests += bucket.success;
        failedRequests += bucket.failure;
      }
    }

    const totalRequests = successfulRequests + failedRequests;
    const failureRate = totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0;

    return {
      state: this.getState(),
      totalRequests,
      failedRequests,
      successfulRequests,
      failureRate,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
    };
  }

  /**
   * Execute a function through the circuit breaker
   *
   * @param fn - Async function to execute
   * @returns Promise resolving to function result
   * @throws CircuitBreakerOpenError if circuit is open or half-open limit reached
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    // If open, reject immediately
    if (currentState === 'open') {
      this.config.logger?.warn('Circuit breaker is open, rejecting request');
      throw new CircuitBreakerOpenError();
    }

    // If half-open, check if we've reached the probe limit
    if (currentState === 'half-open') {
      if (this.halfOpenActiveRequests >= this.config.halfOpenMaxRequests) {
        this.config.logger?.warn('Circuit breaker half-open limit reached, rejecting request');
        throw new CircuitBreakerOpenError('Circuit breaker is half-open, probe limit reached');
      }
      this.halfOpenActiveRequests++;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    } finally {
      // Decrement active requests if we were in half-open
      if (currentState === 'half-open') {
        this.halfOpenActiveRequests = Math.max(0, this.halfOpenActiveRequests - 1);
      }
    }
  }

  /**
   * Get the current bucket based on timestamp
   */
  private getCurrentBucket(): Bucket {
    const now = Date.now();
    const bucketIndex = Math.floor(now / this.config.bucketDuration) % this.config.bucketCount;
    const bucket = this.buckets[bucketIndex];

    // Check if bucket is stale and needs reset
    const bucketAge = now - bucket.timestamp;
    if (bucketAge >= this.config.bucketDuration) {
      // Reset stale bucket
      bucket.success = 0;
      bucket.failure = 0;
      bucket.timestamp = now;
    }

    return bucket;
  }

  /**
   * Manually record a success
   * Useful when integrating with existing code
   */
  recordSuccess(): void {
    this.lastSuccessTime = Date.now();
    const bucket = this.getCurrentBucket();
    bucket.success++;

    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;

      if (this.halfOpenSuccesses >= this.config.successThreshold) {
        this.transitionTo('closed');
      }
    }

    this.evaluateState();
  }

  /**
   * Manually record a failure
   * Useful when integrating with existing code
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now();
    const bucket = this.getCurrentBucket();
    bucket.failure++;

    if (this.state === 'half-open') {
      // Single failure in half-open returns to open
      this.transitionTo('open');
    }

    this.evaluateState();
  }

  /**
   * Manually force circuit to specific state
   * Use with caution - mainly for testing or manual intervention
   */
  forceState(state: CircuitState): void {
    this.transitionTo(state);
    if (state === 'closed') {
      this.resetBuckets();
      this.halfOpenSuccesses = 0;
      this.halfOpenActiveRequests = 0;
    } else if (state === 'open') {
      // Set lastFailureTime to prevent immediate transition to half-open
      this.lastFailureTime = Date.now();
    } else if (state === 'half-open') {
      this.halfOpenSuccesses = 0;
      this.halfOpenActiveRequests = 0;
    }
  }

  /**
   * Reset all buckets to initial state
   */
  private resetBuckets(): void {
    for (const bucket of this.buckets) {
      bucket.success = 0;
      bucket.failure = 0;
      bucket.timestamp = 0;
    }
  }

  /**
   * Reset the circuit breaker to initial state
   */
  reset(): void {
    this.state = 'closed';
    this.resetBuckets();
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.halfOpenSuccesses = 0;
    this.halfOpenActiveRequests = 0;
  }

  /**
   * Check if circuit should attempt reset (transition to half-open)
   */
  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return true;
    return Date.now() - this.lastFailureTime >= this.config.resetTimeout;
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    const previousState = this.state;
    this.state = newState;

    this.config.logger?.info?.('Circuit breaker state change', {
      from: previousState,
      to: newState,
    });

    switch (newState) {
      case 'open':
        this.halfOpenSuccesses = 0;
        this.halfOpenActiveRequests = 0;
        this.config.onOpen?.();
        break;
      case 'closed':
        this.halfOpenSuccesses = 0;
        this.halfOpenActiveRequests = 0;
        this.resetBuckets();
        this.config.onClose?.();
        break;
      case 'half-open':
        this.halfOpenSuccesses = 0;
        this.halfOpenActiveRequests = 0;
        this.config.onHalfOpen?.();
        break;
    }
  }

  /**
   * Evaluate current state based on metrics
   */
  private evaluateState(): void {
    if (this.state !== 'closed') return;

    const metrics = this.getMetrics();

    // Need minimum requests before evaluating
    if (metrics.totalRequests < this.config.minimumRequests) {
      return;
    }

    // Check if failure rate exceeds threshold
    if (metrics.failureRate >= this.config.failureThreshold) {
      this.transitionTo('open');
    }
  }
}

/**
 * Create a function wrapper with circuit breaker protection
 *
 * @param fn - Function to protect
 * @param options - Circuit breaker options
 * @returns Wrapped function with circuit breaker
 *
 * @example
 * ```typescript
 * const fetchWithBreaker = withCircuitBreaker(
 *   async (url: string) => fetch(url),
 *   { failureThreshold: 50 }
 * );
 *
 * const response = await fetchWithBreaker('/api/data');
 * ```
 */
export function withCircuitBreaker<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreakerOptions = {}
): (...args: TArgs) => Promise<TResult> {
  const breaker = new CircuitBreaker(options);

  const wrapped = (...args: TArgs) => breaker.execute(() => fn(...args));

  // Expose breaker for inspection
  (wrapped as unknown as { breaker: CircuitBreaker }).breaker = breaker;

  return wrapped;
}
