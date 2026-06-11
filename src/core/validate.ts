/**
 * Deadline validation guard for resilient-http.
 *
 * Enforces that any `deadline` value supplied by the caller is an absolute
 * Unix-millisecond timestamp (Date.now()-compatible), not a relative duration.
 *
 * A value below EPOCH_FLOOR (≈ 2001-09-09) is implausibly small to be a real
 * epoch timestamp — it almost certainly indicates a caller who wrote
 * `deadline: 8000` intending a relative "8 seconds from now" duration.
 * The guard throws early with a descriptive message so the bug is surfaced at
 * configuration time, not silently at request time.
 */

import { ResilientHttpError } from '../errors/resilient-http-error';

/**
 * Minimum value a `deadline` must have to be treated as an absolute epoch
 * timestamp. 1e12 ms ≈ 2001-09-09. Any real absolute deadline clears this
 * threshold; any plausible relative duration (≤ ~1e8 ms = ~27 h) is well below it.
 */
export const EPOCH_FLOOR = 1e12;

/**
 * Assert that `deadline`, when present, is an absolute epoch timestamp.
 *
 * Throws `ResilientHttpError{kind:'setup'}` when `deadline < EPOCH_FLOOR`,
 * with a message that names the offending value and suggests the absolute form.
 *
 * @param deadline - The deadline value to validate (may be `undefined`).
 */
export function assertAbsoluteDeadline(deadline: number | undefined): void {
  if (deadline === undefined) return;

  if (deadline < EPOCH_FLOOR) {
    throw new ResilientHttpError({
      kind: 'setup',
      message:
        `deadline ${deadline} looks like a relative duration; ` +
        `deadline is an absolute Date.now()-based timestamp — ` +
        `did you mean Date.now() + ${deadline}?`,
    });
  }
}
