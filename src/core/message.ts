/**
 * Internal utility for extracting a human-readable message from an HTTP response body.
 *
 * This module is intentionally NOT re-exported from src/index.ts or package.json#exports.
 * It is only consumed by other modules within src/.
 *
 * Security notes:
 * - Body is parsed by the runtime JSON.parse; never merged into internal objects (no prototype pollution).
 * - Content-Type suffix matching uses plain string methods only — no regex with nested quantifiers (ReDoS-safe).
 */

/**
 * Whether the Content-Type header indicates a JSON or problem+json body.
 * Uses simple string inclusion — never a regex with nested quantifiers.
 */
function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return (
    lower.includes('application/json') ||
    lower.includes('application/problem+json') ||
    lower.endsWith('+json')
  );
}

/**
 * Whether the Content-Type header is specifically RFC 7807 problem+json.
 * Uses simple string inclusion — no regex.
 */
function isProblemJson(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes('application/problem+json');
}

/**
 * Extract a message from a parsed JSON body object.
 * Prefers RFC 7807 problem+json fields (`detail`, then `title`),
 * then falls back to common error message field names.
 */
function extractFromObject(
  body: Record<string, unknown>,
  contentType?: string
): string | undefined {
  // RFC 7807 — prefer `detail`, fall back to `title`
  if (isProblemJson(contentType)) {
    if (typeof body.detail === 'string') return body.detail;
    if (typeof body.title === 'string') return body.title;
  }

  // Also support problem+json fields when the content-type is generic JSON
  // (some APIs return problem+json structure without the correct content-type header)
  if (typeof body.detail === 'string') return body.detail;

  // Common error message field names (ordered by prevalence)
  if (typeof body.message === 'string') return body.message;
  if (typeof body.error === 'string') return body.error;
  if (typeof body.msg === 'string') return body.msg;
  if (typeof body.errorMessage === 'string') return body.errorMessage;
  if (typeof body.title === 'string') return body.title;

  // Nested error object
  if (body.error !== null && typeof body.error === 'object') {
    const nested = body.error as Record<string, unknown>;
    if (typeof nested.message === 'string') return nested.message;
  }

  return undefined;
}

/**
 * Try to parse a string as JSON and extract a message from the result.
 * Returns undefined if the string is not valid JSON or has no recognizable field.
 */
function extractFromJsonString(
  raw: string,
  contentType?: string
): string | undefined {
  if (!isJsonContentType(contentType)) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return extractFromObject(parsed as Record<string, unknown>, contentType);
    }
  } catch {
    // Not valid JSON — treat as plain string message below
  }
  return undefined;
}

/**
 * Extract a human-readable message from a response body.
 *
 * Supports:
 * - RFC 7807 problem+json (`detail` preferred, then `title`)
 * - Plain JSON objects with common error field names
 * - Raw JSON strings (parsed only when Content-Type indicates JSON)
 * - Plain string bodies (returned as-is)
 *
 * Does NOT use regex on body content — field access only (ReDoS-safe).
 * Does NOT merge the parsed body into any internal object (prototype-pollution-safe).
 *
 * @param body - The raw response body (string, object, or other)
 * @param contentType - Optional Content-Type header value
 * @returns Extracted message string, or undefined if none found
 */
export function extractMessageFromBody(
  body: unknown,
  contentType?: string
): string | undefined {
  if (body === null || body === undefined) return undefined;

  if (typeof body === 'string') {
    if (body.trim() === '') return undefined;
    // Attempt JSON parse when content-type signals JSON
    const fromJson = extractFromJsonString(body, contentType);
    if (fromJson !== undefined) return fromJson;
    // Return raw string as the message
    return body;
  }

  if (typeof body === 'object' && !Array.isArray(body)) {
    return extractFromObject(body as Record<string, unknown>, contentType);
  }

  return undefined;
}
