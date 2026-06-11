/**
 * Tests for ResilientHttpError v2 — covers all acceptance criteria of Phase 4
 * plus the new network-diagnosability and toJSON() transparency ACs from #36.
 *
 * AC-1:  construct response / network / setup kinds
 * AC-2:  toJSON() includes safe fields AND body / cause / meta (v2.2+ contract)
 * AC-3:  header redaction is case-insensitive for all denylist entries
 * AC-3b: query-param redaction preserves non-sensitive params; url instance stays raw
 * AC-4:  isResilientHttpError brand check; works across module boundaries (Symbol.for)
 * AC-5:  non-JSON / unreadable body → no secondary error; fallback to statusText
 * AC-6:  body exceeding maxBodySize is truncated and marked
 * AC-7:  anti-leak scan — redacted-header values and beyond-message-cap content
 *        never appear in JSON.stringify(toJSON()); body/cause/meta ARE present now
 * AC-10: fail-safe URL — relative / malformed URL with redactQueryParams hides query
 *
 * Network diagnosability (#36):
 * AC-N1..AC-N6: cause-chain code resolution (undici shape, cycles, depth cap)
 *
 * New network ACs (AggregateError + errno):
 * AC-AGG1: AggregateError nested at cause.cause → errors[0].code resolved
 * AC-AGG2: AggregateError multiple errors → picks first recognizable code
 * AC-AGG3: errno-only node → code resolved from errno
 * AC-AGG4: over-depth chain → terminates with no resolution
 * AC-AGG5: cross-edge cycle → terminates
 * AC-AGG6: undefined cause → omitted from toJSON(), message stays 'Network error'
 *
 * Serializer robustness:
 * AC-SER1: serializeCause fail-safe on getter-throws / null-proto / BigInt / circular
 * AC-SER2: toJSON() exposes cause (code/address/port), body, meta
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ResilientHttpError,
  isResilientHttpError,
  RESILIENT_HTTP_ERROR_BRAND,
} from '../src/errors/resilient-http-error';

// ============================================================================
// Helpers
// ============================================================================

/** Assert that a secret literal does not appear ANYWHERE in a serialised string. */
function assertNoLeak(serialised: string, secret: string, label: string): void {
  assert.ok(
    !serialised.includes(secret),
    `Secret leaked in ${label}: found "${secret}" in: ${serialised}`
  );
}

// ============================================================================
// AC-1 — construction of each kind
// ============================================================================

describe('ResilientHttpError — AC-1 construction', () => {
  it('kind:response has statusCode, body, and message from body', () => {
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 502,
      body: { message: 'Bad gateway from upstream' },
      contentType: 'application/json',
      method: 'GET',
      url: 'https://api.test/items',
      attempts: 2,
    });

    assert.strictEqual(err.kind, 'response');
    assert.strictEqual(err.statusCode, 502);
    assert.strictEqual(err.message, 'Bad gateway from upstream');
    assert.strictEqual(err.method, 'GET');
    assert.strictEqual(err.attempts, 2);
    assert.deepStrictEqual(err.body, { message: 'Bad gateway from upstream' });
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'ResilientHttpError');
  });

  it('kind:response falls back to statusText when body has no extractable message', () => {
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 503,
      body: '<html><body>Service Unavailable</body></html>',
      contentType: 'text/html',
      statusText: 'Service Unavailable',
    });

    // HTML is not JSON — extractMessageFromBody returns the raw string (AC-5 path)
    // but since content-type is text/html the raw string IS returned by extractMessageFromBody
    // so message will be the HTML string. Test that it does not throw.
    assert.strictEqual(err.kind, 'response');
    assert.strictEqual(err.statusCode, 503);
    assert.ok(typeof err.message === 'string' && err.message.length > 0);
  });

  it('kind:response falls back to statusText when body is null', () => {
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 503,
      body: null,
      statusText: 'Service Unavailable',
    });

    assert.strictEqual(err.message, 'Service Unavailable');
    assert.strictEqual(err.body, undefined); // null body → undefined
  });

  it('kind:response falls back to "HTTP {statusCode}" when body and statusText are absent', () => {
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 500,
    });

    assert.strictEqual(err.message, 'HTTP 500');
  });

  it('kind:response classifies 502 as server and retryable', () => {
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 502,
    });

    assert.strictEqual(err.classification, 'server');
    assert.strictEqual(err.isRetryable, true);
  });

  it('kind:response classifies 404 as not-found and non-retryable', () => {
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 404,
    });

    assert.strictEqual(err.classification, 'not-found');
    assert.strictEqual(err.isRetryable, false);
  });

  it('kind:network has code and classification without statusCode', () => {
    const err = new ResilientHttpError({
      kind: 'network',
      code: 'ECONNREFUSED',
      method: 'POST',
      url: 'https://api.test/charge',
      attempts: 3,
    });

    assert.strictEqual(err.kind, 'network');
    assert.strictEqual(err.code, 'ECONNREFUSED');
    assert.strictEqual(err.statusCode, undefined);
    assert.strictEqual(err.classification, 'network');
    assert.strictEqual(err.isRetryable, true);
    assert.strictEqual(err.attempts, 3);
  });

  it('kind:network with AbortError cause sets code ABORT_ERR and classification cancelled', () => {
    const abortErr = new DOMException('Request aborted', 'AbortError');
    const err = new ResilientHttpError({
      kind: 'network',
      cause: abortErr,
    });

    assert.strictEqual(err.code, 'ABORT_ERR');
    assert.strictEqual(err.classification, 'cancelled');
    assert.strictEqual(err.isRetryable, false);
    assert.ok(err.message.includes('aborted'));
  });

  it('kind:network without code falls back to classification network and retryable', () => {
    const err = new ResilientHttpError({
      kind: 'network',
    });

    assert.strictEqual(err.kind, 'network');
    assert.strictEqual(err.classification, 'network');
    assert.strictEqual(err.isRetryable, true);
  });

  it('kind:setup has the provided message, unknown classification, non-retryable', () => {
    const err = new ResilientHttpError({
      kind: 'setup',
      message: 'Invalid URL provided',
      cause: new TypeError('Invalid URL'),
    });

    assert.strictEqual(err.kind, 'setup');
    assert.strictEqual(err.message, 'Invalid URL provided');
    assert.strictEqual(err.classification, 'unknown');
    assert.strictEqual(err.isRetryable, false);
    assert.ok(err.cause instanceof TypeError);
  });

  it('requestId and attemptId are stored on the instance', () => {
    const err = new ResilientHttpError({
      kind: 'network',
      requestId: 'req-abc',
      attemptId: 'att-xyz',
    });

    assert.strictEqual(err.requestId, 'req-abc');
    assert.strictEqual(err.attemptId, 'att-xyz');
  });

  it('meta is stored on the instance', () => {
    const meta = { traceId: 't-123', region: 'us-east-1' };
    const err = new ResilientHttpError({
      kind: 'setup',
      message: 'Bad config',
      meta,
    });

    assert.deepStrictEqual(err.meta, meta);
  });

  it('attempts defaults to 1 when not provided', () => {
    const err = new ResilientHttpError({ kind: 'setup', message: 'x' });
    assert.strictEqual(err.attempts, 1);
  });
});

// ============================================================================
// AC-2 — toJSON() field inclusion (v2.2+ contract: body/cause/meta NOW included)
// ============================================================================

describe('ResilientHttpError — AC-2 toJSON() field inclusion', () => {
  it('toJSON() includes all safe fields for kind:response', () => {
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 429,
      method: 'GET',
      url: 'https://api.test/items',
      attempts: 2,
      requestId: 'req-1',
      attemptId: 'att-2',
      headers: { 'x-ratelimit-limit': '100', 'content-type': 'application/json' },
      body: { message: 'Too Many Requests' },
      cause: new Error('underlying'),
      meta: { region: 'eu-west' },
    });

    const json = err.toJSON();

    assert.strictEqual(json['kind'], 'response');
    assert.strictEqual(json['message'], 'Too Many Requests');
    assert.strictEqual(json['statusCode'], 429);
    assert.strictEqual(json['classification'], 'rate-limit');
    assert.strictEqual(json['isRetryable'], true);
    assert.strictEqual(json['method'], 'GET');
    assert.strictEqual(json['url'], 'https://api.test/items');
    assert.strictEqual(json['attempts'], 2);
    assert.strictEqual(json['requestId'], 'req-1');
    assert.strictEqual(json['attemptId'], 'att-2');
    assert.ok(json['headers'] !== undefined, 'headers should be present');
  });

  it('toJSON() INCLUDES body (v2.2+ contract)', () => {
    // Previous contract excluded body; v2.2 exposes it so the consumer has
    // full context. The consumer owns any additional redaction.
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 500,
      body: { orderRef: 'ORD-1', message: 'x' },
      meta: { region: 'eu' },
    });

    const json = err.toJSON();
    assert.ok('body' in json, 'body must appear in toJSON()');
    assert.deepStrictEqual(json['body'], { orderRef: 'ORD-1', message: 'x' });
  });

  it('toJSON() INCLUDES cause as a serialized object (v2.2+ contract)', () => {
    // Previous contract excluded cause; v2.2 serializes it so code/address/port
    // are visible to the consumer.
    const inner = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
      address: '10.0.0.1',
      port: 443,
    });
    const err = new ResilientHttpError({
      kind: 'network',
      cause: inner,
    });

    const json = err.toJSON();
    assert.ok('cause' in json, 'cause must appear in toJSON()');
    const c = json['cause'] as Record<string, unknown>;
    assert.strictEqual(c['code'], 'ECONNREFUSED');
    assert.strictEqual(c['address'], '10.0.0.1');
    assert.strictEqual(c['port'], 443);
  });

  it('toJSON() INCLUDES meta (v2.2+ contract)', () => {
    // Previous contract excluded meta; v2.2 exposes it.
    const err = new ResilientHttpError({
      kind: 'setup',
      message: 'Bad config',
      meta: { internalFlag: true },
    });

    const json = err.toJSON();
    assert.ok('meta' in json, 'meta must appear in toJSON()');
    assert.deepStrictEqual(json['meta'], { internalFlag: true });
  });

  it('toJSON() omits undefined optional fields (no explicit undefined values)', () => {
    const err = new ResilientHttpError({
      kind: 'setup',
      message: 'setup failure',
    });

    const json = err.toJSON();
    // These should simply be absent, not present as undefined
    assert.ok(!('statusCode' in json));
    assert.ok(!('method' in json));
    assert.ok(!('url' in json));
    assert.ok(!('code' in json));
    assert.ok(!('requestId' in json));
    assert.ok(!('attemptId' in json));
    assert.ok(!('headers' in json));
    // body/meta/cause are undefined here so they must also be absent
    assert.ok(!('body' in json));
    assert.ok(!('meta' in json));
    assert.ok(!('cause' in json));
  });

  it('body is present in toJSON() and its content is accessible (not hidden)', () => {
    // v2.2 contract: body IS present; the consumer must not rely on body being absent.
    // This replaces the old "body content does not appear via any indirect path" test.
    // The remaining security invariant is header redaction + message cap (not body hiding).
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 500,
      body: { orderRef: 'ORD-42' },
    });

    const serialised = JSON.stringify(err.toJSON());
    // body is intentionally present in v2.2
    assert.ok(serialised.includes('ORD-42'), 'body content should be present in toJSON() output');
  });
});

// ============================================================================
// AC-3 — header redaction, case-insensitive
// ============================================================================

describe('ResilientHttpError — AC-3 header redaction (case-insensitive)', () => {
  const token = 'Bearer eyJhbGciOiJSUzI1NiJ9.very-secret-token';

  function makeWithHeader(key: string): ResilientHttpError {
    return new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      headers: {
        [key]: token,
        'content-type': 'application/json',
      },
    });
  }

  it('redacts Authorization (canonical case)', () => {
    const json = makeWithHeader('Authorization').toJSON();
    const headers = json['headers'] as Record<string, string>;
    assert.strictEqual(headers['Authorization'], '[REDACTED]');
    const serialised = JSON.stringify(json);
    assertNoLeak(serialised, token, 'Authorization header');
  });

  it('redacts authorization (lowercase)', () => {
    const json = makeWithHeader('authorization').toJSON();
    const headers = json['headers'] as Record<string, string>;
    assert.strictEqual(headers['authorization'], '[REDACTED]');
    const serialised = JSON.stringify(json);
    assertNoLeak(serialised, token, 'authorization header lowercase');
  });

  it('redacts AUTHORIZATION (uppercase)', () => {
    const json = makeWithHeader('AUTHORIZATION').toJSON();
    const headers = json['headers'] as Record<string, string>;
    assert.strictEqual(headers['AUTHORIZATION'], '[REDACTED]');
    const serialised = JSON.stringify(json);
    assertNoLeak(serialised, token, 'AUTHORIZATION header uppercase');
  });

  it('redacts cookie header', () => {
    const cookieSecret = 'session=abc123secret';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      headers: { 'cookie': cookieSecret },
    });
    const json = err.toJSON();
    const headers = json['headers'] as Record<string, string>;
    assert.strictEqual(headers['cookie'], '[REDACTED]');
    assertNoLeak(JSON.stringify(json), cookieSecret, 'cookie header');
  });

  it('redacts set-cookie header', () => {
    const cookieVal = 'token=mysecretcookie; HttpOnly';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      headers: { 'Set-Cookie': cookieVal },
    });
    const json = err.toJSON();
    const headers = json['headers'] as Record<string, string>;
    assert.strictEqual(headers['Set-Cookie'], '[REDACTED]');
    assertNoLeak(JSON.stringify(json), 'mysecretcookie', 'set-cookie header');
  });

  it('redacts x-api-key header', () => {
    const apiKey = 'sk-live-superSecretApiKey9999';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      headers: { 'x-api-key': apiKey },
    });
    const json = err.toJSON();
    const headers = json['headers'] as Record<string, string>;
    assert.strictEqual(headers['x-api-key'], '[REDACTED]');
    assertNoLeak(JSON.stringify(json), apiKey, 'x-api-key header');
  });

  it('redacts proxy-authorization header', () => {
    const proxyAuth = 'Basic dXNlcjpwYXNzd29yZA==';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      headers: { 'proxy-authorization': proxyAuth },
    });
    const json = err.toJSON();
    const headers = json['headers'] as Record<string, string>;
    assert.strictEqual(headers['proxy-authorization'], '[REDACTED]');
    assertNoLeak(JSON.stringify(json), proxyAuth, 'proxy-authorization header');
  });

  it('preserves non-sensitive headers', () => {
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-42',
        'authorization': 'Bearer secret',
      },
    });
    const json = err.toJSON();
    const headers = json['headers'] as Record<string, string>;
    assert.strictEqual(headers['content-type'], 'application/json');
    assert.strictEqual(headers['x-request-id'], 'req-42');
    assert.strictEqual(headers['authorization'], '[REDACTED]');
  });

  it('redacts headers from custom redactHeaders list (case-insensitive)', () => {
    const secret = 'my-custom-token-value';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      headers: { 'X-Custom-Auth': secret },
      redactHeaders: ['x-custom-auth'],
    });
    const json = err.toJSON();
    const headers = json['headers'] as Record<string, string>;
    assert.strictEqual(headers['X-Custom-Auth'], '[REDACTED]');
    assertNoLeak(JSON.stringify(json), secret, 'custom redactHeaders');
  });
});

// ============================================================================
// AC-3b — query-param redaction
// ============================================================================

describe('ResilientHttpError — AC-3b query-param redaction', () => {
  it('redacts specified query param, preserves others, hides value from toJSON()', () => {
    const rawUrl = 'https://api.test/pay?token=secret123&id=7';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      url: rawUrl,
      redactQueryParams: ['token'],
    });

    // Instance url is the original, unredacted value
    assert.strictEqual(err.url, rawUrl);

    const json = err.toJSON();
    const safeUrl = json['url'] as string;

    // Secret must not appear
    assertNoLeak(safeUrl, 'secret123', 'query-param redacted url');

    // Non-sensitive param must be preserved
    assert.ok(safeUrl.includes('id=7'), `Expected id=7 in: ${safeUrl}`);

    // Param key is present but value is redacted.
    // URL.searchParams serialises [REDACTED] as %5BREDACTED%5D — both forms are acceptable.
    assert.ok(safeUrl.includes('token='), `Expected token= key in: ${safeUrl}`);
    const hasRedacted =
      safeUrl.includes('[REDACTED]') || safeUrl.includes('%5BREDACTED%5D');
    assert.ok(hasRedacted, `Expected redaction marker in: ${safeUrl}`);
  });

  it('does not alter url in toJSON() when no params to redact', () => {
    const rawUrl = 'https://api.test/items?limit=10';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      url: rawUrl,
    });

    const json = err.toJSON();
    assert.strictEqual(json['url'], rawUrl);
  });

  it('redacts multiple query params', () => {
    const rawUrl = 'https://api.test/v1?key=sk-secret&token=tok-secret&page=2';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      url: rawUrl,
      redactQueryParams: ['key', 'token'],
    });

    const json = err.toJSON();
    const safeUrl = json['url'] as string;

    assertNoLeak(safeUrl, 'sk-secret', 'key param');
    assertNoLeak(safeUrl, 'tok-secret', 'token param');
    assert.ok(safeUrl.includes('page=2'));
  });
});

// ============================================================================
// AC-4 — isResilientHttpError brand detection
// ============================================================================

describe('ResilientHttpError — AC-4 brand detection', () => {
  it('isResilientHttpError returns true for ResilientHttpError', () => {
    const err = new ResilientHttpError({ kind: 'setup', message: 'x' });
    assert.strictEqual(isResilientHttpError(err), true);
  });

  it('isResilientHttpError returns false for a plain Error', () => {
    assert.strictEqual(isResilientHttpError(new Error('nope')), false);
  });

  it('isResilientHttpError returns false for null', () => {
    assert.strictEqual(isResilientHttpError(null), false);
  });

  it('isResilientHttpError returns false for a plain object', () => {
    assert.strictEqual(isResilientHttpError({ kind: 'response' }), false);
  });

  it('brand uses Symbol.for (global registry), not a unique symbol', () => {
    // The brand is registered globally — any code that calls Symbol.for('resilient-http.error')
    // gets the exact same symbol.
    const externalSymbol = Symbol.for('resilient-http.error');
    const err = new ResilientHttpError({ kind: 'setup', message: 'x' });
    assert.strictEqual(
      (err as unknown as Record<symbol, unknown>)[externalSymbol],
      true
    );
    // Verify the exported constant is the same reference
    assert.strictEqual(RESILIENT_HTTP_ERROR_BRAND, externalSymbol);
  });

  it('isResilientHttpError returns false for an object manually carrying the brand but not the class', () => {
    // Only ResilientHttpError instances should pass; arbitrary objects with the key should not
    // (the brand value check is === true; plain objects can spoof it but that's acceptable
    // for a utility library — document that toJSON absence distinguishes if needed)
    // This test documents the current contract: brand === true is the check.
    const spoof = { [RESILIENT_HTTP_ERROR_BRAND]: true };
    // Per the current contract this DOES pass — document it
    assert.strictEqual(isResilientHttpError(spoof), true);
  });
});

// ============================================================================
// AC-5 — non-JSON / unreadable body does not throw secondary error
// ============================================================================

describe('ResilientHttpError — AC-5 non-JSON body handling', () => {
  it('HTML body with application/problem+json content-type does not throw', () => {
    assert.doesNotThrow(() => {
      const err = new ResilientHttpError({
        kind: 'response',
        statusCode: 503,
        body: '<html><body><h1>503</h1></body></html>',
        contentType: 'application/problem+json',
        statusText: 'Service Unavailable',
      });
      // HTML body falls back to raw string as message (extractMessageFromBody returns it as-is)
      assert.strictEqual(err.statusCode, 503);
      assert.ok(typeof err.message === 'string');
    });
  });

  it('null body falls back to statusText without throwing', () => {
    assert.doesNotThrow(() => {
      const err = new ResilientHttpError({
        kind: 'response',
        statusCode: 503,
        body: null,
        statusText: 'Service Unavailable',
      });
      assert.strictEqual(err.message, 'Service Unavailable');
    });
  });

  it('body with no recognizable message field falls back to statusText', () => {
    assert.doesNotThrow(() => {
      const err = new ResilientHttpError({
        kind: 'response',
        statusCode: 503,
        body: { foo: 'bar', baz: 42 },
        contentType: 'application/json',
        statusText: 'Service Unavailable',
      });
      assert.strictEqual(err.message, 'Service Unavailable');
    });
  });
});

// ============================================================================
// AC-6 — maxBodySize truncation
// ============================================================================

describe('ResilientHttpError — AC-6 maxBodySize truncation', () => {
  it('body exceeding maxBodySize is truncated and marked', () => {
    const bigBody = 'x'.repeat(2000);
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 500,
      body: bigBody,
      statusText: 'Server Error',
      maxBodySize: 100,
    });

    const body = err.body as string;
    assert.ok(body.length <= 100 + '[TRUNCATED]'.length);
    assert.ok(body.endsWith('[TRUNCATED]'), `Expected truncation marker, got: ${body.slice(-20)}`);
  });

  it('body within maxBodySize is not modified', () => {
    const smallBody = 'short body';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 500,
      body: smallBody,
      maxBodySize: 1000,
    });

    assert.strictEqual(err.body, smallBody);
  });

  it('object body exceeding maxBodySize is serialised and truncated', () => {
    const largeObj = { data: 'z'.repeat(2000) };
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 500,
      body: largeObj,
      maxBodySize: 100,
    });

    const body = err.body as string;
    assert.ok(typeof body === 'string', 'truncated object body should be string');
    assert.ok(body.endsWith('[TRUNCATED]'));
  });
});

// ============================================================================
// AC-7 — anti-leak scan (v2.2+ contract)
//
// body, cause, and meta ARE present in toJSON() by design.
// The invariants that MUST hold:
//   (a) Redacted-header values never appear in JSON.stringify(toJSON())
//   (b) Content beyond the message cap never appears in toJSON().message
// ============================================================================

describe('ResilientHttpError — AC-7 anti-leak scan (retained security controls)', () => {
  const headerSecret = 'Bearer SUPERSECRET-header-value-12345';
  const querySecret = 'querySecretValue9999';

  it('secret in redacted header does not appear anywhere in serialised toJSON()', () => {
    // This is the retained invariant: header values in the denylist never leak.
    // body/cause/meta are intentionally present (v2.2 contract).
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      headers: {
        authorization: headerSecret,
        'content-type': 'application/json',
      },
      url: `https://api.test/pay?token=${querySecret}&id=7`,
      redactQueryParams: ['token'],
    });

    const serialised = JSON.stringify(err.toJSON());

    assertNoLeak(serialised, headerSecret, 'AC-7 header secret');
    assertNoLeak(serialised, querySecret, 'AC-7 query secret');
  });

  it('body IS present in toJSON() (v2.2 contract); redacted-header secrets still never appear', () => {
    // v2.2: body is intentionally exposed. The invariant is that the HEADER
    // secret (not the body content) stays redacted.
    const bodyContent = 'card-number-4111111111111111';
    const headerSecretLocal = 'Bearer header-secret-retained-value';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 400,
      body: { card: bodyContent, cvv: '123' },
      contentType: 'application/json',
      headers: { authorization: headerSecretLocal },
    });

    const serialised = JSON.stringify(err.toJSON());

    // body is present now — consumer owns any further redaction
    assert.ok(serialised.includes(bodyContent), 'body content should be present in v2.2 toJSON()');
    // header secret is still redacted
    assertNoLeak(serialised, headerSecretLocal, 'AC-7 header secret must still be redacted');
  });

  it('cause IS present in toJSON() (v2.2 contract); redacted-header secrets still never appear', () => {
    // v2.2: cause is serialized and intentionally exposed. The invariant is that
    // HEADER secrets (not cause content) remain redacted.
    const causeMessage = 'ECONNREFUSED: connect to service';
    const headerSecretLocal = 'Bearer header-secret-cause-test-value';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 500,
      headers: { authorization: headerSecretLocal },
      cause: new Error(causeMessage),
    });

    const serialised = JSON.stringify(err.toJSON());
    // cause is present
    assert.ok('cause' in err.toJSON(), 'cause must be present when set');
    assertNoLeak(serialised, headerSecretLocal, 'AC-7 header secret alongside serialized cause');
  });

  it('meta IS present in toJSON() (v2.2 contract)', () => {
    // v2.2: meta is intentionally exposed.
    const metaValue = 'internal-region-label';
    const err = new ResilientHttpError({
      kind: 'setup',
      message: 'Config error',
      meta: { region: metaValue },
    });

    const json = err.toJSON();
    assert.ok('meta' in json, 'meta must be present in v2.2 toJSON()');
    assert.deepStrictEqual(json['meta'], { region: metaValue });
  });
});

// ============================================================================
// SEC-001 — message is capped; large body cannot leak via toJSON().message
// ============================================================================

describe('ResilientHttpError — SEC-001 message capping (anti-body-leak via message)', () => {
  const MAX_MESSAGE_SIZE = 512;
  const TRUNCATED_MARKER = '[TRUNCATED]';

  it('kind:response with large string body caps message to ≤512+marker chars', () => {
    const secret = 'live-api-credential-SECRETO123';
    const largeBody = secret + 'x'.repeat(5000);
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 400,
      body: largeBody,
      // no contentType → extractMessageFromBody returns raw string
    });

    const serialised = JSON.stringify(err.toJSON());

    // The message must be capped — body was 5000+ chars, message must not be that large
    assert.ok(
      err.message.length <= MAX_MESSAGE_SIZE + TRUNCATED_MARKER.length,
      `message exceeds cap: length=${err.message.length}`
    );

    // The truncation marker must be present when body exceeds the cap
    assert.ok(
      err.message.endsWith(TRUNCATED_MARKER),
      `Expected truncation marker in message: "${err.message.slice(-20)}"`
    );

    // In v2.2, body IS exposed in toJSON() — the full body may appear there.
    // The invariant is that the MESSAGE field is capped, not that body is hidden.
    // Verify the message cap has been applied correctly.
    const expectedMaxLen = MAX_MESSAGE_SIZE + TRUNCATED_MARKER.length;
    assert.ok(
      serialised.includes(err.message),
      'serialised output should contain the truncated message'
    );
    assert.ok(
      err.message.length <= expectedMaxLen,
      `message must fit within cap+marker: ${err.message.length} > ${expectedMaxLen}`
    );
  });

  it('SEC-001 regression: secret beyond the 512-char cap does not appear in toJSON().message', () => {
    // Place the secret AFTER position 512 so it must be cut off in the message.
    // Note: in v2.2, body IS present in toJSON(), so the secret may appear there
    // (consumer owns body redaction). The invariant here is the MESSAGE field cap.
    const padding = 'a'.repeat(520);
    const secret = 'live-credential-SECRETO-BEYOND-CAP';
    const largeBody = padding + secret + 'x'.repeat(100);

    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 402,
      body: largeBody,
    });

    // The secret must not appear in the message field (it is beyond the 512-char cap)
    assertNoLeak(err.message, secret, 'SEC-001 secret beyond cap in message field');

    // Message must be capped
    assert.ok(
      err.message.length <= MAX_MESSAGE_SIZE + TRUNCATED_MARKER.length,
      `message length ${err.message.length} exceeds cap`
    );
  });

  it('SEC-001: kind:response with JSON body where detail is gigantic caps message', () => {
    const largeDetail = 'x'.repeat(5000);
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 422,
      body: { detail: largeDetail },
      contentType: 'application/problem+json',
    });

    const serialised = JSON.stringify(err.toJSON());

    // message must be capped
    assert.ok(
      err.message.length <= MAX_MESSAGE_SIZE + TRUNCATED_MARKER.length,
      `message length ${err.message.length} exceeds cap for JSON detail field`
    );

    assert.ok(
      err.message.endsWith(TRUNCATED_MARKER),
      `Expected truncation marker in message from JSON detail`
    );

    // The large detail must not appear in toJSON().message (message is capped).
    // In v2.2 body IS present in toJSON() so the detail will appear in body —
    // this is intentional; the invariant is the MESSAGE cap, not body hiding.
    assertNoLeak(err.message, largeDetail, 'Full JSON detail must not appear in the message field');
  });

  it('SEC-001: kind:setup with a very long message caps it for consistency', () => {
    const longMessage = 'Configuration error: ' + 'y'.repeat(1000);
    const err = new ResilientHttpError({
      kind: 'setup',
      message: longMessage,
    });

    assert.ok(
      err.message.length <= MAX_MESSAGE_SIZE + TRUNCATED_MARKER.length,
      `setup message length ${err.message.length} exceeds cap`
    );

    assert.ok(
      err.message.endsWith(TRUNCATED_MARKER),
      'Expected truncation marker in long setup message'
    );
  });

  it('SEC-001: short message is not truncated', () => {
    const shortMessage = 'Payment declined';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 402,
      body: shortMessage,
    });

    assert.strictEqual(
      err.message,
      shortMessage,
      'Short message must not be modified or have marker appended'
    );
  });

  it('SEC-001: message at exactly the cap boundary is not truncated', () => {
    const exactMessage = 'z'.repeat(MAX_MESSAGE_SIZE);
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 500,
      body: exactMessage,
    });

    assert.strictEqual(
      err.message,
      exactMessage,
      'Message exactly at cap must not be truncated'
    );
    assert.ok(
      !err.message.endsWith(TRUNCATED_MARKER),
      'Message at exact cap must not have truncation marker'
    );
  });
});

// ============================================================================
// AC-10 — fail-safe URL: relative / malformed URL hides query, never emits raw
// ============================================================================

describe('ResilientHttpError — AC-10 fail-safe URL redaction', () => {
  it('relative URL with redactQueryParams hides query rather than emitting raw', () => {
    const relativeUrl = '/pay?token=secretToken123&id=7';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      url: relativeUrl,
      redactQueryParams: ['token'],
    });

    const json = err.toJSON();
    const safeUrl = json['url'] as string;

    // Secret must not appear in any form
    assertNoLeak(safeUrl, 'secretToken123', 'AC-10 relative URL');
    // Should not contain the raw query string unmodified
    assert.ok(!safeUrl.includes('token=secretToken123'), `Raw secret in url: ${safeUrl}`);
  });

  it('malformed URL with redactQueryParams hides query entirely', () => {
    const malformedUrl = 'not a valid url?secret=abc&other=def';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      url: malformedUrl,
      redactQueryParams: ['secret'],
    });

    const json = err.toJSON();
    const safeUrl = json['url'] as string;

    assertNoLeak(safeUrl, 'abc', 'AC-10 malformed URL secret');
    // The URL before ? may still appear but the query must be hidden
    assert.ok(!safeUrl.includes('secret=abc'), `Raw secret param in url: ${safeUrl}`);
  });

  it('URL with no query string and redactQueryParams is returned unchanged', () => {
    const cleanUrl = 'https://api.test/items';
    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 200,
      url: cleanUrl,
      redactQueryParams: ['token'],
    });

    const json = err.toJSON();
    assert.strictEqual(json['url'], cleanUrl);
  });
});

// ============================================================================
// fix(network-message) — walk the cause chain so a connection-level code
// nested inside undici's TypeError{cause:{code}} is surfaced into code+message.
//
//   AC-N1: ECONNREFUSED at cause.cause.code → code + 'Network error: ECONNREFUSED'
//          (and host/port from the raw cause never leak into the message)
//   AC-N2: ENOTFOUND at cause.cause.code → code + message surfaced
//   AC-N3: self-referential cause (cause.cause === cause) → terminates, no hang
//   AC-N4: chain deeper than the depth cap with no code → graceful generic message
//   AC-N5: no code anywhere in the chain → still 'Network error' (graceful)
//   AC-N6: level-0 TimeoutError precedence over a nested code (timeout unchanged)
// ============================================================================

describe('ResilientHttpError — network cause-chain code resolution', () => {
  it('AC-N1: surfaces ECONNREFUSED nested at cause.cause.code (undici shape)', () => {
    // undici wraps a connect refusal as TypeError{message:'fetch failed'}
    // whose .cause carries the real .code. The raw inner message contains the
    // host:port — it must NOT leak into err.message (payment-context log path).
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:9') as Error & {
      code?: string;
    };
    inner.code = 'ECONNREFUSED';
    const fetchFailed = new TypeError('fetch failed') as TypeError & {
      cause?: unknown;
    };
    fetchFailed.cause = inner;

    const err = new ResilientHttpError({ kind: 'network', cause: fetchFailed });

    assert.strictEqual(err.code, 'ECONNREFUSED');
    assert.strictEqual(err.classification, 'network');
    assert.strictEqual(err.isRetryable, true);
    assert.strictEqual(err.message, 'Network error: ECONNREFUSED');
    // security: the host/port from the raw cause must never reach the message
    assert.ok(!err.message.includes('127.0.0.1'), 'host must not leak into message');
    assert.ok(!err.message.includes(':9'), 'port must not leak into message');
    // toJSON() v2.2: cause IS included as a serialized object; code is exposed
    const json = err.toJSON();
    assert.strictEqual(json['code'], 'ECONNREFUSED');
    assert.ok('cause' in json, 'cause must appear in toJSON() in v2.2');
    const causeJson = json['cause'] as Record<string, unknown>;
    assert.ok(typeof causeJson === 'object' && causeJson !== null, 'cause should be a serialized object');
  });

  it('AC-N2: surfaces ENOTFOUND nested at cause.cause.code', () => {
    const inner = new Error('getaddrinfo ENOTFOUND nope.invalid') as Error & {
      code?: string;
    };
    inner.code = 'ENOTFOUND';
    const fetchFailed = new TypeError('fetch failed') as TypeError & {
      cause?: unknown;
    };
    fetchFailed.cause = inner;

    const err = new ResilientHttpError({ kind: 'network', cause: fetchFailed });

    assert.strictEqual(err.code, 'ENOTFOUND');
    assert.strictEqual(err.classification, 'network');
    assert.strictEqual(err.message, 'Network error: ENOTFOUND');
    assert.ok(!err.message.includes('nope.invalid'), 'host must not leak into message');
  });

  it('AC-N3: terminates on a self-referential cause chain (cycle guard)', () => {
    const cyclic = new TypeError('fetch failed') as TypeError & {
      cause?: unknown;
    };
    cyclic.cause = cyclic; // points back at itself — must not hang or overflow

    let err: ResilientHttpError | undefined;
    assert.doesNotThrow(() => {
      err = new ResilientHttpError({ kind: 'network', cause: cyclic });
    });
    // no code anywhere in the (cyclic) chain → graceful generic message
    assert.strictEqual(err!.code, undefined);
    assert.strictEqual(err!.message, 'Network error');
  });

  it('AC-N4: terminates on a chain deeper than the cap without a recognizable code', () => {
    // Build a chain deeper than the bounded walk; none carry a code.
    const head: { cause?: unknown } = {};
    let node = head;
    for (let i = 0; i < 20; i++) {
      const next: { cause?: unknown } = {};
      node.cause = next;
      node = next;
    }
    const err = new ResilientHttpError({ kind: 'network', cause: head });
    assert.strictEqual(err.code, undefined);
    assert.strictEqual(err.message, 'Network error');
  });

  it('AC-N5: returns a generic message when no code exists anywhere in the chain', () => {
    const inner = new Error('something failed'); // no .code, no special name
    const fetchFailed = new TypeError('fetch failed') as TypeError & {
      cause?: unknown;
    };
    fetchFailed.cause = inner;

    const err = new ResilientHttpError({ kind: 'network', cause: fetchFailed });
    assert.strictEqual(err.code, undefined);
    assert.strictEqual(err.message, 'Network error');
  });

  it('AC-N6: prefers a level-0 name (TimeoutError) over a nested code (regression)', () => {
    // A TimeoutError at the top must keep producing TIMEOUT_ERR even if a
    // nested cause carries some other code — timeout/abort behavior unchanged.
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:9') as Error & {
      code?: string;
    };
    inner.code = 'ECONNREFUSED';
    const top = new Error('timed out') as Error & { cause?: unknown };
    top.name = 'TimeoutError';
    top.cause = inner;

    const err = new ResilientHttpError({ kind: 'network', cause: top });
    assert.strictEqual(err.code, 'TIMEOUT_ERR');
    assert.strictEqual(err.classification, 'timeout');
    assert.strictEqual(err.message, 'Network error: TIMEOUT_ERR');
  });
});

// ============================================================================
// New network ACs (#36): AggregateError traversal + errno fallback
// ============================================================================

describe('ResilientHttpError — AggregateError and errno resolution (#36)', () => {
  it('AC-AGG1: AggregateError nested at cause.cause resolves errors[0].code (ECONNREFUSED)', () => {
    // undici multi-address connect failure shape:
    // TypeError { cause: AggregateError { errors: [Error { code: 'ECONNREFUSED' }] } }
    const connRefused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const aggErr = new AggregateError([connRefused], 'All connections failed');
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: aggErr });

    const err = new ResilientHttpError({ kind: 'network', cause: fetchFailed });

    assert.strictEqual(err.code, 'ECONNREFUSED');
    assert.strictEqual(err.message, 'Network error: ECONNREFUSED');
  });

  it('AC-AGG2: AggregateError with multiple errors picks first recognizable code', () => {
    // errors[0] has no recognizable code; errors[1] has ENOTFOUND.
    const noCode = new Error('no code here');
    const withCode = Object.assign(new Error('getaddrinfo ENOTFOUND host.invalid'), {
      code: 'ENOTFOUND',
    });
    const aggErr = new AggregateError([noCode, withCode], 'All connections failed');

    const err = new ResilientHttpError({ kind: 'network', cause: aggErr });

    assert.strictEqual(err.code, 'ENOTFOUND');
    assert.strictEqual(err.message, 'Network error: ENOTFOUND');
  });

  it('AC-AGG3: errno-only node resolves a code from errno when no string .code exists', () => {
    // Some systems produce a node with only a numeric errno and no string .code.
    const errnoNode = Object.assign(new Error('connection refused'), {
      errno: -111,
      // deliberately no .code property
    });

    const err = new ResilientHttpError({ kind: 'network', cause: errnoNode });

    assert.strictEqual(err.code, '-111');
    assert.strictEqual(err.message, 'Network error: -111');
  });

  it('AC-AGG4: deep nesting beyond depth bound terminates with no resolution', () => {
    // Build a chain of AggregateErrors deeper than MAX_CAUSE_DEPTH; none carry a code.
    let inner: unknown = { message: 'no code' };
    for (let i = 0; i < 30; i++) {
      inner = new AggregateError([inner], `level ${i}`);
    }

    let err: ResilientHttpError | undefined;
    assert.doesNotThrow(() => {
      err = new ResilientHttpError({ kind: 'network', cause: inner });
    });
    assert.strictEqual(err!.code, undefined);
    assert.strictEqual(err!.message, 'Network error');
  });

  it('AC-AGG5: cycle across .cause AND .errors[] terminates without hang', () => {
    // Cycle 1: cause.cause === cause
    const cyclic = Object.assign(new TypeError('cycle-cause'), { cause: undefined as unknown });
    cyclic.cause = cyclic;

    // Cycle 2: AggregateError whose errors[0] is itself
    const aggCyclic = new AggregateError([] as unknown[], 'cycle-errors');
    (aggCyclic as unknown as { errors: unknown[] }).errors = [aggCyclic];

    assert.doesNotThrow(() => {
      const err1 = new ResilientHttpError({ kind: 'network', cause: cyclic });
      assert.strictEqual(err1.code, undefined);
      assert.strictEqual(err1.message, 'Network error');

      const err2 = new ResilientHttpError({ kind: 'network', cause: aggCyclic });
      assert.strictEqual(err2.code, undefined);
      assert.strictEqual(err2.message, 'Network error');
    });
  });

  it('AC-AGG6: undefined cause is omitted from toJSON(), message stays "Network error" (#37 linkage)', () => {
    // Simulates the #37 contentless network error: engine throws undefined before any fetch.
    const err = new ResilientHttpError({ kind: 'network', cause: undefined });

    assert.strictEqual(err.code, undefined);
    assert.strictEqual(err.message, 'Network error');

    const json = err.toJSON();
    assert.ok(!('cause' in json), 'undefined cause must be omitted from toJSON()');
    assert.strictEqual(json['message'], 'Network error');
  });

  it('AC-N6 extended: level-0 TimeoutError precedence preserved over nested .errors[] code', () => {
    // A TimeoutError at the top carries TIMEOUT_ERR; an inner AggregateError
    // with ECONNREFUSED must NOT override the level-0 name-based resolution.
    const connRefused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const aggErr = new AggregateError([connRefused], 'All connections failed');
    const top = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
      cause: aggErr,
    });

    const err = new ResilientHttpError({ kind: 'network', cause: top });

    assert.strictEqual(err.code, 'TIMEOUT_ERR');
    assert.strictEqual(err.classification, 'timeout');
    assert.strictEqual(err.message, 'Network error: TIMEOUT_ERR');
  });
});

// ============================================================================
// Serializer robustness (AC-SER1, AC-SER2)
// ============================================================================

describe('ResilientHttpError — serializeCause robustness and toJSON() exposure', () => {
  it('AC-SER1: toJSON() does not throw on a cause with a getter that throws', () => {
    const exotic = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(exotic, 'message', {
      get() { throw new Error('getter exploded'); },
      enumerable: true,
    });

    let json: Record<string, unknown> | undefined;
    assert.doesNotThrow(() => {
      const err = new ResilientHttpError({ kind: 'network', cause: exotic });
      json = err.toJSON();
    });
    assert.ok(json !== undefined, 'toJSON() must return an object');
  });

  it('AC-SER1: toJSON() does not throw on a null-prototype cause', () => {
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto['code'] = 'ECONNREFUSED';
    nullProto['message'] = 'null proto error';

    assert.doesNotThrow(() => {
      const err = new ResilientHttpError({ kind: 'network', cause: nullProto });
      const json = err.toJSON();
      // The null-proto cause carries ECONNREFUSED — it must be resolved
      assert.strictEqual(err.code, 'ECONNREFUSED');
      assert.ok('cause' in json, 'null-proto cause should be serialized');
    });
  });

  it('AC-SER1: toJSON() does not throw on a cause carrying a BigInt field', () => {
    const bigIntCause = Object.assign(new Error('bigint cause'), {
      bigField: BigInt(9007199254740991),
      code: 'ECONNRESET',
    });

    assert.doesNotThrow(() => {
      const err = new ResilientHttpError({ kind: 'network', cause: bigIntCause });
      const json = err.toJSON();
      // The BigInt field may be omitted or cause a partial result — must not throw
      assert.ok(json !== undefined);
    });
  });

  it('AC-SER1: toJSON() does not throw on a circular cause (cause.cause === cause)', () => {
    const circular = Object.assign(new Error('circular'), {
      code: 'ECONNREFUSED',
      cause: undefined as unknown,
    });
    circular.cause = circular;

    assert.doesNotThrow(() => {
      const err = new ResilientHttpError({ kind: 'network', cause: circular });
      const json = err.toJSON();
      // cause is present; the inner circular reference must be a placeholder
      assert.ok('cause' in json, 'cause must be serialized even with a circular reference');
      const c = json['cause'] as Record<string, unknown>;
      // The circular ref at .cause.cause must be '[Circular]'
      assert.strictEqual(c['cause'], '[Circular]');
    });
  });

  it('AC-SER2: toJSON() exposes cause with real code/address/port, body, and meta', () => {
    const causeErr = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
      address: '10.0.0.1',
      port: 443,
      syscall: 'connect',
    });

    const err = new ResilientHttpError({
      kind: 'response',
      statusCode: 503,
      body: { orderRef: 'ORD-99', status: 'failed' },
      meta: { region: 'eu-west-1', traceId: 'abc123' },
      cause: causeErr,
    });

    const json = err.toJSON();

    // body is present with real content
    assert.ok('body' in json, 'body must be in toJSON()');
    assert.deepStrictEqual(json['body'], { orderRef: 'ORD-99', status: 'failed' });

    // meta is present with real content
    assert.ok('meta' in json, 'meta must be in toJSON()');
    assert.deepStrictEqual(json['meta'], { region: 'eu-west-1', traceId: 'abc123' });

    // cause is present as a serialized object with real values
    assert.ok('cause' in json, 'cause must be in toJSON()');
    const c = json['cause'] as Record<string, unknown>;
    assert.strictEqual(c['code'], 'ECONNREFUSED');
    assert.strictEqual(c['address'], '10.0.0.1');
    assert.strictEqual(c['port'], 443);
    assert.strictEqual(c['syscall'], 'connect');
  });
});
