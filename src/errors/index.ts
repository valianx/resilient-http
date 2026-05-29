// Error classification primitives — re-exported from core for the public ./errors sub-path.
// extractMessageFromBody is intentionally NOT re-exported here; it is internal to src/.
export {
  RETRYABLE_NETWORK_CODES,
  RETRYABLE_STATUS_CODES,
  classifyError,
  isRetryableError,
} from '../core/classify';
