/**
 * RequestBuilder — constructs per-attempt Fetch Request objects with:
 *   - Idempotency-key that is evaluated ONCE and frozen across all retries.
 *   - Body buffering for replay across retries.
 *   - Hook execution (onRequest before each attempt).
 *   - CRLF-safe header attachment via the native Headers API.
 *
 * PAYMENT SAFETY: the idempotency-key provider function is called exactly once
 * per logical operation. If it returned a new UUID on every retry, a POST that
 * retries three times would carry three different keys → three separate charges.
 * Freezing the value at construction time prevents this.
 *
 * This module is INTERNAL — not exported from src/index.ts.
 */

import type {
  RequestBuilderOptions,
  HookContext,
  HookSet,
  IdempotencyKeyOption,
  Logger,
} from '../types';
import { ResilientHttpError } from '../errors/resilient-http-error';
import { runRequestHooks } from '../hooks/run';

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const DEFAULT_IDEMPOTENCY_HEADER = 'Idempotency-Key';

// ---------------------------------------------------------------------------
// ID generation — crypto.randomUUID if available, else Math.random fallback
// ---------------------------------------------------------------------------

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Body buffering — supports replay across retries
// ---------------------------------------------------------------------------

type BufferedBody = string | Uint8Array | null;

/**
 * Result of buffering the caller-supplied body.
 * `bufferForReplay` is the value used to reconstruct each attempt's Request.
 */
interface BodyBufferResult {
  bufferForReplay: BufferedBody;
  /** Content-Type to set when the body was JSON-serialised. */
  inferredContentType?: string;
}

/**
 * Buffers the body for replay across retries.
 *
 * Rules:
 * - null/undefined → no body
 * - string        → use as-is
 * - Uint8Array    → use as-is
 * - ReadableStream / Request → not replayable; throw setup error if retryActive
 * - plain object  → JSON.stringify + set Content-Type: application/json
 *
 * @throws ResilientHttpError { kind:'setup' } if body is a stream and retryActive is true.
 */
function bufferBody(
  body: unknown,
  retryActive: boolean,
  url: string,
  method: string
): BodyBufferResult {
  if (body === null || body === undefined) {
    return { bufferForReplay: null };
  }

  if (typeof body === 'string') {
    return { bufferForReplay: body };
  }

  if (body instanceof Uint8Array) {
    return { bufferForReplay: body };
  }

  // Streams and Request objects cannot be replayed after the first read.
  const isStream =
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) ||
    (typeof Request !== 'undefined' && body instanceof Request);

  if (isStream) {
    if (retryActive) {
      throw new ResilientHttpError({
        kind: 'setup',
        message:
          'Body is a ReadableStream or Request object and cannot be replayed across retries. ' +
          'Buffer the body before passing it to the resilient client, or disable retry.',
        url,
        method,
      });
    }
    // No retry: pass through as-is (will be used once).
    return { bufferForReplay: null }; // signal: use original body object directly
  }

  // Serialisable object → JSON-encode once and replay the string.
  try {
    const serialised = JSON.stringify(body);
    return {
      bufferForReplay: serialised,
      inferredContentType: 'application/json',
    };
  } catch (cause) {
    throw new ResilientHttpError({
      kind: 'setup',
      message: `Body cannot be JSON-serialised: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
      url,
      method,
    });
  }
}

// ---------------------------------------------------------------------------
// Idempotency-key resolution — evaluated ONCE
// ---------------------------------------------------------------------------

/**
 * Resolve the idempotency key value from the option.
 * - `true`       → generate a UUID
 * - `string`     → use directly
 * - `() => string` → call once and freeze the result
 *
 * @throws ResilientHttpError { kind:'setup' } if the provider function throws.
 */
function resolveIdempotencyKey(
  option: IdempotencyKeyOption,
  url: string,
  method: string
): string {
  if (option === true) {
    return generateId();
  }

  if (typeof option === 'string') {
    return option;
  }

  // Function provider — call exactly once.
  try {
    return option();
  } catch (cause) {
    throw new ResilientHttpError({
      kind: 'setup',
      message: `idempotencyKey provider threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
      url,
      method,
    });
  }
}

/**
 * Attach a header value to a Headers object using the native API (CRLF-safe).
 * The browser/Node Fetch Headers constructor rejects values containing \r or \n,
 * throwing a TypeError. We catch that and re-throw as a ResilientHttpError so
 * the caller gets a clear setup error instead of an unguarded runtime crash.
 *
 * SECURITY: never set headers via string concatenation — always use the API.
 *
 * @throws ResilientHttpError { kind:'setup' } if the runtime rejects the value.
 */
function safeSetHeader(
  headers: Headers,
  name: string,
  value: string,
  url: string,
  method: string
): void {
  try {
    headers.set(name, value);
  } catch (cause) {
    throw new ResilientHttpError({
      kind: 'setup',
      message:
        `Header "${name}" was rejected by the runtime (possible CRLF injection): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
      url,
      method,
    });
  }
}

// ---------------------------------------------------------------------------
// Per-attempt context builder
// ---------------------------------------------------------------------------

/**
 * Build a fresh HookContext for a given attempt from the stable operation state.
 */
function buildHookContext(
  requestId: string,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: BufferedBody | unknown,
  attempt: number,
  operationStart: number,
  meta: Record<string, unknown>,
  prevError?: unknown,
  prevResponse?: unknown
): HookContext {
  return {
    request: {
      url,
      method,
      headers: { ...headers },
      body: body === null ? undefined : body,
    },
    attempt,
    attemptId: generateId(),
    requestId,
    elapsed: Date.now() - operationStart,
    meta,
    error: prevError,
    response: prevResponse,
  };
}

// ---------------------------------------------------------------------------
// Public RequestBuilder class
// ---------------------------------------------------------------------------

/**
 * Manages per-attempt request construction for the resilient HTTP client.
 *
 * Usage:
 * ```
 * const builder = await RequestBuilder.create(options);
 * for each attempt:
 *   const { ctx, request } = await builder.buildAttempt(attempt, prevError, prevResponse);
 *   // → run fetch(request.url, request) or equivalent
 * ```
 */
export class RequestBuilder {
  readonly requestId: string;

  /** Frozen idempotency-key value (evaluated exactly once). */
  readonly #idempotencyKey: string | undefined;
  readonly #idempotencyHeader: string;

  /** Stable body buffer for replay. */
  readonly #bodyBuffer: BufferedBody;
  /**
   * When body was a non-replayable stream with retryActive=false,
   * the original value is preserved here for the single allowed attempt.
   */
  readonly #originalBodyForSingleUse: unknown;

  /** Stable request spec (mutated per-attempt via HookContext). */
  readonly #baseUrl: string;
  readonly #baseMethod: string;
  readonly #baseHeaders: Record<string, string>;

  /** Hook set to run per attempt. */
  readonly #hooks: HookSet;
  readonly #logger: Logger | undefined;

  readonly #operationStart: number;
  /** Persists across all attempts — attached to final ResilientHttpError. */
  readonly meta: Record<string, unknown>;

  private constructor(
    requestId: string,
    idempotencyKey: string | undefined,
    idempotencyHeader: string,
    bodyBuffer: BufferedBody,
    originalBodyForSingleUse: unknown,
    baseUrl: string,
    baseMethod: string,
    baseHeaders: Record<string, string>,
    hooks: HookSet,
    logger: Logger | undefined
  ) {
    this.requestId = requestId;
    this.#idempotencyKey = idempotencyKey;
    this.#idempotencyHeader = idempotencyHeader;
    this.#bodyBuffer = bodyBuffer;
    this.#originalBodyForSingleUse = originalBodyForSingleUse;
    this.#baseUrl = baseUrl;
    this.#baseMethod = baseMethod;
    this.#baseHeaders = baseHeaders;
    this.#hooks = hooks;
    this.#logger = logger;
    this.#operationStart = Date.now();
    this.meta = {};
  }

  /**
   * Create a RequestBuilder, resolving the idempotency key and buffering the body.
   * This is the ONLY place where the key provider function is called.
   *
   * @throws ResilientHttpError { kind:'setup' } if key resolution or body buffering fails.
   */
  static create(options: RequestBuilderOptions): RequestBuilder {
    const {
      url,
      method,
      headers = {},
      body,
      idempotencyKey,
      idempotencyHeader = DEFAULT_IDEMPOTENCY_HEADER,
      hooks = {},
      retryActive = false,
      logger,
    } = options;

    const upperMethod = method.toUpperCase();

    // Resolve idempotency key ONCE — frozen for all retries.
    let resolvedKey: string | undefined;
    if (idempotencyKey !== undefined) {
      resolvedKey = resolveIdempotencyKey(idempotencyKey, url, upperMethod);
    }

    // Buffer body for replay.
    const isStream =
      body !== null &&
      body !== undefined &&
      ((typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) ||
        (typeof Request !== 'undefined' && body instanceof Request));

    let bodyBufferResult: BodyBufferResult;
    let originalBodyForSingleUse: unknown = undefined;

    if (isStream && !retryActive) {
      // Single-use stream path — no buffering, passes through directly.
      bodyBufferResult = { bufferForReplay: null };
      originalBodyForSingleUse = body;
    } else {
      bodyBufferResult = bufferBody(body, retryActive, url, upperMethod);
    }

    // Merge inferred Content-Type into base headers (only if not already set).
    const mergedHeaders = { ...headers };
    if (
      bodyBufferResult.inferredContentType &&
      !mergedHeaders['content-type'] &&
      !mergedHeaders['Content-Type']
    ) {
      mergedHeaders['content-type'] = bodyBufferResult.inferredContentType;
    }

    return new RequestBuilder(
      generateId(),
      resolvedKey,
      idempotencyHeader,
      bodyBufferResult.bufferForReplay,
      originalBodyForSingleUse,
      url,
      upperMethod,
      mergedHeaders,
      hooks,
      logger
    );
  }

  /**
   * Build the HookContext and run onRequest hooks for a given attempt.
   *
   * Returns:
   * - `ctx`: the HookContext after hooks have run (may have mutated ctx.request)
   * - `headers`: final Headers object (CRLF-safe)
   * - `body`: final body to pass to fetch
   *
   * @throws ResilientHttpError { kind:'setup' } if any onRequest hook throws
   *         or if the idempotency-key header is rejected by the runtime.
   */
  async buildAttempt(
    attempt: number,
    prevError?: unknown,
    prevResponse?: unknown
  ): Promise<{
    ctx: HookContext;
    headers: Headers;
    body: BufferedBody | undefined;
  }> {
    // Build mutable context from stable base spec.
    const ctx = buildHookContext(
      this.requestId,
      this.#baseUrl,
      this.#baseMethod,
      this.#baseHeaders,
      this.#bodyBuffer ?? this.#originalBodyForSingleUse,
      attempt,
      this.#operationStart,
      this.meta,
      prevError,
      prevResponse
    );

    // Attach idempotency-key BEFORE onRequest so hooks can read (or override) it.
    if (this.#idempotencyKey !== undefined) {
      ctx.request.headers[this.#idempotencyHeader] = this.#idempotencyKey;
    }

    // Run onRequest hooks — may mutate ctx.request.
    await runRequestHooks(this.#hooks.onRequest, ctx);

    // Build the native Headers object after hooks have run (CRLF-safe).
    const nativeHeaders = new Headers();
    for (const [name, value] of Object.entries(ctx.request.headers)) {
      safeSetHeader(nativeHeaders, name, value, ctx.request.url, ctx.request.method);
    }

    // Determine final body: use hook-mutated ctx.request.body if changed,
    // otherwise use the stable buffer (or null).
    const finalBody = this.#resolveBody(ctx);

    return { ctx, headers: nativeHeaders, body: finalBody };
  }

  /**
   * Resolve the final body for this attempt.
   * If ctx.request.body was mutated by a hook, use that value.
   * Otherwise use the stable replay buffer.
   *
   * fix(SEC-003): if a hook set ctx.request.body to a non-serialisable value
   * (e.g. an object with circular references), JSON.stringify MUST throw a
   * ResilientHttpError{kind:'setup'} rather than silently returning null.
   * A silent null would send an empty body — in payment contexts, that is a
   * malformed charge request that downstream processors may still authorise.
   */
  #resolveBody(ctx: HookContext): BufferedBody | undefined {
    // If a hook set ctx.request.body to a defined value, use it as a string.
    if (ctx.request.body !== undefined && ctx.request.body !== this.#bodyBuffer) {
      if (typeof ctx.request.body === 'string') return ctx.request.body;
      if (ctx.request.body instanceof Uint8Array) return ctx.request.body;
      if (ctx.request.body === null) return null;
      // Hook set an object — serialise it.
      // fix(SEC-003): throw setup error on non-serialisable body; never return null silently.
      try {
        return JSON.stringify(ctx.request.body);
      } catch (cause) {
        throw new ResilientHttpError({
          kind: 'setup',
          message: `onRequest hook set ctx.request.body to a non-serialisable value: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
          url: ctx.request.url,
          method: ctx.request.method,
          attempts: ctx.attempt,
          requestId: ctx.requestId,
          attemptId: ctx.attemptId,
          meta: ctx.meta,
        });
      }
    }

    // Use stable replay buffer (null means no body).
    if (this.#bodyBuffer !== null) return this.#bodyBuffer;

    // Single-use stream path (no retry).
    if (this.#originalBodyForSingleUse !== undefined) {
      return this.#originalBodyForSingleUse as BufferedBody;
    }

    return null;
  }

  /**
   * Expose hooks for the engine integration layer to run onRetry/onFailure observers.
   */
  get hooks(): HookSet {
    return this.#hooks;
  }

  /**
   * Expose logger for the engine integration layer.
   */
  get logger(): Logger | undefined {
    return this.#logger;
  }
}
