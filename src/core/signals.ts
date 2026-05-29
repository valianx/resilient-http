/**
 * Signal composition helpers for per-attempt timeout and deadline enforcement.
 *
 * Requires Node.js >= 22 (AbortSignal.any is available since Node 20, but the
 * project targets Node 22+). No fallback is provided — callers that need
 * browser compat must polyfill AbortSignal.any before using this module.
 */

/**
 * Parameters for building a composite signal for a single retry attempt.
 */
export interface AttemptSignalOptions {
  /** Caller-supplied abort signal (optional). */
  callerSignal?: AbortSignal;
  /** Per-attempt timeout in milliseconds (optional). */
  timeout?: number;
  /** Absolute deadline as a Unix timestamp in milliseconds (optional). */
  deadlineAt?: number;
}

/**
 * Result of building a composite signal.
 * Call `cleanup()` in a `finally` block to release internal resources.
 */
export interface AttemptSignalResult {
  /** The composite signal to pass to the HTTP function. */
  signal: AbortSignal;
  /**
   * Effective timeout applied to this attempt in milliseconds.
   * Equals `min(timeout, remainingDeadline)` when both are present.
   * Undefined when neither `timeout` nor `deadlineAt` was provided.
   */
  effectiveTimeout: number | undefined;
  /** Release internal timer/listener resources. Always call in `finally`. */
  cleanup: () => void;
}

/**
 * Build a composite AbortSignal for a single retry attempt.
 *
 * The composite signal aborts when ANY of the following fires first:
 *   1. The caller's signal aborts.
 *   2. The per-attempt timeout expires (min of `timeout` and remaining deadline).
 *   3. The deadline elapses.
 *
 * When neither `timeout` nor `deadlineAt` is provided the composite signal
 * is the caller signal alone (or a never-aborting signal if no caller signal).
 */
export function buildAttemptSignal(
  options: AttemptSignalOptions
): AttemptSignalResult {
  const { callerSignal, timeout, deadlineAt } = options;

  const now = Date.now();
  const remainingDeadline =
    deadlineAt !== undefined ? Math.max(0, deadlineAt - now) : undefined;

  // Effective timeout = min(timeout, remainingDeadline), ignoring undefined sides.
  let effectiveTimeout: number | undefined;
  if (timeout !== undefined && remainingDeadline !== undefined) {
    effectiveTimeout = Math.min(timeout, remainingDeadline);
  } else if (timeout !== undefined) {
    effectiveTimeout = timeout;
  } else if (remainingDeadline !== undefined) {
    effectiveTimeout = remainingDeadline;
  }

  // Collect signals to compose.
  const signals: AbortSignal[] = [];

  if (callerSignal) {
    signals.push(callerSignal);
  }

  // AbortSignal.timeout() registers a self-cleaning timer; no manual cleanup.
  let timeoutSignal: AbortSignal | undefined;
  if (effectiveTimeout !== undefined) {
    timeoutSignal = AbortSignal.timeout(effectiveTimeout);
    signals.push(timeoutSignal);
  }

  if (signals.length === 0) {
    // No constraints — return a signal that never aborts.
    const controller = new AbortController();
    return {
      signal: controller.signal,
      effectiveTimeout: undefined,
      cleanup: () => { /* nothing to release */ },
    };
  }

  if (signals.length === 1) {
    return {
      signal: signals[0],
      effectiveTimeout,
      cleanup: () => { /* AbortSignal.timeout cleans itself */ },
    };
  }

  const composite = AbortSignal.any(signals);
  return {
    signal: composite,
    effectiveTimeout,
    // AbortSignal.timeout() manages its own timer; no extra cleanup needed.
    cleanup: () => { /* composite and timeout signal self-manage */ },
  };
}

/**
 * Determine whether an error represents a signal-driven abort (caller signal
 * fired) rather than an internal timeout. Used by the engine to distinguish
 * "caller cancelled" (not retryable) from "attempt timed out" (retryable).
 */
export function isCallerAbort(
  error: unknown,
  callerSignal?: AbortSignal
): boolean {
  if (!callerSignal?.aborted) return false;

  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  // AbortSignal.timeout() throws a TimeoutError, not AbortError — so an
  // AbortError here when the caller is aborted is attributable to the caller.
  return false;
}
