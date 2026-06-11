/**
 * ResilientHttpError — the canonical error class for resilient-http v2.
 *
 * Design decisions:
 * - Brand uses Symbol.for() (global registry) so the brand survives across
 *   module boundaries and duplicate installs. `instanceof` is intentionally
 *   NOT the detection mechanism because it breaks in those scenarios.
 * - toJSON() is transparency-first: body, cause (serialized, cycle-safe),
 *   and meta ARE emitted so the consumer has full context. The consumer who
 *   integrates this library owns security/redaction decisions for their sink.
 * - Header redaction and query-param redaction are the two security controls
 *   that this class enforces on behalf of all consumers (headers are a
 *   well-known credential surface; the denylist is maintained here).
 * - The message is capped at DEFAULT_MAX_MESSAGE_SIZE so a large response body
 *   (e.g. payment response with PAN/token) cannot leak via the message field
 *   into logs or BFF wire responses regardless of maxBodySize configuration
 *   (fix(security): SEC-001).
 * - URL parsing is fail-safe: any parse failure causes full query redaction
 *   rather than emitting a raw string that may contain secrets.
 * - serializeCause is fail-safe: exotic cause shapes (getter-throws, null-proto,
 *   BigInt, circular) yield a partial/placeholder, never an exception.
 *
 * Security: this module is on the path to payment-context logs — do not
 * add any code that emits raw headers or raw query strings without explicit
 * redaction.
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

/**
 * Default maximum size for the error message string (characters).
 * The message is a summary for wire/logs — not a raw body dump.
 * Capping here prevents a large body (e.g. payment response with PAN/token)
 * from escaping into logs via toJSON().message regardless of maxBodySize.
 *
 * fix(security): SEC-001 — prevents raw body leak via toJSON() message field.
 */
const DEFAULT_MAX_MESSAGE_SIZE = 512;

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
 * Truncate an error message to DEFAULT_MAX_MESSAGE_SIZE characters.
 *
 * The message ends up in toJSON() and therefore in logs and BFF wire responses.
 * A hard cap here ensures that a large response body (e.g. payment response
 * containing PAN/token/PII) cannot leak via the message field regardless of the
 * maxBodySize configuration.
 *
 * fix(security): SEC-001 — called from #resolveMessage before super(message).
 */
function truncateMessage(msg: string): string {
  if (msg.length <= DEFAULT_MAX_MESSAGE_SIZE) return msg;
  return msg.slice(0, DEFAULT_MAX_MESSAGE_SIZE) + TRUNCATED_MARKER;
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
 * Maximum number of cause-chain levels inspected when resolving a network code
 * and when serializing a cause for toJSON().
 *
 * undici nests the real connection-level code two levels deep — the top-level
 * cause is a TypeError{message:'fetch failed'} whose `.cause` carries `.code`.
 * 5 gives generous headroom for deeper wrappers while keeping the walk bounded.
 *
 * Combined with the shared visited-set cycle guard in resolveNetworkCode and
 * serializeCause, the cap makes both walks DoS-safe: a self-referential or
 * mutually-referential cause chain terminates in O(depth) without hanging or
 * overflowing the stack.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * Map a single cause node to a network code, if it carries a recognizable one.
 *
 * Name-derived signals (AbortError/TimeoutError) take precedence over a string
 * `.code` on the same node, preserving the original level-0 resolution order so
 * timeout/abort behavior is unchanged.
 *
 * Falls back to `errno` (as a string) when no string `.code` exists and no
 * special name matched — Node system errors normally short-circuit on `.code`
 * first, so the `errno` path is reached only in the rare case where a code-less
 * node carries only a numeric errno (e.g. certain AggregateError members).
 */
function codeFromCauseNode(node: Record<string, unknown>): string | undefined {
  // AbortError from the Fetch API or Node's AbortController
  if (node['name'] === 'AbortError') return 'ABORT_ERR';

  // fix(timeout): TimeoutError from AbortSignal.timeout() or buildAttemptSignal
  // when no explicit code is provided. Maps to 'TIMEOUT_ERR' so classifyError
  // produces classification:'timeout' per the StandardizedError contract.
  if (node['name'] === 'TimeoutError') return 'TIMEOUT_ERR';

  if (typeof node['code'] === 'string') return node['code'];

  // fix(errno): surface errno when no string .code exists. Node system errors
  // almost always carry both .code and .errno, but AggregateError members (undici
  // multi-address connect) occasionally omit .code while still carrying .errno.
  if (typeof node['errno'] === 'number') return String(node['errno']);

  return undefined;
}

/**
 * Derive the network error code by walking the cause chain.
 *
 * Handles AbortError/TimeoutError (name-based) and Node/undici error objects
 * (code-based). undici buries a connection-level code (e.g. ECONNREFUSED) at
 * `cause.cause.code` or inside `AggregateError.errors[].code`, so a linear
 * single-edge walk misses it. This unified walk descends BOTH `.cause` AND
 * `AggregateError.errors[]` with a single shared `visited` Set and a total-node
 * budget so that cycles and wide fan-outs terminate without hanging.
 *
 * fix(network-message): surface a diagnostic code/message for connection-level
 * failures instead of falling through to the generic 'Network error'. Only the
 * well-known code is exposed — never host, port, URL, headers, or body.
 *
 * DoS-safe: one shared `visited` set + total-node budget covers BOTH the `.cause`
 * edge and the `.errors[]` edge, so a self-referential AggregateError terminates.
 * First recognizable code wins; `errors[0]` is examined before `errors[1]`.
 */
function resolveNetworkCode(cause: unknown, explicit?: string): string | undefined {
  if (explicit) return explicit;

  const visited = new Set<unknown>();
  // Use a stack (DFS) so errors[0] is examined before errors[1] and cause is
  // examined in document order. The first recognizable code wins.
  const stack: unknown[] = [cause];
  let nodesVisited = 0;
  // Total-node budget: MAX_CAUSE_DEPTH * 4 allows for both .cause chains and
  // moderate .errors[] fan-out while remaining DoS-safe.
  const MAX_NODES = MAX_CAUSE_DEPTH * 4;

  while (stack.length > 0 && nodesVisited < MAX_NODES) {
    const current = stack.pop();

    if (current === null || current === undefined) continue;
    if (typeof current !== 'object') continue;
    if (visited.has(current)) continue; // cycle guard for both edges

    visited.add(current);
    nodesVisited++;

    const node = current as Record<string, unknown>;
    const code = codeFromCauseNode(node);
    if (code) return code;

    // Enqueue .cause AFTER .errors[] elements so that when the stack is popped
    // (LIFO), .cause is examined first (pushed last → popped first). This
    // preserves the original precedence: the direct .cause chain is preferred
    // over sibling .errors[] members at the same depth.
    if (Array.isArray(node['errors'])) {
      // Push in reverse so errors[0] is at the top of the stack (examined first).
      const errors = node['errors'] as unknown[];
      for (let i = errors.length - 1; i >= 0; i--) {
        stack.push(errors[i]);
      }
    }

    if (node['cause'] !== undefined) {
      stack.push(node['cause']);
    }
  }

  return undefined;
}

/**
 * Serialize a cause value to a plain, JSON-safe object for inclusion in toJSON().
 *
 * Cycle-safe: a shared `visited` Set prevents infinite recursion on circular
 * cause graphs. Depth-bounded: returns '[MaxDepth]' when `depth >= MAX_CAUSE_DEPTH`
 * to cap recursion regardless of chain length.
 *
 * Fail-safe: every individual field read is wrapped in its own try/catch so
 * that getters-that-throw, null-prototype objects, and BigInt fields yield a
 * partial/placeholder rather than propagating an exception. The entire function
 * body is also wrapped so an unexpected top-level failure returns a placeholder.
 *
 * Returns `undefined` for null/undefined/non-object inputs (so an undefined
 * cause, e.g. from the #37 contentless-network-error case, is simply omitted
 * from toJSON() output).
 */
function serializeCause(
  cause: unknown,
  depth: number,
  visited: Set<unknown>
): Record<string, unknown> | string | undefined {
  try {
    if (cause === null || cause === undefined) return undefined;
    if (typeof cause !== 'object') return undefined;

    if (visited.has(cause)) return '[Circular]';
    if (depth >= MAX_CAUSE_DEPTH) return '[MaxDepth]';

    visited.add(cause);

    const node = cause as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    // Read each field independently — getters may throw.
    const fields = ['name', 'message', 'code', 'errno', 'syscall', 'address', 'port', 'stack'] as const;
    for (const field of fields) {
      try {
        const val = node[field];
        if (val !== undefined) out[field] = val;
      } catch {
        // getter threw — omit the field rather than propagating
      }
    }

    // Recurse into .cause
    try {
      const nestedCause = serializeCause(node['cause'], depth + 1, visited);
      if (nestedCause !== undefined) out['cause'] = nestedCause;
    } catch {
      out['cause'] = '[SerializeError]';
    }

    // Recurse into AggregateError.errors[]
    try {
      if (Array.isArray(node['errors'])) {
        const serializedErrors: Array<Record<string, unknown> | string | undefined> = [];
        for (const item of node['errors'] as unknown[]) {
          try {
            serializedErrors.push(serializeCause(item, depth + 1, visited));
          } catch {
            serializedErrors.push('[SerializeError]');
          }
        }
        if (serializedErrors.length > 0) out['errors'] = serializedErrors;
      }
    } catch {
      out['errors'] = '[SerializeError]';
    }

    return out;
  } catch {
    // Outermost catch: exotic cause (null-proto, BigInt coercion, etc.) —
    // return a placeholder so toJSON() never throws.
    return '[SerializeError]';
  }
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
 *
 * toJSON() contract (v2.2+):
 * - `cause` is serialized via a cycle-safe, depth-bounded, fail-safe serializer
 *   and emitted when defined. undefined cause is omitted.
 * - `body` (already capped at construction via maxBodySize) is emitted when defined.
 * - `meta` is emitted when defined.
 * - Headers are still redacted via the built-in denylist + any custom `redactHeaders`.
 * - The message is still capped at DEFAULT_MAX_MESSAGE_SIZE (SEC-001).
 * The consumer who receives toJSON() output owns any additional redaction
 * appropriate for their log sink / wire surface.
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
      // fix(security): SEC-001 — pass the raw body to extractMessageFromBody but
      // cap the resulting string to DEFAULT_MAX_MESSAGE_SIZE before it becomes
      // this.message (which toJSON() includes). capBody/this.body is assigned
      // AFTER super(), so we cannot rely on it here; cap independently.
      const extracted = extractMessageFromBody(init.body, init.contentType);
      if (extracted) return truncateMessage(extracted);
      if (init.statusText) return truncateMessage(init.statusText);
      return `HTTP ${init.statusCode}`;
    }

    if (init.kind === 'network') {
      const code = resolveNetworkCode(init.cause, init.code);
      if (code === 'ABORT_ERR') return 'Request was aborted';
      if (code) return `Network error: ${code}`;
      return 'Network error';
    }

    // kind === 'setup' — message is developer-controlled but cap for consistency
    // in case a very long diagnostic string is passed inadvertently.
    return truncateMessage(init.message);
  }

  /**
   * Return a log/wire-safe JSON representation.
   *
   * Included: message (capped at DEFAULT_MAX_MESSAGE_SIZE), kind, statusCode,
   *           classification, isRetryable, method,
   *           url (with query redacted per redactQueryParams),
   *           code, attempts, requestId, attemptId,
   *           headers (values redacted per denylist + redactHeaders),
   *           body (capped at maxBodySize, omitted when undefined),
   *           meta (omitted when undefined),
   *           cause (serialized via cycle-safe depth-bounded serializer,
   *                  omitted when undefined).
   *
   * Security controls preserved:
   * - Header values in the denylist (authorization, cookie, x-api-key, etc.)
   *   and any custom `redactHeaders` are replaced with '[REDACTED]'.
   * - Query parameter values named in `redactQueryParams` are replaced with
   *   '[REDACTED]' in the url field; parse failures hide the full query.
   * - The message field is capped at DEFAULT_MAX_MESSAGE_SIZE (SEC-001) so
   *   a large body cannot leak via the message field.
   *
   * The consumer owns any further redaction appropriate for their log sink
   * or wire surface (e.g. body fields, cause message content).
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

    // New in v2.2: emit body, meta, and serialized cause when defined.
    // body is already capped at construction via capBody(maxBodySize).
    if (this.body !== undefined) out['body'] = this.body;
    if (this.meta !== undefined) out['meta'] = this.meta;

    // serializeCause returns undefined for null/undefined/non-object causes,
    // so this safely omits the key when cause is not set (e.g. #37 case).
    const sc = serializeCause(this.cause, 0, new Set());
    if (sc !== undefined) out['cause'] = sc;

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
