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
 * Internal tracking for rolling window
 */
interface RequestRecord {
  timestamp: number;
  success: boolean;
}

/**
 * Resolved circuit breaker configuration
 */
interface ResolvedCircuitConfig {
  failureThreshold: number;
  minimumRequests: number;
  rollingWindow: number;
  resetTimeout: number;
  successThreshold: number;
  onOpen?: () => void;
  onClose?: () => void;
  onHalfOpen?: () => void;
  logger?: Logger;
}

/**
 * Default circuit breaker configuration
 */
const DEFAULT_CIRCUIT_CONFIG: ResolvedCircuitConfig = {
  failureThreshold: 50,
  minimumRequests: 10,
  rollingWindow: 60000,
  resetTimeout: 30000,
  successThreshold: 3,
};

/**
 * Circuit Breaker implementation
 *
 * Prevents cascading failures by monitoring request success/failure rates
 * and temporarily stopping requests when failure threshold is exceeded.
 *
 * States:
 * - CLOSED: Normal operation, requests are allowed
 * - OPEN: Failure threshold exceeded, requests are blocked
 * - HALF-OPEN: Testing if service has recovered
 *
 * @example
 * ```typescript
 * import { CircuitBreaker } from 'resilient-http';
 *
 * const breaker = new CircuitBreaker({
 *   failureThreshold: 50,      // Open at 50% failure rate
 *   minimumRequests: 10,       // Need 10 requests before opening
 *   resetTimeout: 30000,       // Try again after 30s
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
  private records: RequestRecord[] = [];
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private halfOpenSuccesses = 0;
  private config: ResolvedCircuitConfig;

  constructor(options: CircuitBreakerOptions = {}) {
    this.config = {
      ...DEFAULT_CIRCUIT_CONFIG,
      ...options,
    };
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    // Check if we should transition from open to half-open
    if (this.state === 'open' && this.shouldAttemptReset()) {
      this.transitionTo('half-open');
    }
    return this.state;
  }

  /**
   * Get circuit metrics for monitoring
   */
  getMetrics(): CircuitMetrics {
    this.pruneOldRecords();

    const totalRequests = this.records.length;
    const failedRequests = this.records.filter((r) => !r.success).length;
    const successfulRequests = totalRequests - failedRequests;
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
   * @throws CircuitBreakerOpenError if circuit is open
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    // If open, reject immediately
    if (currentState === 'open') {
      this.config.logger?.warn('Circuit breaker is open, rejecting request');
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Manually record a success
   * Useful when integrating with existing code
   */
  recordSuccess(): void {
    this.lastSuccessTime = Date.now();
    this.records.push({
      timestamp: Date.now(),
      success: true,
    });

    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;

      if (this.halfOpenSuccesses >= this.config.successThreshold) {
        this.transitionTo('closed');
      }
    }

    this.pruneOldRecords();
    this.evaluateState();
  }

  /**
   * Manually record a failure
   * Useful when integrating with existing code
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now();
    this.records.push({
      timestamp: Date.now(),
      success: false,
    });

    if (this.state === 'half-open') {
      // Single failure in half-open returns to open
      this.transitionTo('open');
    }

    this.pruneOldRecords();
    this.evaluateState();
  }

  /**
   * Manually force circuit to specific state
   * Use with caution - mainly for testing or manual intervention
   */
  forceState(state: CircuitState): void {
    this.transitionTo(state);
    if (state === 'closed') {
      this.records = [];
      this.halfOpenSuccesses = 0;
    }
  }

  /**
   * Reset the circuit breaker to initial state
   */
  reset(): void {
    this.state = 'closed';
    this.records = [];
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.halfOpenSuccesses = 0;
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
        this.config.onOpen?.();
        break;
      case 'closed':
        this.halfOpenSuccesses = 0;
        this.config.onClose?.();
        break;
      case 'half-open':
        this.halfOpenSuccesses = 0;
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

  /**
   * Remove records outside the rolling window
   */
  private pruneOldRecords(): void {
    const cutoff = Date.now() - this.config.rollingWindow;
    this.records = this.records.filter((r) => r.timestamp > cutoff);
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
  (wrapped as { breaker: CircuitBreaker }).breaker = breaker;

  return wrapped;
}
