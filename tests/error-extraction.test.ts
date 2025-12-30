import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  extractError,
  detectClientType,
  classifyError,
  isRetryableError,
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
});
