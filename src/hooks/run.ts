/**
 * Hook runners for the Phase 5 hook system.
 *
 * Semantics:
 * - Mutating hooks (onRequest, onResponse): throw → ResilientHttpError { kind:'setup' }.
 * - Observer hooks (onRetry, onFailure):    throw → captured/logged, never propagated.
 *
 * Each hook type accepts a single function or an ordered array; both cases
 * are handled uniformly here so call sites stay simple.
 *
 * This module is INTERNAL — not exported from src/index.ts.
 */

import type {
  HookContext,
  RequestHook,
  ResponseHook,
  RetryObserver,
  FailureObserver,
  Logger,
} from '../types';
import { ResilientHttpError } from '../errors/resilient-http-error';

// ---------------------------------------------------------------------------
// Normalise single-or-array hook input to an ordered array
// ---------------------------------------------------------------------------

function toArray<T>(hook: T | T[] | undefined): T[] {
  if (hook === undefined) return [];
  return Array.isArray(hook) ? hook : [hook];
}

// ---------------------------------------------------------------------------
// Mutating hooks — throw stops the operation
// ---------------------------------------------------------------------------

/**
 * Run all `onRequest` hooks in order.
 * Each hook may mutate `ctx.request` (url, method, headers, body).
 * If any hook throws, the caller receives a `ResilientHttpError { kind:'setup' }`.
 *
 * @throws ResilientHttpError with kind:'setup' if any hook throws.
 */
export async function runRequestHooks(
  hooks: RequestHook | RequestHook[] | undefined,
  ctx: HookContext
): Promise<void> {
  for (const hook of toArray(hooks)) {
    try {
      await hook(ctx);
    } catch (cause) {
      throw new ResilientHttpError({
        kind: 'setup',
        message: `onRequest hook threw: ${cause instanceof Error ? cause.message : String(cause)}`,
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
}

/**
 * Run all `onResponse` hooks in order.
 * If any hook throws, the caller receives a `ResilientHttpError { kind:'setup' }`.
 *
 * @throws ResilientHttpError with kind:'setup' if any hook throws.
 */
export async function runResponseHooks(
  hooks: ResponseHook | ResponseHook[] | undefined,
  ctx: HookContext
): Promise<void> {
  for (const hook of toArray(hooks)) {
    try {
      await hook(ctx);
    } catch (cause) {
      throw new ResilientHttpError({
        kind: 'setup',
        message: `onResponse hook threw: ${cause instanceof Error ? cause.message : String(cause)}`,
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
}

// ---------------------------------------------------------------------------
// Observer hooks — throw is captured/logged, never propagated
// ---------------------------------------------------------------------------

/**
 * Run all `onRetry` observers in order.
 * Uses the classic `(error, attempt, nextDelay)` signature for backward compat.
 * Any throw is caught and logged (if a logger is available) — never propagated.
 */
export async function runRetryObservers(
  hooks: RetryObserver | RetryObserver[] | undefined,
  error: unknown,
  attempt: number,
  nextDelay: number,
  logger?: Logger
): Promise<void> {
  for (const hook of toArray(hooks)) {
    try {
      await hook(error, attempt, nextDelay);
    } catch (observerError) {
      // Observers must never break the operation — log and continue.
      logger?.warn?.('onRetry observer threw; ignoring', {
        observerError: observerError instanceof Error ? observerError.message : String(observerError),
        attempt,
      });
    }
  }
}

/**
 * Run all `onFailure` observers in order.
 * Uses the classic `(error, attempts)` signature.
 * Any throw is caught and logged — never propagated.
 */
export async function runFailureObservers(
  hooks: FailureObserver | FailureObserver[] | undefined,
  error: unknown,
  attempts: number,
  logger?: Logger
): Promise<void> {
  for (const hook of toArray(hooks)) {
    try {
      await hook(error, attempts);
    } catch (observerError) {
      logger?.warn?.('onFailure observer threw; ignoring', {
        observerError: observerError instanceof Error ? observerError.message : String(observerError),
        attempts,
      });
    }
  }
}
