/**
 * Tests for error classification primitives (classifyError, isRetryableError)
 * and the internal message extraction utility (extractMessageFromBody).
 *
 * Covers AC-1 through AC-5 of the Phase 3 refactor spec.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyError, isRetryableError } from '../src/core/classify';
import { extractMessageFromBody } from '../src/core/message';

// ============================================================================
// classifyError
// ============================================================================

describe('classifyError', () => {
  it('classifies ETIMEDOUT as timeout', () => {
    assert.strictEqual(classifyError(undefined, 'ETIMEDOUT'), 'timeout');
  });

  it('classifies ECONNABORTED as timeout', () => {
    assert.strictEqual(classifyError(undefined, 'ECONNABORTED'), 'timeout');
  });

  it('classifies UND_ERR_CONNECT_TIMEOUT as timeout', () => {
    assert.strictEqual(classifyError(undefined, 'UND_ERR_CONNECT_TIMEOUT'), 'timeout');
  });

  it('classifies ECONNREFUSED as network', () => {
    assert.strictEqual(classifyError(undefined, 'ECONNREFUSED'), 'network');
  });

  it('classifies ECONNRESET as network', () => {
    assert.strictEqual(classifyError(undefined, 'ECONNRESET'), 'network');
  });

  it('classifies ERR_CANCELED as cancelled', () => {
    assert.strictEqual(classifyError(undefined, 'ERR_CANCELED'), 'cancelled');
  });

  it('classifies 429 as rate-limit', () => {
    assert.strictEqual(classifyError(429), 'rate-limit');
  });

  it('classifies 401 as authentication', () => {
    assert.strictEqual(classifyError(401), 'authentication');
  });

  it('classifies 403 as authentication', () => {
    assert.strictEqual(classifyError(403), 'authentication');
  });

  it('classifies 404 as not-found — AC-3', () => {
    assert.strictEqual(classifyError(404), 'not-found');
  });

  it('classifies 400 as validation', () => {
    assert.strictEqual(classifyError(400), 'validation');
  });

  it('classifies 422 as validation', () => {
    assert.strictEqual(classifyError(422), 'validation');
  });

  it('classifies 500 as server', () => {
    assert.strictEqual(classifyError(500), 'server');
  });

  it('classifies 503 as server — AC-3', () => {
    assert.strictEqual(classifyError(503), 'server');
  });

  it('classifies 504 as server', () => {
    assert.strictEqual(classifyError(504), 'server');
  });

  it('classifies unknown code+status as unknown', () => {
    assert.strictEqual(classifyError(undefined, undefined), 'unknown');
  });

  it('error-code classification takes precedence over status code', () => {
    // ETIMEDOUT should win over a 500 status
    assert.strictEqual(classifyError(500, 'ETIMEDOUT'), 'timeout');
  });
});

// ============================================================================
// isRetryableError
// ============================================================================

describe('isRetryableError', () => {
  it('network classification is retryable', () => {
    assert.strictEqual(isRetryableError('network'), true);
  });

  it('timeout classification is retryable', () => {
    assert.strictEqual(isRetryableError('timeout'), true);
  });

  it('server classification is retryable — AC-3', () => {
    assert.strictEqual(isRetryableError('server'), true);
  });

  it('rate-limit classification is retryable', () => {
    assert.strictEqual(isRetryableError('rate-limit'), true);
  });

  it('client classification is NOT retryable', () => {
    assert.strictEqual(isRetryableError('client'), false);
  });

  it('authentication classification is NOT retryable', () => {
    assert.strictEqual(isRetryableError('authentication'), false);
  });

  it('not-found classification is NOT retryable — AC-3', () => {
    assert.strictEqual(isRetryableError('not-found'), false);
  });

  it('validation classification is NOT retryable', () => {
    assert.strictEqual(isRetryableError('validation'), false);
  });

  it('cancelled classification is NOT retryable', () => {
    assert.strictEqual(isRetryableError('cancelled'), false);
  });

  it('unknown classification is NOT retryable', () => {
    assert.strictEqual(isRetryableError('unknown'), false);
  });

  it('retryable status code 503 overrides non-retryable classification', () => {
    // Even if classified as 'client', explicit status in RETRYABLE_STATUS_CODES wins
    assert.strictEqual(isRetryableError('client', 503), true);
  });

  it('retryable status code 429 with rate-limit classification stays retryable', () => {
    assert.strictEqual(isRetryableError('rate-limit', 429), true);
  });

  it('status 409 is NOT retryable (not in RETRYABLE_STATUS_CODES)', () => {
    // 409 is intentionally excluded per v2 spec
    assert.strictEqual(isRetryableError('client', 409), false);
  });
});

// ============================================================================
// extractMessageFromBody — AC-1, AC-2
// ============================================================================

describe('extractMessageFromBody', () => {
  // --- RFC 7807 problem+json ---

  it('returns detail from problem+json body — AC-2', () => {
    const body = { type: 'https://example.com/errors/not-found', title: 'Not Found', detail: 'The resource was not found.', status: 404 };
    const result = extractMessageFromBody(body, 'application/problem+json');
    assert.strictEqual(result, 'The resource was not found.');
  });

  it('returns title when detail is absent in problem+json — AC-2', () => {
    const body = { type: 'https://example.com/errors/conflict', title: 'Conflict', status: 409 };
    const result = extractMessageFromBody(body, 'application/problem+json');
    assert.strictEqual(result, 'Conflict');
  });

  it('returns detail over title even when both present in problem+json', () => {
    const body = { title: 'Bad Request', detail: 'Field x is required', status: 400 };
    const result = extractMessageFromBody(body, 'application/problem+json');
    assert.strictEqual(result, 'Field x is required');
  });

  it('parses a JSON string body with problem+json content-type', () => {
    const body = JSON.stringify({ title: 'Service Unavailable', detail: 'Try again later', status: 503 });
    const result = extractMessageFromBody(body, 'application/problem+json');
    assert.strictEqual(result, 'Try again later');
  });

  // --- Generic JSON object bodies ---

  it('returns message field from plain JSON object', () => {
    const body = { message: 'Internal Server Error' };
    const result = extractMessageFromBody(body);
    assert.strictEqual(result, 'Internal Server Error');
  });

  it('returns error field when message is absent', () => {
    const body = { error: 'Something went wrong' };
    const result = extractMessageFromBody(body);
    assert.strictEqual(result, 'Something went wrong');
  });

  it('returns msg field as fallback', () => {
    const body = { msg: 'Request failed' };
    const result = extractMessageFromBody(body);
    assert.strictEqual(result, 'Request failed');
  });

  it('returns detail field from generic JSON (no problem+json ct)', () => {
    const body = { detail: 'Validation failed for field email' };
    const result = extractMessageFromBody(body);
    assert.strictEqual(result, 'Validation failed for field email');
  });

  it('returns message from nested error object', () => {
    const body = { error: { message: 'Nested error message' } };
    const result = extractMessageFromBody(body);
    assert.strictEqual(result, 'Nested error message');
  });

  // --- String bodies ---

  it('returns plain string body as-is', () => {
    const result = extractMessageFromBody('Service temporarily unavailable');
    assert.strictEqual(result, 'Service temporarily unavailable');
  });

  it('parses JSON string when content-type is application/json', () => {
    const body = JSON.stringify({ message: 'Parsed from JSON string' });
    const result = extractMessageFromBody(body, 'application/json');
    assert.strictEqual(result, 'Parsed from JSON string');
  });

  it('returns raw string when content-type is not JSON and string is not parseable', () => {
    const result = extractMessageFromBody('plain text error', 'text/plain');
    assert.strictEqual(result, 'plain text error');
  });

  // --- Null / empty / edge cases ---

  it('returns undefined for null body', () => {
    assert.strictEqual(extractMessageFromBody(null), undefined);
  });

  it('returns undefined for undefined body', () => {
    assert.strictEqual(extractMessageFromBody(undefined), undefined);
  });

  it('returns undefined for empty string', () => {
    assert.strictEqual(extractMessageFromBody(''), undefined);
  });

  it('returns undefined for array body', () => {
    // Arrays are not message-extractable
    assert.strictEqual(extractMessageFromBody([{ message: 'should not extract' }]), undefined);
  });

  it('returns undefined for object with no recognizable fields', () => {
    const result = extractMessageFromBody({ foo: 'bar', baz: 42 });
    assert.strictEqual(result, undefined);
  });

  // --- Guardrail: malformed body must degrade gracefully, never throw ---

  it('does not throw when JSON string is malformed with application/json content-type -- degrades to raw string', () => {
    // The try/catch in extractFromJsonString must absorb the SyntaxError from JSON.parse
    const malformed = '{"message": "truncated';
    assert.doesNotThrow(() => {
      const result = extractMessageFromBody(malformed, 'application/json');
      // Falls back to raw string because JSON.parse threw
      assert.strictEqual(result, malformed);
    });
  });

  it('does not throw when body is an HTML string with application/problem+json content-type -- degrades to raw string', () => {
    // Proxy/gateway error pages often return HTML with a JSON content-type header
    const html = '<html><body><h1>503 Service Unavailable</h1></body></html>';
    assert.doesNotThrow(() => {
      const result = extractMessageFromBody(html, 'application/problem+json');
      // JSON.parse fails; falls back to raw string
      assert.strictEqual(result, html);
    });
  });
});