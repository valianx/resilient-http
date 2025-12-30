import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  exponentialBackoff,
  linearBackoff,
  constantBackoff,
  calculateBackoff,
  DEFAULT_BACKOFF_CONFIG,
} from '../src/core/backoff';

describe('Backoff Strategies', () => {
  describe('exponentialBackoff', () => {
    it('should calculate correct delay for attempt 0', () => {
      const delay = exponentialBackoff(0, {
        initialDelay: 1000,
        maxDelay: 30000,
        multiplier: 2,
        strategy: 'exponential',
      });
      assert.strictEqual(delay, 1000);
    });

    it('should calculate correct delay for attempt 1', () => {
      const delay = exponentialBackoff(1, {
        initialDelay: 1000,
        maxDelay: 30000,
        multiplier: 2,
        strategy: 'exponential',
      });
      assert.strictEqual(delay, 2000);
    });

    it('should calculate correct delay for attempt 2', () => {
      const delay = exponentialBackoff(2, {
        initialDelay: 1000,
        maxDelay: 30000,
        multiplier: 2,
        strategy: 'exponential',
      });
      assert.strictEqual(delay, 4000);
    });

    it('should cap delay at maxDelay', () => {
      const delay = exponentialBackoff(10, {
        initialDelay: 1000,
        maxDelay: 30000,
        multiplier: 2,
        strategy: 'exponential',
      });
      assert.strictEqual(delay, 30000);
    });
  });

  describe('linearBackoff', () => {
    it('should calculate correct delay for attempt 0', () => {
      const delay = linearBackoff(0, {
        initialDelay: 1000,
        maxDelay: 30000,
        multiplier: 1,
        strategy: 'linear',
      });
      assert.strictEqual(delay, 1000);
    });

    it('should calculate correct delay for attempt 2', () => {
      const delay = linearBackoff(2, {
        initialDelay: 1000,
        maxDelay: 30000,
        multiplier: 1,
        strategy: 'linear',
      });
      assert.strictEqual(delay, 3000);
    });

    it('should cap delay at maxDelay', () => {
      const delay = linearBackoff(100, {
        initialDelay: 1000,
        maxDelay: 30000,
        multiplier: 1,
        strategy: 'linear',
      });
      assert.strictEqual(delay, 30000);
    });
  });

  describe('constantBackoff', () => {
    it('should always return initialDelay', () => {
      const config = {
        initialDelay: 1000,
        maxDelay: 30000,
        multiplier: 2,
        strategy: 'constant' as const,
      };

      assert.strictEqual(constantBackoff(0, config), 1000);
      assert.strictEqual(constantBackoff(1, config), 1000);
      assert.strictEqual(constantBackoff(10, config), 1000);
    });
  });

  describe('calculateBackoff', () => {
    it('should use default config when not provided', () => {
      const delay = calculateBackoff(0);
      assert.strictEqual(delay, DEFAULT_BACKOFF_CONFIG.initialDelay);
    });

    it('should use exponential strategy by default', () => {
      const delay = calculateBackoff(2);
      assert.strictEqual(delay, 4000);
    });

    it('should handle linear strategy', () => {
      const delay = calculateBackoff(2, { strategy: 'linear', multiplier: 1 });
      assert.strictEqual(delay, 3000);
    });

    it('should handle constant strategy', () => {
      const delay = calculateBackoff(5, { strategy: 'constant' });
      assert.strictEqual(delay, 1000);
    });
  });
});
