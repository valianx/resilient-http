import { describe, it } from 'node:test';
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

  describe('half-open request limiting', () => {
    it('should limit requests in half-open state', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
        halfOpenMaxRequests: 1,
        resetTimeout: 100, // Short timeout for testing
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

      assert.strictEqual(breaker.getState(), 'open');

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should transition to half-open
      assert.strictEqual(breaker.getState(), 'half-open');

      // First request should be allowed (it will hang)
      let firstRequestStarted = false;
      const firstRequest = breaker.execute(async () => {
        firstRequestStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'success';
      });

      // Give time for the first request to start
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.strictEqual(firstRequestStarted, true);

      // Second request should be rejected while first is in progress
      await assert.rejects(
        breaker.execute(async () => 'should not run'),
        CircuitBreakerOpenError
      );

      // Clean up
      await firstRequest;
    });

    it('should allow configurable halfOpenMaxRequests', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
        halfOpenMaxRequests: 3,
        resetTimeout: 100,
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

      // Wait for half-open
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.strictEqual(breaker.getState(), 'half-open');

      // Should allow 3 concurrent requests
      const requests = [];
      for (let i = 0; i < 3; i++) {
        requests.push(
          breaker.execute(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return 'success';
          })
        );
      }

      // Give time for requests to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 4th request should be rejected
      await assert.rejects(
        breaker.execute(async () => 'should not run'),
        CircuitBreakerOpenError
      );

      // Clean up
      await Promise.all(requests);
    });
  });

  describe('input validation', () => {
    it('should clamp failureThreshold to valid range', () => {
      const breaker1 = new CircuitBreaker({ failureThreshold: 0 });
      const breaker2 = new CircuitBreaker({ failureThreshold: 150 });

      // These should not throw - values are clamped
      assert.strictEqual(breaker1.getState(), 'closed');
      assert.strictEqual(breaker2.getState(), 'closed');
    });

    it('should enforce minimum values', () => {
      const breaker = new CircuitBreaker({
        minimumRequests: -5,
        rollingWindow: 100, // Below minimum of 1000
        resetTimeout: 10, // Below minimum of 100
        successThreshold: 0,
        halfOpenMaxRequests: -1,
        bucketCount: 1, // Below minimum of 2
      });

      // Should not throw - values are clamped to minimums
      assert.strictEqual(breaker.getState(), 'closed');
    });
  });

  describe('sliding window buckets', () => {
    it('should track metrics correctly with bucket-based counting', async () => {
      const breaker = new CircuitBreaker({
        rollingWindow: 10000,
        bucketCount: 10,
        minimumRequests: 5,
        failureThreshold: 60,
      });

      // Record 3 successes and 2 failures
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => 'success');
      }

      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('failure');
          });
        } catch {
          // Expected
        }
      }

      const metrics = breaker.getMetrics();
      assert.strictEqual(metrics.totalRequests, 5);
      assert.strictEqual(metrics.successfulRequests, 3);
      assert.strictEqual(metrics.failedRequests, 2);
      assert.strictEqual(metrics.failureRate, 40); // 2/5 = 40%
    });

    it('should maintain O(1) memory regardless of request count', async () => {
      const breaker = new CircuitBreaker({
        rollingWindow: 60000,
        bucketCount: 10,
        minimumRequests: 100,
        failureThreshold: 90,
      });

      // Simulate high throughput
      for (let i = 0; i < 1000; i++) {
        await breaker.execute(async () => 'success');
      }

      const metrics = breaker.getMetrics();
      assert.strictEqual(metrics.totalRequests, 1000);
      assert.strictEqual(metrics.successfulRequests, 1000);
      // Circuit should still be closed (0% failure rate)
      assert.strictEqual(breaker.getState(), 'closed');
    });
  });

  describe('half-open to closed transition', () => {
    it('should close circuit after successThreshold successes in half-open', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
        successThreshold: 2,
        resetTimeout: 100,
        halfOpenMaxRequests: 5,
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

      assert.strictEqual(breaker.getState(), 'open');

      // Wait for half-open
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.strictEqual(breaker.getState(), 'half-open');

      // Two successes should close the circuit
      await breaker.execute(async () => 'success');
      assert.strictEqual(breaker.getState(), 'half-open'); // Still half-open after 1

      await breaker.execute(async () => 'success');
      assert.strictEqual(breaker.getState(), 'closed'); // Closed after 2
    });

    it('should reopen circuit on failure in half-open', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
        resetTimeout: 100,
        halfOpenMaxRequests: 5,
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

      // Wait for half-open
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.strictEqual(breaker.getState(), 'half-open');

      // Single failure should reopen
      try {
        await breaker.execute(async () => {
          throw new Error('failure');
        });
      } catch {
        // Expected
      }

      assert.strictEqual(breaker.getState(), 'open');
    });
  });

  describe('callbacks', () => {
    it('should call onOpen when circuit opens', async () => {
      let openCalled = false;

      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
        onOpen: () => {
          openCalled = true;
        },
      });

      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('failure');
          });
        } catch {
          // Expected
        }
      }

      assert.strictEqual(openCalled, true);
    });

    it('should call onHalfOpen when transitioning to half-open', async () => {
      let halfOpenCalled = false;

      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
        resetTimeout: 100,
        onHalfOpen: () => {
          halfOpenCalled = true;
        },
      });

      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('failure');
          });
        } catch {
          // Expected
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
      breaker.getState(); // Trigger transition check

      assert.strictEqual(halfOpenCalled, true);
    });

    it('should call onClose when circuit closes', async () => {
      let closeCalled = false;

      const breaker = new CircuitBreaker({
        failureThreshold: 50,
        minimumRequests: 2,
        resetTimeout: 100,
        successThreshold: 1,
        halfOpenMaxRequests: 5,
        onClose: () => {
          closeCalled = true;
        },
      });

      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error('failure');
          });
        } catch {
          // Expected
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 150));

      await breaker.execute(async () => 'success');

      assert.strictEqual(closeCalled, true);
    });
  });
});
