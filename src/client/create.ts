/**
 * createResilientHttp — Phase 6 integration layer.
 *
 * Wires together:
 *   - RequestBuilder (Phase 5): idempotency key, body replay, onRequest hooks
 *   - executeWithRetry / executeWithRetryAndSignal (Phase 2): retry engine
 *   - parseResponse / readErrorBody (Phase 6): body parsing + blindage
 *   - ResilientHttpError (Phase 4): canonical error class
 *   - runResponseHooks, runRetryObservers, runFailureObservers (Phase 5)
 *
 * Design decisions:
 * - Shallow merge per category (headers, retry, hooks) — no deep-merge, no
 *   __proto__ / constructor / prototype copying.
 * - The public surface is ONLY this function + the types it references.
 *   No internal primitives are re-exported.
 * - fetch is injectable for testing; falls back to globalThis.fetch.
 * - AC-9 warning: maxAttempts > 1 without timeout/deadline emits a logger.warn.
 * - SEC-003: non-serialisable body after hook mutation → ResilientHttpError{kind:'setup'}.
 *   Fixed in RequestBuilder.#resolveBody — see request-builder.ts.
 *
 * This module is INTERNAL from the engine perspective — only src/index.ts
 * exposes `createResilientHttp` to library consumers.
 */

import type {
  ResilientHttpOptions,
  RequestConfig,
  ResilientResponse,
  ResilientHttpClient,
  RetryOptions,
  HookSet,
} from '../types';
import { ResilientHttpError } from '../errors/resilient-http-error';
import { RequestBuilder } from './request-builder';
import { parseResponse, readErrorBody, headersToRecord } from './response';
import { executeWithRetry, executeWithRetryAndSignal } from '../retry/engine';
import { runResponseHooks, runRetryObservers, runFailureObservers } from '../hooks/run';

// ============================================================================
// Defaults
// ============================================================================

function defaultValidateStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

// ============================================================================
// Config resolution helpers
// ============================================================================

/**
 * Build the final URL by joining baseURL + path + query params.
 * Preserves existing query params in the path if any.
 */
function buildUrl(
  path: string,
  baseURL: string | undefined,
  params: RequestConfig['params']
): string {
  let rawUrl = path;

  // Prepend baseURL only when path is not already absolute.
  if (baseURL && !isAbsoluteUrl(path)) {
    const base = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const p = path.startsWith('/') ? path : '/' + path;
    rawUrl = base + p;
  }

  if (!params) return rawUrl;

  // Append query params (non-null, non-undefined values only).
  const entries = Object.entries(params).filter(
    ([, v]) => v !== null && v !== undefined
  ) as Array<[string, string | number | boolean]>;

  if (entries.length === 0) return rawUrl;

  const qs = new URLSearchParams(
    entries.map(([k, v]) => [k, String(v)] as [string, string])
  );

  return rawUrl.includes('?')
    ? rawUrl + '&' + qs.toString()
    : rawUrl + '?' + qs.toString();
}

function isAbsoluteUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//');
}

/**
 * Merge instance-level and per-request headers (shallow, per-request wins).
 * Safe: never copies __proto__, constructor, or prototype keys.
 */
function mergeHeaders(
  instanceHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string> | undefined
): Record<string, string> {
  const merged: Record<string, string> = {};
  const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

  if (instanceHeaders) {
    for (const [k, v] of Object.entries(instanceHeaders)) {
      if (!FORBIDDEN.has(k)) merged[k] = v;
    }
  }
  if (requestHeaders) {
    for (const [k, v] of Object.entries(requestHeaders)) {
      if (!FORBIDDEN.has(k)) merged[k] = v;
    }
  }
  return merged;
}

/**
 * Merge two HookSets: arrays are concatenated (instance first, request second).
 * Returns a new HookSet; never mutates either input.
 */
function mergeHooks(
  instance: HookSet | undefined,
  request: HookSet | undefined
): HookSet {
  if (!instance && !request) return {};
  if (!instance) return request ?? {};
  if (!request) return instance;

  const toArray = <T>(h: T | T[] | undefined): T[] => {
    if (!h) return [];
    return Array.isArray(h) ? h : [h];
  };

  return {
    onRequest: [
      ...toArray(instance.onRequest),
      ...toArray(request.onRequest),
    ],
    onResponse: [
      ...toArray(instance.onResponse),
      ...toArray(request.onResponse),
    ],
    onRetry: [
      ...toArray(instance.onRetry),
      ...toArray(request.onRetry),
    ],
    onFailure: [
      ...toArray(instance.onFailure),
      ...toArray(request.onFailure),
    ],
  };
}

/**
 * Resolve the effective retry options (instance defaults + per-request overrides).
 * Shallow merge — per-request keys win, undefined keys fall back to instance.
 */
function mergeRetryOptions(
  instance: RetryOptions | undefined,
  request: RetryOptions | undefined
): RetryOptions {
  if (!instance && !request) return {};
  if (!instance) return request ?? {};
  if (!request) return instance;

  // Shallow merge: every key of `request` overrides the instance value.
  return { ...instance, ...request };
}

// ============================================================================
// Warning: retry without deadline/timeout
// ============================================================================

/**
 * AC-9: emit a logger.warn when retry is active (maxAttempts > 1) but neither
 * timeout nor deadline is set — this is a risk of indefinite hang.
 * Does NOT change any defaults.
 */
function warnIfRetryWithoutBound(
  retry: RetryOptions,
  logger: ResilientHttpOptions['logger']
): void {
  if (!logger) return;

  const maxAttempts = retry.maxAttempts ?? 1;
  if (maxAttempts <= 1) return;

  const hasTimeout = retry.timeout !== undefined;
  const hasDeadline = retry.deadline !== undefined;

  if (!hasTimeout && !hasDeadline) {
    logger.warn(
      'resilient-http: retry activo sin timeout/deadline: posible cuelgue indefinido',
      { maxAttempts }
    );
  }
}

// ============================================================================
// Core per-request execution
// ============================================================================

interface ResolvedRequestConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  retry: RetryOptions;
  hooks: HookSet;
  responseType: NonNullable<ResilientHttpOptions['responseType']>;
  validateStatus: (status: number) => boolean;
  fetchImpl: typeof globalThis.fetch;
  logger: ResilientHttpOptions['logger'];
  redactHeaders: string[];
  redactQueryParams: string[];
  idempotencyKey: ResilientHttpOptions['idempotencyKey'];
  idempotencyHeader: string | undefined;
  signal: AbortSignal | undefined;
}

/**
 * Build the resolved config for a single request from instance + per-request overrides.
 */
function resolveRequestConfig(
  instanceOptions: ResilientHttpOptions,
  reqUrl: string,
  reqMethod: string,
  reqConfig: RequestConfig | undefined
): ResolvedRequestConfig {
  const cfg = reqConfig ?? {};

  const url = buildUrl(reqUrl, instanceOptions.baseURL, cfg.params);
  const method = (cfg.method ?? reqMethod).toUpperCase();

  const headers = mergeHeaders(instanceOptions.headers, cfg.headers);

  // `json` shorthand takes precedence over `body`; sets content-type automatically.
  const body = cfg.json !== undefined ? cfg.json : cfg.body;

  // Retry: per-request overrides instance-level.
  const retry = mergeRetryOptions(instanceOptions.retry, cfg.retry);

  // Hooks: concatenated, instance first.
  const hooks = mergeHooks(instanceOptions.hooks, cfg.hooks);

  const responseType = cfg.responseType ?? instanceOptions.responseType ?? 'auto';
  const validateStatus = cfg.validateStatus ?? instanceOptions.validateStatus ?? defaultValidateStatus;
  const fetchImpl = instanceOptions.fetch ?? globalThis.fetch;

  return {
    url,
    method,
    headers,
    body,
    retry,
    hooks,
    responseType,
    validateStatus,
    fetchImpl,
    logger: instanceOptions.logger,
    redactHeaders: instanceOptions.redactHeaders ?? [],
    redactQueryParams: instanceOptions.redactQueryParams ?? [],
    idempotencyKey: cfg.idempotencyKey ?? instanceOptions.idempotencyKey,
    idempotencyHeader: instanceOptions.idempotencyHeader,
    signal: cfg.signal,
  };
}

/**
 * Execute one logical HTTP operation (with retry/hooks/error wrapping).
 *
 * Flow per attempt:
 *   1. builder.buildAttempt → runs onRequest hooks → builds native Headers + body
 *   2. fetch(url, { method, headers, body, signal })
 *   3. runResponseHooks (before validateStatus)
 *   4. validateStatus → true: parseResponse → ResilientResponse
 *                      → false: readErrorBody → throw ResilientHttpError{kind:'response'}
 *   5. On fetch rejection → throw ResilientHttpError{kind:'network'}
 *   6. On setup error → rethrow (already ResilientHttpError{kind:'setup'})
 */
async function executeRequest<T>(
  resolved: ResolvedRequestConfig
): Promise<ResilientResponse<T>> {
  const {
    url,
    method,
    headers,
    body,
    retry,
    hooks,
    responseType,
    validateStatus,
    fetchImpl,
    logger,
    redactHeaders,
    redactQueryParams,
    idempotencyKey,
    idempotencyHeader,
    signal: callerSignal,
  } = resolved;

  const retryActive = (retry.maxAttempts ?? 1) > 1;

  // AC-9: warn when retry is active but no timeout/deadline is set.
  warnIfRetryWithoutBound(retry, logger);

  // Build the RequestBuilder once per logical operation.
  const builder = RequestBuilder.create({
    url,
    method,
    headers,
    body,
    hooks,
    retryActive,
    logger,
    idempotencyKey,
    idempotencyHeader,
  });

  let lastAttemptCount = 0;

  // Wrap in onRetry/onFailure observers from the hook set (the engine calls
  // onRetry/onFailure via options callbacks, but we also expose them via hooks).
  const retryOptions: typeof retry = {
    ...retry,
    onRetry: async (error: unknown, attempt: number, delay: number) => {
      // Call the legacy onRetry callback if configured.
      retry.onRetry?.(error, attempt, delay);
      // Run hook observers (never throws — captured internally).
      await runRetryObservers(hooks.onRetry, error, attempt, delay, logger);
    },
    onFailure: async (error: unknown, attempts: number) => {
      retry.onFailure?.(error, attempts);
      await runFailureObservers(hooks.onFailure, error, attempts, logger);
    },
  };

  // The per-attempt function passed to the engine.
  const attemptFn = async (ctx: { signal: AbortSignal; attempt: number }) => {
    lastAttemptCount = ctx.attempt;

    // Build the request for this attempt (runs onRequest hooks).
    const { ctx: hookCtx, headers: nativeHeaders, body: finalBody } = await builder.buildAttempt(
      ctx.attempt
    );

    let response: Response;
    try {
      response = await fetchImpl(hookCtx.request.url, {
        method: hookCtx.request.method,
        headers: nativeHeaders,
        body: finalBody as RequestInit['body'],
        signal: ctx.signal,
      });
    } catch (fetchError) {
      // fetch itself rejected — network/abort error.
      throw wrapNetworkError(fetchError, hookCtx.request.url, hookCtx.request.method, ctx.attempt, builder.meta, redactHeaders, redactQueryParams);
    }

    // Update hookCtx with the response for onResponse.
    hookCtx.response = response;

    // Run onResponse hooks (mutating; throw → setup error).
    await runResponseHooks(hooks.onResponse, hookCtx);

    if (validateStatus(response.status)) {
      // Happy path: parse and return the response.
      const parsed = await parseResponse<T>(response, method, ctx.attempt, responseType);
      return parsed;
    }

    // Failure path: read body for error message, then throw.
    const errorBody = await readErrorBody(response);
    const responseHeaders = headersToRecord(response.headers);

    throw new ResilientHttpError({
      kind: 'response',
      statusCode: response.status,
      statusText: response.statusText,
      body: errorBody,
      contentType: response.headers.get('content-type') ?? undefined,
      method: hookCtx.request.method,
      url: hookCtx.request.url,
      headers: responseHeaders,
      attempts: ctx.attempt,
      requestId: hookCtx.requestId,
      attemptId: hookCtx.attemptId,
      meta: builder.meta,
      redactHeaders,
      redactQueryParams,
    });
  };

  try {
    if (callerSignal) {
      return await executeWithRetryAndSignal(attemptFn, callerSignal, retryOptions, method);
    }
    return await executeWithRetry(attemptFn, retryOptions, method);
  } catch (error) {
    // If already a ResilientHttpError, attach the attempt count and meta if missing.
    if (isResilientHttpError(error)) {
      // Already fully formed — rethrow as-is.
      throw error;
    }
    // Unexpected non-ResilientHttpError from the engine (should not happen
    // after the wrapNetworkError path, but belt-and-suspenders).
    throw wrapNetworkError(error, url, method, lastAttemptCount || 1, builder.meta, redactHeaders, redactQueryParams);
  }
}

// ============================================================================
// Import isResilientHttpError at module level to avoid circular issues
// ============================================================================

import { isResilientHttpError } from '../errors/resilient-http-error';

// ============================================================================
// Network error wrapper
// ============================================================================

function wrapNetworkError(
  cause: unknown,
  url: string,
  method: string,
  attempts: number,
  meta: Record<string, unknown>,
  redactHeaders: string[],
  redactQueryParams: string[]
): ResilientHttpError {
  // If it is already a ResilientHttpError (e.g. setup error from builder), rethrow it.
  if (isResilientHttpError(cause)) return cause;

  let code: string | undefined;
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    code = 'ABORT_ERR';
  } else if (cause instanceof DOMException && cause.name === 'TimeoutError') {
    code = 'TIMEOUT_ERR';
  } else if (cause && typeof cause === 'object') {
    const c = cause as Record<string, unknown>;
    if (typeof c['code'] === 'string') code = c['code'];
  }

  return new ResilientHttpError({
    kind: 'network',
    code,
    cause,
    url,
    method,
    attempts,
    meta,
    redactHeaders,
    redactQueryParams,
  });
}

// ============================================================================
// Public factory
// ============================================================================

/**
 * Create a resilient HTTP client instance.
 *
 * @param config - Instance-level options (baseURL, timeout, retry, hooks, …).
 * @returns A client object with `.get`, `.post`, `.put`, `.patch`, `.delete`,
 *          `.head`, `.options`, and `.request` methods.
 *
 * @example
 * ```typescript
 * const client = createResilientHttp({
 *   baseURL: 'https://api.example.com',
 *   timeout: 5000,
 *   retry: { maxAttempts: 3, backoff: 'exponential' },
 * });
 *
 * const { data } = await client.get<User>('/users/1');
 * ```
 */
export function createResilientHttp(config: ResilientHttpOptions = {}): ResilientHttpClient {
  function makeRequest<T>(
    method: string,
    url: string,
    reqConfig?: RequestConfig
  ): Promise<ResilientResponse<T>> {
    const resolved = resolveRequestConfig(config, url, method, reqConfig);
    return executeRequest<T>(resolved);
  }

  return {
    get<T = unknown>(url: string, reqConfig?: RequestConfig) {
      return makeRequest<T>('GET', url, reqConfig);
    },
    post<T = unknown>(url: string, reqConfig?: RequestConfig) {
      return makeRequest<T>('POST', url, reqConfig);
    },
    put<T = unknown>(url: string, reqConfig?: RequestConfig) {
      return makeRequest<T>('PUT', url, reqConfig);
    },
    patch<T = unknown>(url: string, reqConfig?: RequestConfig) {
      return makeRequest<T>('PATCH', url, reqConfig);
    },
    delete<T = unknown>(url: string, reqConfig?: RequestConfig) {
      return makeRequest<T>('DELETE', url, reqConfig);
    },
    head<T = unknown>(url: string, reqConfig?: RequestConfig) {
      return makeRequest<T>('HEAD', url, reqConfig);
    },
    options<T = unknown>(url: string, reqConfig?: RequestConfig) {
      return makeRequest<T>('OPTIONS', url, reqConfig);
    },
    request<T = unknown>(reqConfig: RequestConfig & { url: string; method: string }) {
      const { url, method, ...rest } = reqConfig;
      return makeRequest<T>(method, url, rest);
    },
  };
}
