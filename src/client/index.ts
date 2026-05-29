/**
 * Internal barrel for the client module.
 * Only createResilientHttp is exposed from src/index.ts.
 * RequestBuilder, parseResponse, and readErrorBody are internal.
 */
export { createResilientHttp } from './create';
