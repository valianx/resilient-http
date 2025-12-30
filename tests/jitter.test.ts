import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  fullJitter,
  equalJitter,
  noJitter,
  applyJitter,
} from '../src/core/jitter';

describe('Jitter Strategies', () => {
  describe('fullJitter', () => {
    it('should return value between 0 and baseDelay', () => {
      for (let i = 0; i < 100; i++) {
        const result = fullJitter(1000);
        assert.ok(result >= 0 && result <= 1000, `Expected 0-1000, got ${result}`);
      }
    });
  });

  describe('equalJitter', () => {
    it('should return value between half and full baseDelay', () => {
      for (let i = 0; i < 100; i++) {
        const result = equalJitter(1000);
        assert.ok(result >= 500 && result <= 1000, `Expected 500-1000, got ${result}`);
      }
    });
  });

  describe('noJitter', () => {
    it('should return the exact baseDelay', () => {
      assert.strictEqual(noJitter(1000), 1000);
      assert.strictEqual(noJitter(5000), 5000);
    });
  });

  describe('applyJitter', () => {
    it('should apply full jitter by default', () => {
      const result = applyJitter(1000);
      assert.ok(result >= 0 && result <= 1000);
    });

    it('should apply none jitter when specified', () => {
      assert.strictEqual(applyJitter(1000, 'none'), 1000);
    });

    it('should apply equal jitter when specified', () => {
      const result = applyJitter(1000, 'equal');
      assert.ok(result >= 500 && result <= 1000);
    });
  });
});
