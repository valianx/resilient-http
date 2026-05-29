/**
 * Internal retry engine for resilient-http v2.
 *
 * This module is NOT exported from src/index.ts — it is an internal
 * implementation detail. External callers never see it directly.
 *
 * Design decisions:
 * - Uses core/classify.ts for error classification; never imports extractor.ts.
 * - Composite signal (caller + per-attempt timeout + deadline) is built per
 *   attempt via core/signals.ts.
 * - shouldRetry is a gate BELOW maxAttempts/deadline hard caps, not above them.
 * - If shouldRetry throws, the engine fails-closed: it stops retrying and
 *   re-throws the ORIGINAL operation error.
 * - POST (and other non-idempotent methods) are excluded from retry by default
 *   to prevent double-charge, even on timeout (no HTTP status available).
 * - Retry-After: if value > maxRetryAfter the engine gives up instead of waiting.
 */

import type { RetryOptions, RetryHookContext } from '../types';
import { calculateBackoff } from '../core/backoff';
import { applyJitter } from '../core/jitter';
import { classifyError, isRetryableError, RETRYABLE_STATUS_CODES } from '../core/classify';
import { buildAttemptSignal, isCallerAbort } from '../core/signals';
import { sleep, sleepWithAbort } from '../utils';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30000;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_BACKOFF: NonNullable<RetryOptions['backoff']> = 'exponential';
const DEFAULT_JITTER: NonNullable<RetryOptions['jitter']> = 'full';
const DEFAULT_RETRYABLE_STATUSES: ReadonlySet<number> = RETRYABLE_STATUS_CODES;
const DEFAULT_RETRYABLE_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'OPTIONS',
]);
const DEFAULT_RESPECT_RETRY_AFTER = true;
const DEFAULT_MAX_RETRY_AFTER = 60_000;

// ---------------------------------------------------------------------------
// Internal resolved config
// ---------------------------------------------------------------------------

interface ResolvedEngineConfig {
  maxAttempts: number;
  backoff: NonNullable<RetryOptions['backoff']>;
  initialDelay: number;
  maxDelay: number;
  multiplier: number;
  jitter: NonNullable<RetryOptions['jitter']>;
  retryableStatuses: ReadonlySet<number>;
  retryableMethods: ReadonlySet<string>;
  respectRetryAfter: boolean;
  maxRetryAfter: number;
  shouldRetry?: RetryOptions['shouldRetry'];
  timeout?: number;
  deadline?: number;
  onRetry?: RetryOptions['onRetry'];
  onFailure?: RetryOptions['onFailure'];
}

function resolveConfig(options: RetryOptions): ResolvedEngineConfig {
  return {
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoff: options.backoff ?? DEFAULT_BACKOFF,
    initialDelay: options.initialDelay ?? DEFAULT_INITIAL_DELAY,
    maxDelay: options.maxDelay ?? DEFAULT_MAX_DELAY,
    multiplier: options.multiplier ?? DEFAULT_MULTIPLIER,
    jitter: options.jitter ?? DEFAULT_JITTER,
    retryableStatuses: options.retryableStatuses
      ? new Set(options.retryableStatuses)
      : DEFAULT_RETRYABLE_STATUSES,
    retryableMethods: options.retryableMethods
      ? new Set(options.retryableMethods.map((m) => m.toUpperCase()))
      : DEFAULT_RETRYABLE_METHODS,
    respectRetryAfter: options.respectRetryAfter ?? DEFAULT_RESPECT_RETRY_AFTER,
    maxRetryAfter: options.maxRetryAfter ?? DEFAULT_MAX_RETRY_AFTER,
    shouldRetry: options.shouldRetry,
    timeout: options.timeout,
    deadline: options.deadline,
    onRetry: options.onRetry,
    onFailure: options.onFailure,
  };
}

// ---------------------------------------------------------------------------
// Error inspection helpers
// ---------------------------------------------------------------------------

interface ErrorMetadata {
  statusCode?: number;
  method?: string;
  retryAfterMs?: number;
  code?: string;
}

function extractMetadata(error: unknown): ErrorMetadata {
  if (!error || typeof error !== 'object') return {};

  const e = error as Record<string, unknown>;
  const response = e.response as Record<string, unknown> | undefined;

  let statusCode: number | undefined;
  let method: string | undefined;
  let retryAfterMs: number | undefined;
  let code = e.code as string | undefined;

  if (response) {
    statusCode = (response.status ?? response.statusCode) as number | undefined;
    const headers = response.headers as Record<string, string> | undefined;
    if (headers) {
      const ra = headers['retry-after'] ?? headers['Retry-After'];
      if (ra) {
        const seconds = Number(ra);
        if (Number.isFinite(seconds)) {
          // Delta-seconds format (RFC 9110 §10.2.4): clamp negatives to 0.
          retryAfterMs = Math.max(0, seconds * 1000);
        } else {
          // HTTP-date format (RFC 9110 §10.2.4): parse absolute date.
          // A hostile far-future date is capped by maxRetryAfter downstream.
          const when = Date.parse(ra);
          retryAfterMs = Number.isFinite(when)
            ? Math.max(0, when - Date.now())
            : undefined;
        }
      }
    }
  }

  // Axios config
  const config = e.config as Record<string, unknown> | undefined;
  if (config?.method) {
    method = (config.method as string).toUpperCase();
  }

  // code may be nested in cause (undici)
  if (!code && e.cause && typeof e.cause === 'object') {
    code = (e.cause as Record<string, unknown>).code as string | undefined;
  }

  // statusCode fallback for plain Error objects
  if (statusCode === undefined) {
    statusCode = (e.statusCode ?? e.status) as number | undefined;
  }

  return { statusCode, method, retryAfterMs, code };
}

/**
 * Classify a caught error into retryable or not, given engine config.
 */
function classifyAttemptError(
  error: unknown,
  meta: ErrorMetadata,
  config: ResolvedEngineConfig,
  method: string | undefined
): { isRetryable: boolean; classification: string } {
  // AbortError from a caller signal is never retryable.
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { isRetryable: false, classification: 'cancelled' };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { isRetryable: false, classification: 'cancelled' };
  }
  // TimeoutError from AbortSignal.timeout() — retryable only if method allows.
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    const effectiveMethod = method ?? meta.method;
    // fix(sec): fail-safe default — no method info means we cannot confirm
    // idempotency, so we do NOT retry to prevent double-charge on payments.
    const methodAllowed = effectiveMethod
      ? config.retryableMethods.has(effectiveMethod.toUpperCase())
      : false;
    return { isRetryable: methodAllowed, classification: 'timeout' };
  }

  const classification = classifyError(meta.statusCode, meta.code);

  // Gate 1: classification-level retryability.
  const classificationRetryable = isRetryableError(classification, meta.statusCode);

  // Gate 2: status code in the configured set (overrides classification for status-based errors).
  const statusRetryable =
    meta.statusCode !== undefined
      ? config.retryableStatuses.has(meta.statusCode)
      : classificationRetryable;

  // Gate 3: method must be in the retryable set when a status is present.
  // Network errors (no status) also require the method gate.
  const effectiveMethod = method ?? meta.method;
  // fix(sec): fail-safe default — no method info means we cannot confirm
  // idempotency, so we do NOT retry to prevent double-charge on payments.
  const methodAllowed = effectiveMethod
    ? config.retryableMethods.has(effectiveMethod.toUpperCase())
    : false;

  const retryable =
    (meta.statusCode !== undefined ? statusRetryable : classificationRetryable) &&
    methodAllowed;

  return { isRetryable: retryable, classification };
}

// ---------------------------------------------------------------------------
// Delay helpers
// ---------------------------------------------------------------------------

function calculateDelay(
  attempt: number,
  previousDelay: number,
  config: ResolvedEngineConfig
): number {
  const base = calculateBackoff(attempt, {
    initialDelay: config.initialDelay,
    maxDelay: config.maxDelay,
    multiplier: config.multiplier,
    strategy: config.backoff,
  });
  return applyJitter(base, config.jitter, {
    previousDelay,
    initialDelay: config.initialDelay,
    maxDelay: config.maxDelay,
  });
}

/**
 * Returns true when sleeping the given delay would push us past the deadline.
 */
function delayExceedsDeadline(
  delayMs: number,
  deadline: number | undefined
): boolean {
  if (deadline === undefined) return false;
  return Date.now() + delayMs >= deadline;
}

// ---------------------------------------------------------------------------
// shouldRetry guard — fail-closed on throw
// ---------------------------------------------------------------------------

async function evaluateShouldRetry(
  ctx: RetryHookContext,
  hook: RetryOptions['shouldRetry']
): Promise<boolean> {
  if (!hook) return ctx.gateAllows;
  try {
    return await hook(ctx);
  } catch {
    // Fail-closed: the hook threw, so we do not retry.
    // The caller will re-throw the ORIGINAL error.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public engine API
// ---------------------------------------------------------------------------

/**
 * Context passed to the `fn` on each attempt.
 */
export interface AttemptContext {
  /** Composite AbortSignal for this attempt. Pass to your HTTP client. */
  signal: AbortSignal;
  /** 1-based attempt number. */
  attempt: number;
}

/**
 * Execute `fn` with full retry, timeout, deadline, and signal semantics.
 *
 * `fn` receives an `AttemptContext` with a per-attempt composite signal.
 * The engine classifies errors using `core/classify.ts` only — never `errors/extractor.ts`.
 *
 * @param fn - The async operation to retry.
 * @param options - Retry configuration.
 * @param method - HTTP method of the request (upper-case, e.g. 'GET').
 *   Used for the method gate when the error has no embedded method.
 * @returns The result of a successful attempt.
 * @throws The last error when all attempts are exhausted or a hard cap fires.
 */
export async function executeWithRetry<T>(
  fn: (ctx: AttemptContext) => Promise<T>,
  options: RetryOptions = {},
  method?: string
): Promise<T> {
  const config = resolveConfig(options);

  let lastError: unknown;
  let previousDelay = config.initialDelay;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    // Hard cap: deadline check before starting the attempt.
    if (config.deadline !== undefined && Date.now() >= config.deadline) {
      break;
    }

    const { signal, cleanup } = buildAttemptSignal({
      timeout: config.timeout,
      deadlineAt: config.deadline,
    });

    try {
      const result = await fn({ signal, attempt });
      return result;
    } catch (error) {
      lastError = error;
      const meta = extractMetadata(error);
      const effectiveMethod = method ?? meta.method;

      const { isRetryable, classification } = classifyAttemptError(
        error,
        meta,
        config,
        effectiveMethod
      );

      const isLastAttempt = attempt >= config.maxAttempts;

      // Build hook context for shouldRetry.
      const ctx: RetryHookContext = {
        error,
        attempt,
        statusCode: meta.statusCode,
        method: effectiveMethod,
        gateAllows: isRetryable && !isLastAttempt,
      };

      // Evaluate shouldRetry (fail-closed on throw).
      const shouldContinue = !isLastAttempt && (await evaluateShouldRetry(ctx, config.shouldRetry));

      if (!isRetryable || !shouldContinue) {
        config.onFailure?.(error, attempt);
        break;
      }

      // Determine inter-attempt delay.
      let delay: number;

      // Retry-After header handling.
      if (
        config.respectRetryAfter &&
        meta.retryAfterMs !== undefined &&
        classification === 'rate-limit'
      ) {
        if (meta.retryAfterMs > config.maxRetryAfter) {
          // Retry-After exceeds cap — give up.
          config.onFailure?.(error, attempt);
          break;
        }
        delay = meta.retryAfterMs;
      } else {
        delay = calculateDelay(attempt - 1, previousDelay, config);
        previousDelay = delay;
      }

      // Hard cap: sleeping through the deadline is not allowed.
      if (delayExceedsDeadline(delay, config.deadline)) {
        config.onFailure?.(error, attempt);
        break;
      }

      config.onRetry?.(error, attempt, delay);

      await sleep(delay);
    } finally {
      cleanup();
    }
  }

  throw lastError;
}

/**
 * Execute `fn` with retry semantics and a caller-supplied AbortSignal.
 *
 * Identical to `executeWithRetry` but merges the caller's signal into every
 * per-attempt composite signal. If the caller aborts, the current attempt is
 * interrupted immediately and the engine stops retrying.
 */
export async function executeWithRetryAndSignal<T>(
  fn: (ctx: AttemptContext) => Promise<T>,
  callerSignal: AbortSignal,
  options: RetryOptions = {},
  method?: string
): Promise<T> {
  const config = resolveConfig(options);

  let lastError: unknown;
  let previousDelay = config.initialDelay;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    // Fast-path: caller already aborted.
    if (callerSignal.aborted) {
      throw new DOMException('Retry aborted by caller', 'AbortError');
    }

    // Hard cap: deadline check.
    if (config.deadline !== undefined && Date.now() >= config.deadline) {
      break;
    }

    const { signal, cleanup } = buildAttemptSignal({
      callerSignal,
      timeout: config.timeout,
      deadlineAt: config.deadline,
    });

    try {
      const result = await fn({ signal, attempt });
      return result;
    } catch (error) {
      lastError = error;

      // Caller abort takes priority — propagate immediately, no retry.
      if (isCallerAbort(error, callerSignal)) {
        throw error;
      }
      if (callerSignal.aborted) {
        throw new DOMException('Retry aborted by caller', 'AbortError');
      }

      const meta = extractMetadata(error);
      const effectiveMethod = method ?? meta.method;

      const { isRetryable, classification } = classifyAttemptError(
        error,
        meta,
        config,
        effectiveMethod
      );

      const isLastAttempt = attempt >= config.maxAttempts;

      const ctx: RetryHookContext = {
        error,
        attempt,
        statusCode: meta.statusCode,
        method: effectiveMethod,
        gateAllows: isRetryable && !isLastAttempt,
      };

      const shouldContinue = !isLastAttempt && (await evaluateShouldRetry(ctx, config.shouldRetry));

      if (!isRetryable || !shouldContinue) {
        config.onFailure?.(error, attempt);
        break;
      }

      let delay: number;

      if (
        config.respectRetryAfter &&
        meta.retryAfterMs !== undefined &&
        classification === 'rate-limit'
      ) {
        if (meta.retryAfterMs > config.maxRetryAfter) {
          config.onFailure?.(error, attempt);
          break;
        }
        delay = meta.retryAfterMs;
      } else {
        delay = calculateDelay(attempt - 1, previousDelay, config);
        previousDelay = delay;
      }

      if (delayExceedsDeadline(delay, config.deadline)) {
        config.onFailure?.(error, attempt);
        break;
      }

      config.onRetry?.(error, attempt, delay);

      // Sleep with abort support to react to caller cancellation during wait.
      try {
        await sleepWithAbort(delay, callerSignal);
      } catch {
        throw new DOMException('Retry aborted by caller', 'AbortError');
      }
    } finally {
      cleanup();
    }
  }

  throw lastError;
}
