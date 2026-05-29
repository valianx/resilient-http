// Internal retry engine — exported for use within src/ only.
// NOT re-exported from src/index.ts.
export type { AttemptContext } from './engine';
export { executeWithRetry, executeWithRetryAndSignal } from './engine';
