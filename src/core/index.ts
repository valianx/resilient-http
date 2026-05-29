export type { BackoffConfig } from './backoff';
export {
  DEFAULT_BACKOFF_CONFIG,
  exponentialBackoff,
  linearBackoff,
  constantBackoff,
  calculateBackoff,
} from './backoff';

export type { JitterConfig } from './jitter';
export {
  DEFAULT_JITTER_CONFIG,
  fullJitter,
  equalJitter,
  decorrelatedJitter,
  noJitter,
  applyJitter,
  calculateDelayWithJitter,
} from './jitter';

// Internal classification helpers (not re-exported from src/index.ts)
export {
  RETRYABLE_NETWORK_CODES,
  RETRYABLE_STATUS_CODES,
  classifyError,
  isRetryableError,
} from './classify';

// Internal signal composition helpers (not re-exported from src/index.ts)
export type { AttemptSignalOptions, AttemptSignalResult } from './signals';
export { buildAttemptSignal, isCallerAbort } from './signals';
