/**
 * Promise-based sleep function
 * Works in Node.js, Bun, and browsers
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep with abort signal support
 * Allows cancellation of sleep during shutdown or timeout
 */
export function sleepWithAbort(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Sleep aborted', 'AbortError'));
      return;
    }

    const timeoutId = setTimeout(() => {
      // fix(sleep): remove abort listener on normal completion to prevent
      // listener leak on long-lived reused signals (e.g. retry loops).
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeoutId);
      reject(new DOMException('Sleep aborted', 'AbortError'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
