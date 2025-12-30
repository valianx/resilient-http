import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from '../src/circuit-breaker/circuit-breaker';

describe('CircuitBreaker', () => {
  describe('initial state', () => {
    it('should start in closed state', () => {
      const breaker = new CircuitBreaker();
      assert.strictEqual(breaker.getState(), 'closed');
    });

    it('should have zero metrics initially', () => {
      const breaker = new CircuitBreaker();
      const metrics = breaker.getMetrics();
      assert.strictEqual(metrics.totalRequests, 0);
      assert.strictEqual(metrics.failedRequests, 0);
      assert.strictEqual(metrics.successfulRequests, 0);
      assert.strictEqual(metrics.failureRate, 0);
    });
  });

  describe('execute', () => {
    it('should execute function when closed', async () => {
      const breaker = new CircuitBreaker();
      const result = await breaker.execute(async () => 'success');
      assert.strictEqual(result, 'success');
    });

    it('should track successful requests', async () => {
      const breaker = new CircuitBreaker();
      await breaker.execute(async () => 'success');
      const metrics = breaker.getMetrics();
      assert.strictEqual(metrics.successfulRequests, 1);
    });

    it('should track failed requests', async () => {
      const breaker = new CircuitBreaker();
      try {
        await breaker.execute(async () => {
          throw new Error('failure');
        });
      } catch {
        // Expected
      }
      const metrics = breaker.getMetrics();
      assert.strictEqual(metrics.failedRequests, 1);
    });
  });

  describe('state transitions', () => {
    it('should open circuit when failure threshold exceeded', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 4,
      });

      // Record 4 failures (100% failure rate)
      for (let i = 0; i < 4; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('failure');
          });
        } catch {
          // Expected
        }
      }

      assert.strictEqual(breaker.getState(), 'open');
    });

    it('should throw CircuitBreakerOpenError when open', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
      });

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('failure');
          });
        } catch {
          // Expected
        }
      }

      await assert.rejects(
        breaker.execute(async () => 'success'),
        CircuitBreakerOpenError
      );
    });
  });

  describe('reset', () => {
    it('should reset to initial state', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
      });

      // Record some failures
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('failure');
          });
        } catch {
          // Expected
        }
      }

      breaker.reset();

      assert.strictEqual(breaker.getState(), 'closed');
      const metrics = breaker.getMetrics();
      assert.strictEqual(metrics.totalRequests, 0);
    });
  });

  describe('forceState', () => {
    it('should force circuit to open state', () => {
      const breaker = new CircuitBreaker();
      breaker.forceState('open');
      assert.strictEqual(breaker.getState(), 'open');
    });

    it('should force circuit to closed state and reset records', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
      });

      // Record failures
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('failure');
          });
        } catch {
          // Expected
        }
      }

      breaker.forceState('closed');

      assert.strictEqual(breaker.getState(), 'closed');
      const metrics = breaker.getMetrics();
      assert.strictEqual(metrics.totalRequests, 0);
    });
  });
});
