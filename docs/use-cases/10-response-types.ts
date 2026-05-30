/**
 * 10-response-types.ts
 *
 * Tool: ResponseType — body parsing modes.
 *
 * Modes:
 *   'auto'        — detect from Content-Type (default).
 *                   application/json → JSON.parse; text/* → text; other → ArrayBuffer.
 *   'json'        — force JSON parse regardless of Content-Type.
 *   'text'        — force text parse.
 *   'arrayBuffer' — force ArrayBuffer parse.
 *   'blob'        — force Blob parse.
 *   'stream'      — return the ReadableStream without buffering.
 *   'none'        — do not consume the body; data === null.
 *
 * Escape hatches (always data === null, regardless of responseType):
 *   - 204 No Content
 *   - 205 Reset Content
 *   - 304 Not Modified
 *   - HEAD requests
 *   - Content-Length: 0 responses
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch factory.
// ---------------------------------------------------------------------------

function makeFetch(
  body: string | null,
  status: number,
  headers: Record<string, string>
): typeof globalThis.fetch {
  return async () => new Response(body, { status, headers });
}

// ---------------------------------------------------------------------------
// Example A: 'auto' — JSON content type → data is parsed object.
// ---------------------------------------------------------------------------

export async function example10a(): Promise<void> {
  const client = createResilientHttp({
    fetch: makeFetch('{"value":42}', 200, { 'Content-Type': 'application/json' }),
  });

  const res = await client.get('https://api.example.com/data');
  console.log(res.data);            // { value: 42 }
  console.log(typeof res.data);     // 'object'
}

// ---------------------------------------------------------------------------
// Example B: 'text' — body returned as a raw string.
// ---------------------------------------------------------------------------

export async function example10b(): Promise<void> {
  const client = createResilientHttp({
    fetch: makeFetch('hello world', 200, { 'Content-Type': 'text/plain' }),
  });

  const res = await client.get<string>('https://api.example.com/text', {
    responseType: 'text',
  });
  console.log(res.data); // 'hello world'
}

// ---------------------------------------------------------------------------
// Example C: 'arrayBuffer' — raw bytes.
// ---------------------------------------------------------------------------

export async function example10c(): Promise<void> {
  const client = createResilientHttp({
    fetch: makeFetch('\x00\x01\x02', 200, { 'Content-Type': 'application/octet-stream' }),
  });

  const res = await client.get<ArrayBuffer>('https://api.example.com/binary', {
    responseType: 'arrayBuffer',
  });
  console.log(res.data instanceof ArrayBuffer); // true
}

// ---------------------------------------------------------------------------
// Example D: 'stream' — ReadableStream is returned without buffering.
// ---------------------------------------------------------------------------

export async function example10d(): Promise<void> {
  const client = createResilientHttp({
    fetch: makeFetch('line1\nline2\n', 200, { 'Content-Type': 'text/event-stream' }),
    // Streaming requires retry to be OFF (maxAttempts must be 1).
    retry: { maxAttempts: 1 },
  });

  const res = await client.get<ReadableStream>('https://api.example.com/events', {
    responseType: 'stream',
  });
  console.log(res.data instanceof ReadableStream); // true
  // Caller is responsible for consuming and closing the stream.
  await res.data?.cancel();
}

// ---------------------------------------------------------------------------
// Example E: 'none' — body is not read; data is null.
// ---------------------------------------------------------------------------

export async function example10e(): Promise<void> {
  const client = createResilientHttp({
    fetch: makeFetch('irrelevant', 200, { 'Content-Type': 'application/json' }),
  });

  const res = await client.get('https://api.example.com/ping', {
    responseType: 'none',
  });
  console.log(res.data);  // null
}

// ---------------------------------------------------------------------------
// Example F: 204 No Content — data is always null regardless of responseType.
// ---------------------------------------------------------------------------

export async function example10f(): Promise<void> {
  const client = createResilientHttp({
    fetch: makeFetch(null, 204, {}),
  });

  const res = await client.delete('https://api.example.com/items/1');
  console.log(res.data);   // null
  console.log(res.status); // 204
}

// ---------------------------------------------------------------------------
// Example G: HEAD — data is always null (no body by spec).
// ---------------------------------------------------------------------------

export async function example10g(): Promise<void> {
  const client = createResilientHttp({
    fetch: makeFetch(null, 200, { 'Content-Length': '1234' }),
  });

  const res = await client.head('https://api.example.com/resource');
  console.log(res.data);                          // null
  console.log(res.headers['content-length']);     // '1234'
}
