/**
 * 25-streaming-download.ts
 *
 * Tool: responseType:'stream'.
 * Recipe: download a large response body as a ReadableStream without buffering.
 *
 * Contract:
 *   - responseType:'stream' returns the raw ReadableStream from the Fetch Response.
 *     The library does NOT buffer the body — you process it chunk by chunk.
 *   - Because the body is consumed as a stream, retry is NOT safe once reading
 *     has started. Keep retry only on the initial connection attempt (pre-body).
 *   - The response.data field is the ReadableStream<Uint8Array>.
 *   - Always cancel or drain the stream when you are done to free the connection.
 *
 * Memory note: reading all chunks into a single buffer defeats the purpose of
 * streaming. In production you would pipe chunks to a file, a hash, or a
 * downstream writable.
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — produces a synthetic multi-chunk ReadableStream.
// ---------------------------------------------------------------------------

function makeStreamFetch(chunks: string[]): typeof globalThis.fetch {
  return async () => {
    const encoder = new TextEncoder();
    let index = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index++]));
        } else {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type':   'application/octet-stream',
        'Content-Length': chunks.join('').length.toString(),
      },
    });
  };
}

// ---------------------------------------------------------------------------
// Helper: drain a ReadableStream into a Uint8Array without holding the full
// body in one allocation. Returns concatenated bytes (demo only — in real code
// you would write each chunk to disk or a hash function).
// ---------------------------------------------------------------------------

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Concatenate for verification only — omit in production streaming pipelines.
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Example A: stream a download and process it chunk by chunk.
// ---------------------------------------------------------------------------

export async function example25a(): Promise<void> {
  const testChunks = ['Hello, ', 'streaming ', 'world!'];

  const client = createResilientHttp({
    baseURL: 'https://files.example.com',
    fetch: makeStreamFetch(testChunks),
    // Retry on the connection attempt only (before body is consumed).
    retry: { maxAttempts: 3, initialDelay: 50 },
    responseType: 'stream',
  });

  const { data: stream } = await client.get<ReadableStream<Uint8Array>>('/large-file.bin');

  if (!stream) {
    console.log('no stream returned');
    return;
  }

  const bytes = await drainStream(stream);
  const text  = new TextDecoder().decode(bytes);

  console.log(text);        // 'Hello, streaming world!'
  console.log(bytes.length); // 22
}

// ---------------------------------------------------------------------------
// Example B: abort a streaming download mid-way.
// ---------------------------------------------------------------------------

export async function example25b(): Promise<void> {
  const controller = new AbortController();

  // Produce a stream that takes time between chunks.
  const slowFetch: typeof globalThis.fetch = async (_input, init) => {
    let chunk = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        await new Promise<void>((r) => setTimeout(r, 20));
        if (init?.signal?.aborted) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(new TextEncoder().encode(`chunk-${chunk++}`));
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };

  const client = createResilientHttp({
    baseURL: 'https://files.example.com',
    fetch: slowFetch,
    retry: { maxAttempts: 1 }, // no retry for streaming bodies
    responseType: 'stream',
  });

  const { data: stream } = await client.get<ReadableStream<Uint8Array>>('/huge-file', {
    signal: controller.signal,
  });

  if (!stream) return;

  const reader = stream.getReader();
  let chunksRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunksRead++;
      if (chunksRead === 2) {
        // Abort mid-download after reading 2 chunks.
        controller.abort();
        break;
      }
    }
  } finally {
    reader.releaseLock();
    // Cancel the stream to release the connection back to the pool.
    await stream.cancel().catch(() => { /* already closed */ });
  }

  console.log(chunksRead <= 2); // true — aborted early
}
