/**
 * 13-redaction.ts
 *
 * Tools: redactHeaders, redactQueryParams — safe toJSON() output.
 *
 * Contract:
 *   - redactHeaders: string[]  — header names (case-insensitive) to redact in toJSON().
 *     The built-in denylist already redacts: authorization, cookie, set-cookie,
 *     x-api-key, proxy-authorization, authentication, x-auth-token, x-api-token,
 *     api-key, www-authenticate.
 *     Extra names in redactHeaders are merged with the built-in list.
 *   - redactQueryParams: string[] — query-param names to redact in the url field
 *     of toJSON(). Fail-safe: if the URL cannot be parsed, the entire query
 *     string is hidden.
 *   - toJSON() ALWAYS excludes body, cause, and meta — no configuration needed.
 *   - Redaction is presentation-only: the underlying err.headers and err.url
 *     instance fields are never mutated.
 *
 * BFF pattern: sanitize the message field before forwarding to clients, because
 * the server may have embedded sensitive details in the response body that
 * extractMessageFromBody picked up.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — returns a server error with sensitive headers.
// ---------------------------------------------------------------------------

function sensitiveErrorFetch(): typeof globalThis.fetch {
  return async () =>
    new Response('{"message":"Payment declined for card XXXX-1234"}', {
      status: 402,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer supersecrettoken',
        'X-Trace-Id': 'trace-abc',
        'X-Internal-Token': 'internalxyz',
      },
    });
}

// ---------------------------------------------------------------------------
// Example A: redactHeaders — built-in list covers Authorization automatically.
// ---------------------------------------------------------------------------

export async function example13a(): Promise<void> {
  const client = createResilientHttp({
    fetch: sensitiveErrorFetch(),
  });

  try {
    await client.get('https://api.example.com/payment');
  } catch (err) {
    if (!isResilientHttpError(err)) return;

    const json = err.toJSON();
    const headers = json['headers'] as Record<string, string> | undefined;

    // Authorization is in the built-in denylist — always redacted.
    console.log(headers?.['Authorization']); // '[REDACTED]'

    // X-Trace-Id is not sensitive — emitted as-is.
    console.log(headers?.['X-Trace-Id']);    // 'trace-abc'
  }
}

// ---------------------------------------------------------------------------
// Example B: add custom header names to the redaction list.
// ---------------------------------------------------------------------------

export async function example13b(): Promise<void> {
  const client = createResilientHttp({
    fetch: sensitiveErrorFetch(),
    redactHeaders: ['x-internal-token'], // case-insensitive
  });

  try {
    await client.get('https://api.example.com/payment');
  } catch (err) {
    if (!isResilientHttpError(err)) return;

    const json = err.toJSON();
    const headers = json['headers'] as Record<string, string> | undefined;

    // Authorization — built-in denylist.
    console.log(headers?.['Authorization']);    // '[REDACTED]'
    // X-Internal-Token — custom denylist (case-insensitive match).
    console.log(headers?.['X-Internal-Token']); // '[REDACTED]'
    // X-Trace-Id — not in any denylist, emitted as-is.
    console.log(headers?.['X-Trace-Id']);       // 'trace-abc'
  }
}

// ---------------------------------------------------------------------------
// Example C: redactQueryParams — sensitive values in the URL query string.
// ---------------------------------------------------------------------------

export async function example13c(): Promise<void> {
  const fetch: typeof globalThis.fetch = async () =>
    new Response('{}', {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });

  const client = createResilientHttp({
    fetch,
    redactQueryParams: ['api_key', 'token'],
  });

  try {
    await client.get(
      'https://api.example.com/data?api_key=sk-live-abc&page=2&token=xyz'
    );
  } catch (err) {
    if (!isResilientHttpError(err)) return;

    const json = err.toJSON();
    const url = json['url'] as string;

    // api_key and token values are replaced; page is unchanged.
    console.log(url.includes('api_key=%5BREDACTED%5D')); // true
    console.log(url.includes('page=2'));                  // true
  }
}

// ---------------------------------------------------------------------------
// Example D: BFF pattern — sanitize the message field before forwarding.
//
// toJSON().message is capped at 512 chars (SEC-001 fix), but it may still
// contain user-visible server messages. In a BFF you may want to replace it
// with a generic client-safe message before sending to the browser.
// ---------------------------------------------------------------------------

export async function example13d(): Promise<void> {
  const fetch: typeof globalThis.fetch = async () =>
    new Response('{"message":"Payment declined for card XXXX-1234"}', {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });

  const client = createResilientHttp({ fetch });

  try {
    await client.post('https://api.example.com/payment', {
      json: { amount: 100 },
    });
  } catch (err) {
    if (!isResilientHttpError(err)) return;

    const raw = err.toJSON();

    // BFF sanitization: replace the server message with a generic one
    // before the JSON is forwarded to the client.
    const safePayload = {
      ...raw,
      message: 'Payment could not be processed. Please try again.',
    };

    // safePayload is now safe to send to the browser.
    console.log(safePayload['message']);
    // 'Payment could not be processed. Please try again.'

    // The original message is still available on the error object for server logs.
    console.log(err.message);
    // 'Payment declined for card XXXX-1234'
  }
}
