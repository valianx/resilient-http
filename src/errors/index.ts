// Error classification primitives — internal re-export from core (no public sub-path).
// extractMessageFromBody is intentionally NOT re-exported here; it is internal to src/.
export {
  RETRYABLE_NETWORK_CODES,
  RETRYABLE_STATUS_CODES,
  classifyError,
  isRetryableError,
} from '../core/classify';

// ResilientHttpError — canonical error class (v2 public API)
export {
  RESILIENT_HTTP_ERROR_BRAND,
  ResilientHttpError,
  isResilientHttpError,
} from './resilient-http-error';
export type { ResilientHttpErrorInit } from './resilient-http-error';
