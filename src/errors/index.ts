export {
  detectClientType,
  classifyError,
  isRetryableError,
  extractError,
  createErrorPredicate,
  defaultRetryPredicate,
  registerExtractor,
  unregisterExtractor,
  clearExtractors,
  getRegisteredExtractors,
} from './extractor';
