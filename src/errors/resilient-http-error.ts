/**
 * ResilientHttpError — the canonical error class for resilient-http v2.
 *
 * Design decisions:
 * - Brand uses Symbol.for() (global registry) so the brand survives across
 *   module boundaries and duplicate installs. `instanceof` is intentionally
 *   NOT the detection mechanism because it breaks in those scenarios.
 * - toJSON() is safe-by-default: body, cause, and meta are NEVER emitted
 *   to prevent secrets / PII from reaching logs or BFF wire responses.
 * - Header redaction and query-param redaction are presentation-only;
 *   the underlying instance fields are never mutated.
 * - URL parsing is fail-safe: any parse failure causes full query redaction
 *   rather than emitting a raw string that may contain secrets.
 *
 * Security: this module is on the path to payment-context logs — do not
 * add any code that emits raw headers, raw query strings, or raw bodies
 * without explicit redaction.
 */

import type { ErrorKind, ErrorClassification, StandardizedError } from '../types';
import { classifyError, isRetryableError } from '../core/classify';
import { extractMessageFromBody } from '../core/message';

// ============================================================================
// Global brand symbol — Symbol.for() so it works across module instances
// ============================================================================

/** @internal */
export const RESILIENT_HTTP_ERROR_BRAND = Symbol.for('resilient-http.error');

// ============================================================================
// Constants
// ============================================================================

/** Default maximum captured body size (~1 MB in characters). */
const DEFAULT_MAX_BODY_SIZE = 1_048_576;

/** Sentinel appended to a truncated body to signal truncation. */
const TRUNCATED_MARKER = '[TRUNCATED]';

/**
 * Headers that must be redacted in toJSON() output.
 * Stored lower-cased for O(1) case-insensitive lookup.
 */
const REDACTED_HEADERS_DEFAULT: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
  'authentication',
  'x-auth-token',
  'x-api-token',
  'api-key',
  'www-authenticate',
]);

const REDACTED_VALUE = '[REDACTED]';

// ============================================================================
// Input shapes for each error kind
// ============================================================================

interface ResponseErrorInit {
  kind: 'response';
  statusCode: number;
  /** Raw response body (string, object, or null). Capped at maxBodySize. */
  body?: unknown;
  /** Content-Type header for problem+json-aware message extraction. */
  contentType?: string;
  /** HTTP status text, used as message fallback when body yields nothing. */
  statusText?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  attempts?: number;
  requestId?: string;
  attemptId?: string;
  meta?: Record<string, unknown>;
  cause?: unknown;
  /** Additional headers to redact beyond the built-in denylist. */
  redactHeaders?: string[];
  /** Query param names whose values must be redacted in toJSON() url output. */
  redactQueryParams?: string[];
  /** Maximum body size in characters before truncation (default: 1 MB). */
  maxBodySize?: number;
}

interface NetworkErrorInit {
  kind: 'network';
  /** Error code from the underlying cause (e.g. 'ECONNREFUSED', 'ABORT_ERR'). */
  code?: string;
  cause?: unknown;
  method?: string;
  url?: string;
  attempts?: number;
  requestId?: string;
  attemptId?: string;
  meta?: Record<string, unknown>;
  redactHeaders?: string[];
  redactQueryParams?: string[];
}

interface SetupErrorInit {
  kind: 'setup';
  message: string;
  cause?: unknown;
  method?: string;
  url?: string;
  attempts?: number;
  requestId?: string;
  attemptId?: string;
  meta?: Record<string, unknown>;
  redactHeaders?: string[];
  redactQueryParams?: string[];
}

export type ResilientHttpErrorInit =
  | ResponseErrorInit
  | NetworkErrorInit
  | SetupErrorInit;

// ============================================================================
// Helper utilities — pure functions, no side effects on external state
// ============================================================================

/**
 * Truncate a string body to maxBodySize characters and append the truncation
 * marker. Returns the original value unchanged if it fits within the limit.
 */
function truncateBody(raw: string, maxSize: number): string {
  if (raw.length <= maxSize) return raw;
  return raw.slice(0, maxSize) + TRUNCATED_MARKER;
}

/**
 * Cap an arbitrary body value to maxBodySize.
 * - string bodies: truncated directly
 * - object bodies: JSON-serialised then truncated
 * - other primitives: returned as-is (they are never large)
 */
function capBody(body: unknown, maxSize: number): unknown {
  if (typeof body === 'string') return truncateBody(body, maxSize);
  if (body !== null && typeof body === 'object') {
    try {
      const serialised = JSON.stringify(body);
      if (serialised.length <= maxSize) return body;
      // Return the truncated serialised string so the caller can see it was capped
      return serialised.slice(0, maxSize) + TRUNCATED_MARKER;
    } catch {
      return null;
    }
  }
  return body;
}

/**
 * Derive the network error code from the cause object, if available.
 * Handles AbortError (name-based) and Node/undici error objects (code-based).
 */
function resolveNetworkCode(cause: unknown, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (cause === null || cause === undefined) return undefined;
  if (typeof cause !== 'object') return undefined;

  const c = cause as Record<string, unknown>;

  // AbortError from the Fetch API or Node's AbortController
  if (c['name'] === 'AbortError') return 'ABORT_ERR';

  if (typeof c['code'] === 'string') return c['code'];
  return undefined;
}

/**
 * Redact sensitive headers, returning a new object.
 * Keys are compared case-insensitively against the combined denylist.
 * The original headers object is never mutated.
 */
function redactHeaders(
  headers: Record<string, string>,
  extraRedactList: string[]
): Record<string, string> {
  const extraLower = new Set(extraRedactList.map((h) => h.toLowerCase()));

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    const shouldRedact = REDACTED_HEADERS_DEFAULT.has(lower) || extraLower.has(lower);
    result[key] = shouldRedact ? REDACTED_VALUE : value;
  }
  return result;
}

/**
 * Redact specified query parameters in a URL string.
 *
 * Fail-safe: if the URL cannot be parsed (relative, malformed, etc.) the
 * entire query string is hidden rather than emitting the raw string which
 * may contain secrets.
 */
function redactQueryParams(rawUrl: string, paramsToRedact: string[]): string {
  if (paramsToRedact.length === 0) return rawUrl;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Fail-safe: hide query entirely — never emit the raw string with secrets
    const queryStart = rawUrl.indexOf('?');
    if (queryStart === -1) return rawUrl;
    return rawUrl.slice(0, queryStart) + '?' + REDACTED_VALUE;
  }

  const redactSet = new Set(paramsToRedact.map((p) => p.toLowerCase()));
  let modified = false;

  for (const key of Array.from(parsed.searchParams.keys())) {
    if (redactSet.has(key.toLowerCase())) {
      parsed.searchParams.set(key, REDACTED_VALUE);
      modified = true;
    }
  }

  return modified ? parsed.toString() : rawUrl;
}

// ============================================================================
// ResilientHttpError
// ============================================================================

/**
 * Canonical error class for all failures originating from resilient-http.
 *
 * Three kinds:
 * - `'response'` — server returned a non-2xx response
 * - `'network'`  — request never reached the server (ECONNREFUSED, abort, etc.)
 * - `'setup'`    — error constructing the request before network activity
 *
 * Detection: use `isResilientHttpError(e)` — never `instanceof ResilientHttpError`
 * (brand survives duplicate module installations; instanceof does not).
 */
export class ResilientHttpError extends Error implements StandardizedError {
  /** Global brand for cross-boundary detection. */
  readonly [RESILIENT_HTTP_ERROR_BRAND] = true as const;

  override readonly name = 'ResilientHttpError';

  readonly kind: ErrorKind;
  readonly classification: ErrorClassification;
  readonly isRetryable: boolean;
  readonly attempts: number;

  readonly statusCode?: number;
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly code?: string;
  override readonly cause?: unknown;
  readonly requestId?: string;
  readonly attemptId?: string;
  readonly meta?: Record<string, unknown>;

  /** @internal — header names to redact in toJSON() output */
  readonly #redactHeaders: string[];
  /** @internal — query param names to redact in toJSON() url output */
  readonly #redactQueryParams: string[];

  constructor(init: ResilientHttpErrorInit) {
    const message = ResilientHttpError.#resolveMessage(init);
    super(message);

    this.kind = init.kind;
    this.method = init.method;
    this.url = init.url;
    this.attempts = init.attempts ?? 1;
    this.requestId = init.requestId;
    this.attemptId = init.attemptId;
    this.meta = init.meta;
    this.cause = init.cause;
    this.#redactHeaders = init.redactHeaders ?? [];
    this.#redactQueryParams = init.redactQueryParams ?? [];

    if (init.kind === 'response') {
      this.statusCode = init.statusCode;
      this.headers = init.headers;
      const maxSize = init.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
      // Normalise null to undefined — null body means "no body captured"
      this.body = init.body != null ? capBody(init.body, maxSize) : undefined;

      const classification = classifyError(init.statusCode);
      this.classification = classification;
      this.isRetryable = isRetryableError(classification, init.statusCode);
    } else if (init.kind === 'network') {
      const code = resolveNetworkCode(init.cause, init.code);
      this.code = code;

      const classification = classifyError(undefined, code);
      this.classification = classification !== 'unknown' ? classification : 'network';
      this.isRetryable = isRetryableError(this.classification);
    } else {
      // kind === 'setup'
      this.classification = 'unknown';
      this.isRetryable = false;
    }
  }

  /**
   * Resolve the error message for each kind.
   * For 'response': tries extractMessageFromBody first, falls back to statusText.
   * For 'network': describes the failure with code if available.
   * For 'setup': uses the provided message directly.
   */
  static #resolveMessage(init: ResilientHttpErrorInit): string {
    if (init.kind === 'response') {
      const extracted = extractMessageFromBody(init.body, init.contentType);
      if (extracted) return extracted;
      if (init.statusText) return init.statusText;
      return `HTTP ${init.statusCode}`;
    }

    if (init.kind === 'network') {
      const code = resolveNetworkCode(init.cause, init.code);
      if (code === 'ABORT_ERR') return 'Request was aborted';
      if (code) return `Network error: ${code}`;
      return 'Network error';
    }

    // kind === 'setup'
    return init.message;
  }

  /**
   * Return a log/wire-safe JSON representation.
   *
   * Included: message, kind, statusCode, classification, isRetryable,
   *           method, url (with query redacted per redactQueryParams),
   *           code, attempts, requestId, attemptId, headers (redacted).
   *
   * Excluded: body, cause, meta — these may contain secrets or PII.
   */
  toJSON(): Record<string, unknown> {
    const safeUrl =
      this.url && this.#redactQueryParams.length > 0
        ? redactQueryParams(this.url, this.#redactQueryParams)
        : this.url;

    const safeHeaders =
      this.headers !== undefined
        ? redactHeaders(this.headers, this.#redactHeaders)
        : undefined;

    const out: Record<string, unknown> = {
      name: this.name,
      kind: this.kind,
      message: this.message,
      classification: this.classification,
      isRetryable: this.isRetryable,
      attempts: this.attempts,
    };

    // Optional fields — only include when defined so JSON is not polluted
    // with explicit undefined values (JSON.stringify strips them anyway but
    // this keeps Record shape predictable for downstream consumers).
    if (this.statusCode !== undefined) out['statusCode'] = this.statusCode;
    if (this.method !== undefined) out['method'] = this.method;
    if (safeUrl !== undefined) out['url'] = safeUrl;
    if (this.code !== undefined) out['code'] = this.code;
    if (this.requestId !== undefined) out['requestId'] = this.requestId;
    if (this.attemptId !== undefined) out['attemptId'] = this.attemptId;
    if (safeHeaders !== undefined) out['headers'] = safeHeaders;

    return out;
  }
}

// ============================================================================
// Brand-based detection helper
// ============================================================================

/**
 * Type guard that detects ResilientHttpError instances via the global brand
 * symbol. Works correctly across module boundaries and duplicate installs.
 *
 * Prefer this over `instanceof ResilientHttpError`.
 */
export function isResilientHttpError(e: unknown): e is ResilientHttpError {
  return (
    e !== null &&
    typeof e === 'object' &&
    (e as Record<symbol, unknown>)[RESILIENT_HTTP_ERROR_BRAND] === true
  );
}
