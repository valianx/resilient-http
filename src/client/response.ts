/**
 * Response body parsing for resilient-http v2 (Phase 6).
 *
 * Handles the responseType routing ('auto', 'json', 'text', 'arrayBuffer',
 * 'blob', 'stream', 'none') plus the mandatory escape conditions that produce
 * data=null without attempting a read:
 *   - Status 204, 205, 304
 *   - Content-Length: 0
 *   - HTTP method HEAD
 *   - responseType 'none'
 *   - responseType 'stream' → returns body as ReadableStream without buffering
 *
 * Blindaje (§ D): every body read is wrapped in try/catch. A failed read
 * yields data=null (or raw text on JSON parse error), never a secondary throw.
 *
 * This module is INTERNAL — not exported from src/index.ts.
 */

import type { ResponseType, ResilientResponse } from '../types';

// ============================================================================
// Status codes that mandate data=null (skip body read entirely)
// ============================================================================

const NO_BODY_STATUSES = new Set([204, 205, 304]);

// ============================================================================
// Content-Type helpers — plain string methods only (ReDoS-safe, no regex)
// ============================================================================

function isJsonContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return (
    lower.includes('application/json') ||
    lower.endsWith('+json') ||
    lower.includes('application/problem+json')
  );
}

function isTextContentType(ct: string): boolean {
  return ct.toLowerCase().startsWith('text/');
}

// ============================================================================
// Headers → plain object (for ResilientResponse.headers)
// ============================================================================

export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

// ============================================================================
// Body read — each path is individually shielded
// ============================================================================

/**
 * Check whether we must skip body parsing and return data=null.
 *
 * Conditions:
 * - responseType 'none' or 'stream'
 * - status in NO_BODY_STATUSES (204/205/304)
 * - method HEAD
 * - Content-Length header is explicitly '0'
 */
function mustSkipBody(
  status: number,
  method: string,
  responseType: ResponseType,
  contentLength: string | null
): boolean {
  if (responseType === 'none') return true;
  if (responseType === 'stream') return false; // handled separately
  if (NO_BODY_STATUSES.has(status)) return true;
  if (method.toUpperCase() === 'HEAD') return true;
  if (contentLength === '0') return true;
  return false;
}

/**
 * Parse the response body according to the resolved responseType.
 * Returns [data, rawTextForErrorMessage].
 *
 * Blindage: every read is in try/catch. On failure, data falls to null/rawText,
 * no secondary error is thrown.
 */
async function readBody(
  response: Response,
  responseType: NonNullable<ResponseType>
): Promise<unknown> {
  if (responseType === 'json') {
    try {
      return await response.json() as unknown;
    } catch {
      // JSON parse failed → fall back to raw text, but swallow the error
      try {
        return await response.text();
      } catch {
        return null;
      }
    }
  }

  if (responseType === 'text') {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }

  if (responseType === 'arrayBuffer') {
    try {
      return await response.arrayBuffer();
    } catch {
      return null;
    }
  }

  if (responseType === 'blob') {
    try {
      return await response.blob();
    } catch {
      return null;
    }
  }

  // 'auto': detect from Content-Type
  const ct = response.headers.get('content-type') ?? '';

  if (isJsonContentType(ct)) {
    try {
      return await response.json() as unknown;
    } catch {
      // JSON parse failed; try to get text for diagnostics but return as-is
      try {
        return await response.text();
      } catch {
        return null;
      }
    }
  }

  if (isTextContentType(ct)) {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }

  // Binary / unknown → ArrayBuffer
  try {
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}

// ============================================================================
// Public: parse a successful response into ResilientResponse<T>
// ============================================================================

/**
 * Parse a fetch Response into a ResilientResponse<T>.
 *
 * @param response   - The raw Fetch Response (2xx or validated as success).
 * @param method     - HTTP method of the request (for HEAD escape check).
 * @param attempts   - Total number of attempts made.
 * @param responseType - Resolved response type (after merging instance + request config).
 */
export async function parseResponse<T>(
  response: Response,
  method: string,
  attempts: number,
  responseType: ResponseType = 'auto'
): Promise<ResilientResponse<T>> {
  const headers = headersToRecord(response.headers);
  const contentLength = response.headers.get('content-length');

  // 'stream' mode: return the ReadableStream without buffering.
  if (responseType === 'stream') {
    return {
      data: response.body as unknown as T | null,
      status: response.status,
      headers,
      url: response.url,
      attempts,
      raw: response,
    };
  }

  const shouldSkip = mustSkipBody(response.status, method, responseType, contentLength);

  const data = shouldSkip ? null : (await readBody(response, responseType)) as T | null;

  return {
    data,
    status: response.status,
    headers,
    url: response.url,
    attempts,
    raw: response,
  };
}

// ============================================================================
// Error body extraction — best-effort raw text for error message
// ============================================================================

/**
 * Attempt to read a failure response body as text for use in error messages.
 * If the read fails for any reason, returns null — never throws.
 */
export async function readErrorBody(response: Response): Promise<unknown> {
  try {
    // Clone to allow the caller to still read the original if needed.
    const cloned = response.clone();
    const ct = cloned.headers.get('content-type') ?? '';
    if (isJsonContentType(ct)) {
      try {
        return await cloned.json() as unknown;
      } catch {
        // fall through to text
      }
    }
    return await cloned.text();
  } catch {
    return null;
  }
}
