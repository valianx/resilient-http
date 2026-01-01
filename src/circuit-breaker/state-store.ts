import type { StateStore, CircuitBreakerState, BucketData } from '../types';

/**
 * In-memory state store implementation
 *
 * Default implementation for single-instance deployments.
 * State is lost on process restart.
 *
 * @example
 * ```typescript
 * import { InMemoryStateStore, CircuitBreaker } from 'resilient-http';
 *
 * const store = new InMemoryStateStore();
 * const breaker = new CircuitBreaker({
 *   stateStore: store,
 *   circuitId: 'my-service',
 * });
 * ```
 */
export class InMemoryStateStore implements StateStore {
  private states = new Map<string, CircuitBreakerState>();

  async getState(circuitId: string): Promise<CircuitBreakerState | null> {
    return this.states.get(circuitId) ?? null;
  }

  async setState(circuitId: string, state: CircuitBreakerState): Promise<void> {
    // Deep clone to prevent external mutations
    this.states.set(circuitId, {
      state: state.state,
      buckets: state.buckets.map((b) => ({ ...b })),
      lastFailureTime: state.lastFailureTime,
      lastSuccessTime: state.lastSuccessTime,
      halfOpenSuccesses: state.halfOpenSuccesses,
      halfOpenActiveRequests: state.halfOpenActiveRequests,
    });
  }

  async deleteState(circuitId: string): Promise<void> {
    this.states.delete(circuitId);
  }

  /**
   * Get all circuit IDs in the store
   * Useful for debugging and monitoring
   */
  getCircuitIds(): string[] {
    return Array.from(this.states.keys());
  }

  /**
   * Clear all states
   * Useful for testing
   */
  clear(): void {
    this.states.clear();
  }
}

/**
 * Create initial bucket data for a circuit breaker
 */
export function createInitialBuckets(bucketCount: number): BucketData[] {
  return new Array(bucketCount).fill(null).map(() => ({
    success: 0,
    failure: 0,
    timestamp: 0,
  }));
}

/**
 * Create initial circuit breaker state
 */
export function createInitialState(bucketCount: number): CircuitBreakerState {
  return {
    state: 'closed',
    buckets: createInitialBuckets(bucketCount),
    lastFailureTime: null,
    lastSuccessTime: null,
    halfOpenSuccesses: 0,
    halfOpenActiveRequests: 0,
  };
}
