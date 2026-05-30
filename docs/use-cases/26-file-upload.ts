/**
 * 26-file-upload.ts
 *
 * Tool: createResilientHttp with a binary body.
 * Recipe: upload a file (Uint8Array / Blob) with optional retry.
 *
 * Contract:
 *   - Strings and Uint8Arrays are buffered once and replayed safely across retries.
 *   - Blobs are converted to ArrayBuffer once and replayed as Uint8Array.
 *   - ReadableStream bodies are NOT replayable — the engine throws a setup error
 *     if retry is active and the body is a stream. Use a Uint8Array instead.
 *   - For multipart uploads, build the FormData before calling the client and
 *     convert to Uint8Array if retry is needed (multipart boundary must be stable).
 *
 * IMPORTANT: for large files, loading the entire content into a Uint8Array before
 * uploading consumes significant memory. If memory is a concern, disable retry
 * (maxAttempts: 1) and stream the body instead.
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — captures the body bytes and returns 201.
// ---------------------------------------------------------------------------

function makeUploadFetch(): {
  fetch: typeof globalThis.fetch;
  receivedBytes: () => Uint8Array | null;
} {
  let received: Uint8Array | null = null;

  const fetch: typeof globalThis.fetch = async (_input, init) => {
    if (init?.body instanceof Uint8Array) {
      received = init.body;
    } else if (typeof init?.body === 'string') {
      received = new TextEncoder().encode(init.body);
    } else if (init?.body instanceof ArrayBuffer) {
      received = new Uint8Array(init.body);
    }
    return new Response(JSON.stringify({ uploaded: true }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { fetch, receivedBytes: () => received };
}

// ---------------------------------------------------------------------------
// Example A: upload a Uint8Array with retry.
// ---------------------------------------------------------------------------

export async function example26a(): Promise<void> {
  const { fetch, receivedBytes } = makeUploadFetch();

  const client = createResilientHttp({
    baseURL: 'https://uploads.example.com',
    fetch,
    retry: { maxAttempts: 3, initialDelay: 50, jitter: 'full' },
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  // Build the binary payload before uploading — safe to replay across retries.
  const fileBytes = new TextEncoder().encode('file content here');

  const { status } = await client.put('/files/my-doc.txt', { body: fileBytes });

  console.log(status);                  // 201
  console.log(receivedBytes()?.length); // 17 — byte count of 'file content here'
}

// ---------------------------------------------------------------------------
// Example B: upload a JSON metadata record together with the file reference.
// ---------------------------------------------------------------------------

export async function example26b(): Promise<void> {
  let callCount = 0;
  const fetch: typeof globalThis.fetch = async () => {
    callCount++;
    return new Response(JSON.stringify({ id: 'file-123' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = createResilientHttp({
    baseURL: 'https://uploads.example.com',
    fetch,
    retry: { maxAttempts: 2, initialDelay: 0 },
  });

  // JSON metadata upload — fully replayable across retries.
  const { data } = await client.post<{ id: string }>('/files', {
    json: {
      name:      'report.pdf',
      mimeType:  'application/pdf',
      sizeBytes: 102_400,
    },
  });

  console.log(data?.id);   // 'file-123'
  console.log(callCount);  // 1
}

// ---------------------------------------------------------------------------
// Example C: stream body — retry MUST be disabled; use maxAttempts: 1.
// ---------------------------------------------------------------------------

export async function example26c(): Promise<void> {
  let callCount = 0;
  const fetch: typeof globalThis.fetch = async () => {
    callCount++;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const client = createResilientHttp({
    baseURL: 'https://uploads.example.com',
    fetch,
    // maxAttempts: 1 (the default) — no retry when the body is a stream.
    // If you pass retry: { maxAttempts: 2 } with a ReadableStream body,
    // the engine throws a setup error: streams are not replayable.
  });

  // Build a ReadableStream from a byte array (illustrative — in real code this
  // would come from fs.createReadStream or a piped response).
  const bytes = new TextEncoder().encode('large file data');
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(bytes);
      ctrl.close();
    },
  });

  const { status } = await client.post('/stream-upload', { body: stream });

  console.log(status);    // 200
  console.log(callCount); // 1 — no retry, as expected for a stream body
}
