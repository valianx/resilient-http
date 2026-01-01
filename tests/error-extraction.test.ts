import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  extractError,
  detectClientType,
  classifyError,
  isRetryableError,
  registerExtractor,
  unregisterExtractor,
  clearExtractors,
  getRegisteredExtractors,
} from '../src/errors/extractor';

describe('Error Extraction', () => {
  describe('detectClientType', () => {
    it('should detect axios errors', () => {
      const error = { isAxiosError: true };
      assert.strictEqual(detectClientType(error), 'axios');
    });

    it('should detect got errors', () => {
      const error = { name: 'HTTPError' };
      assert.strictEqual(detectClientType(error), 'got');
    });

    it('should detect fetch errors', () => {
      const error = { name: 'TypeError', message: 'Failed to fetch' };
      assert.strictEqual(detectClientType(error), 'fetch');
    });

    it('should return generic for unknown errors', () => {
      const error = { message: 'Unknown error' };
      assert.strictEqual(detectClientType(error), 'generic');
    });
  });

  describe('classifyError', () => {
    it('should classify timeout errors', () => {
      assert.strictEqual(classifyError(undefined, 'ETIMEDOUT'), 'timeout');
      assert.strictEqual(classifyError(undefined, 'ECONNABORTED'), 'timeout');
    });

    it('should classify network errors', () => {
      assert.strictEqual(classifyError(undefined, 'ECONNREFUSED'), 'network');
      assert.strictEqual(classifyError(undefined, 'ECONNRESET'), 'network');
    });

    it('should classify server errors by status', () => {
      assert.strictEqual(classifyError(500), 'server');
      assert.strictEqual(classifyError(503), 'server');
    });

    it('should classify rate limit errors', () => {
      assert.strictEqual(classifyError(429), 'rate-limit');
    });

    it('should classify auth errors', () => {
      assert.strictEqual(classifyError(401), 'authentication');
      assert.strictEqual(classifyError(403), 'authentication');
    });

    it('should classify not-found errors', () => {
      assert.strictEqual(classifyError(404), 'not-found');
    });
  });

  describe('isRetryableError', () => {
    it('should consider network errors retryable', () => {
      assert.strictEqual(isRetryableError('network'), true);
    });

    it('should consider timeout errors retryable', () => {
      assert.strictEqual(isRetryableError('timeout'), true);
    });

    it('should consider server errors retryable', () => {
      assert.strictEqual(isRetryableError('server'), true);
    });

    it('should not consider client errors retryable', () => {
      assert.strictEqual(isRetryableError('client'), false);
    });

    it('should not consider auth errors retryable', () => {
      assert.strictEqual(isRetryableError('authentication'), false);
    });
  });

  describe('extractError', () => {
    it('should extract axios response error', () => {
      const error = {
        isAxiosError: true,
        message: 'Request failed',
        response: {
          status: 500,
          data: { message: 'Internal Server Error' },
        },
        config: {
          url: '/api/test',
          method: 'get',
        },
      };

      const result = extractError(error);

      assert.strictEqual(result.statusCode, 500);
      assert.strictEqual(result.message, 'Internal Server Error');
      assert.strictEqual(result.classification, 'server');
      assert.strictEqual(result.isRetryable, true);
      assert.strictEqual(result.clientType, 'axios');
    });

    it('should extract axios network error', () => {
      const error = {
        isAxiosError: true,
        message: 'Network Error',
        request: {},
        code: 'ECONNREFUSED',
        config: {
          url: '/api/test',
          method: 'get',
        },
      };

      const result = extractError(error);

      assert.strictEqual(result.statusCode, 503);
      assert.strictEqual(result.classification, 'network');
      assert.strictEqual(result.isRetryable, true);
    });

    it('should extract generic error', () => {
      const error = new Error('Something went wrong');

      const result = extractError(error);

      assert.strictEqual(result.message, 'Something went wrong');
      assert.strictEqual(result.clientType, 'generic');
    });

    it('should handle primitive errors', () => {
      const result = extractError('String error');
      assert.strictEqual(result.message, 'String error');
    });
  });

  describe('Custom Extractors', () => {
    // Clear extractors before each test to ensure isolation
    beforeEach(() => {
      clearExtractors();
    });

    it('should register a custom extractor', () => {
      registerExtractor({
        name: 'test-client',
        canHandle: (error) => {
          return typeof error === 'object' && error !== null && 'isTestError' in error;
        },
        extract: (error) => {
          const e = error as { isTestError: boolean; message: string; code: number };
          return {
            originalError: error,
            message: e.message,
            statusCode: e.code,
            classification: 'server',
            isRetryable: true,
            clientType: 'custom',
          };
        },
      });

      assert.deepStrictEqual(getRegisteredExtractors(), ['test-client']);
    });

    it('should use custom extractor when it can handle the error', () => {
      registerExtractor({
        name: 'my-client',
        canHandle: (error) => {
          return typeof error === 'object' && error !== null && 'isMyClientError' in error;
        },
        extract: (error) => {
          const e = error as { isMyClientError: boolean; statusCode: number; msg: string };
          const classification = classifyError(e.statusCode);
          return {
            originalError: error,
            message: e.msg,
            statusCode: e.statusCode,
            classification,
            isRetryable: isRetryableError(classification, e.statusCode),
            clientType: 'custom',
          };
        },
      });

      const customError = {
        isMyClientError: true,
        statusCode: 503,
        msg: 'Service temporarily unavailable',
      };

      const result = extractError(customError);

      assert.strictEqual(result.message, 'Service temporarily unavailable');
      assert.strictEqual(result.statusCode, 503);
      assert.strictEqual(result.classification, 'server');
      assert.strictEqual(result.isRetryable, true);
      assert.strictEqual(result.clientType, 'custom');
    });

    it('should fall back to built-in extractors when custom cannot handle', () => {
      registerExtractor({
        name: 'specific-client',
        canHandle: (error) => {
          return typeof error === 'object' && error !== null && 'isSpecificError' in error;
        },
        extract: () => ({
          originalError: null,
          message: 'Should not be called',
          classification: 'unknown',
          isRetryable: false,
          clientType: 'custom',
        }),
      });

      // This is an axios error, not a specific-client error
      const axiosError = {
        isAxiosError: true,
        message: 'Axios error',
        response: { status: 500 },
        config: {},
      };

      const result = extractError(axiosError);

      assert.strictEqual(result.clientType, 'axios');
      assert.strictEqual(result.statusCode, 500);
    });

    it('should check custom extractors in registration order', () => {
      const order: string[] = [];

      registerExtractor({
        name: 'first',
        canHandle: (error) => {
          order.push('first');
          return typeof error === 'object' && error !== null && 'useFirst' in error;
        },
        extract: (error) => ({
          originalError: error,
          message: 'First extractor',
          classification: 'unknown',
          isRetryable: false,
          clientType: 'custom',
        }),
      });

      registerExtractor({
        name: 'second',
        canHandle: (error) => {
          order.push('second');
          return typeof error === 'object' && error !== null && 'useSecond' in error;
        },
        extract: (error) => ({
          originalError: error,
          message: 'Second extractor',
          classification: 'unknown',
          isRetryable: false,
          clientType: 'custom',
        }),
      });

      extractError({ useSecond: true });

      assert.deepStrictEqual(order, ['first', 'second']);
    });

    it('should throw when registering duplicate extractor name', () => {
      registerExtractor({
        name: 'duplicate',
        canHandle: () => false,
        extract: () => ({
          originalError: null,
          message: '',
          classification: 'unknown',
          isRetryable: false,
          clientType: 'custom',
        }),
      });

      assert.throws(() => {
        registerExtractor({
          name: 'duplicate',
          canHandle: () => false,
          extract: () => ({
            originalError: null,
            message: '',
            classification: 'unknown',
            isRetryable: false,
            clientType: 'custom',
          }),
        });
      }, /already registered/);
    });

    it('should unregister an extractor', () => {
      registerExtractor({
        name: 'to-remove',
        canHandle: () => false,
        extract: () => ({
          originalError: null,
          message: '',
          classification: 'unknown',
          isRetryable: false,
          clientType: 'custom',
        }),
      });

      assert.deepStrictEqual(getRegisteredExtractors(), ['to-remove']);

      const removed = unregisterExtractor('to-remove');
      assert.strictEqual(removed, true);
      assert.deepStrictEqual(getRegisteredExtractors(), []);
    });

    it('should return false when unregistering non-existent extractor', () => {
      const removed = unregisterExtractor('non-existent');
      assert.strictEqual(removed, false);
    });

    it('should clear all extractors', () => {
      registerExtractor({
        name: 'one',
        canHandle: () => false,
        extract: () => ({
          originalError: null,
          message: '',
          classification: 'unknown',
          isRetryable: false,
          clientType: 'custom',
        }),
      });

      registerExtractor({
        name: 'two',
        canHandle: () => false,
        extract: () => ({
          originalError: null,
          message: '',
          classification: 'unknown',
          isRetryable: false,
          clientType: 'custom',
        }),
      });

      assert.strictEqual(getRegisteredExtractors().length, 2);

      clearExtractors();

      assert.strictEqual(getRegisteredExtractors().length, 0);
    });

    it('should allow custom extractor to override built-in detection', () => {
      // Register a custom extractor that intercepts axios errors
      registerExtractor({
        name: 'axios-override',
        canHandle: (error) => {
          return typeof error === 'object' && error !== null && 'isAxiosError' in error;
        },
        extract: (error) => ({
          originalError: error,
          message: 'Custom axios handling',
          classification: 'network',
          isRetryable: false, // Override: not retryable
          clientType: 'custom',
        }),
      });

      const axiosError = {
        isAxiosError: true,
        message: 'Original message',
        response: { status: 500 },
        config: {},
      };

      const result = extractError(axiosError);

      assert.strictEqual(result.message, 'Custom axios handling');
      assert.strictEqual(result.isRetryable, false);
      assert.strictEqual(result.clientType, 'custom');
    });
  });
});
