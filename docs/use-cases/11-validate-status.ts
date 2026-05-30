/**
 * 11-validate-status.ts
 *
 * Tool: validateStatus — custom success predicate.
 *
 * Contract:
 *   - Default: (status) => status >= 200 && status < 300.
 *   - Return true  → treat response as success; data is parsed and returned.
 *   - Return false → throw ResilientHttpError { kind: 'response' }.
 *   - onResponse hooks run BEFORE validateStatus on every attempt.
 *   - Per-request validateStatus overrides the instance-level predicate.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';

// ---------------------------------------------------------------------------
// Inline fetch mock — returns a fixed status.
// ---------------------------------------------------------------------------

function fixedStatus(
  status: number,
  body = '{}'
): typeof globalThis.fetch {
  return async () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

// ---------------------------------------------------------------------------
// Example A: treat all responses as success (accept any status).
// ---------------------------------------------------------------------------

export async function example11a(): Promise<void> {
  const client = createResilientHttp({
    fetch: fixedStatus(404, '{"detail":"not found"}'),
    validateStatus: () => true,
  });

  // No error is thrown — the 404 is accepted as a valid response.
  const res = await client.get('https://api.example.com/missing');
  console.log(res.status); // 404
  console.log(res.data);   // { detail: 'not found' }
}

// ---------------------------------------------------------------------------
// Example B: per-request override — accept 201 in addition to 2xx.
// Useful when an endpoint returns 201 Created and you want it in `data`.
// (Default already accepts 201; this example tightens to [200, 201] only.)
// ---------------------------------------------------------------------------

export async function example11b(): Promise<void> {
  const client = createResilientHttp({
    fetch: fixedStatus(201, '{"id":"abc"}'),
  });

  const res = await client.post<{ id: string }>(
    'https://api.example.com/items',
    {
      json: { name: 'widget' },
      validateStatus: (s) => s === 200 || s === 201,
    }
  );

  console.log(res.status);    // 201
  console.log(res.data?.id);  // 'abc'
}

// ---------------------------------------------------------------------------
// Example C: tighten validation — only accept exactly 200.
// A 201 from the server becomes an error.
// ---------------------------------------------------------------------------

export async function example11c(): Promise<void> {
  const client = createResilientHttp({
    fetch: fixedStatus(201),
    validateStatus: (s) => s === 200,
  });

  try {
    await client.get('https://api.example.com/data');
  } catch (err) {
    if (isResilientHttpError(err)) {
      console.log(err.kind);       // 'response'
      console.log(err.statusCode); // 201
    }
  }
}

// ---------------------------------------------------------------------------
// Example D: 5xx treated as success — useful when the caller wants to inspect
// the error body without the library throwing (e.g. a proxy that records all
// responses regardless of status).
// ---------------------------------------------------------------------------

export async function example11d(): Promise<void> {
  const client = createResilientHttp({
    fetch: fixedStatus(500, '{"trace":"abcdef"}'),
    validateStatus: (s) => s < 600, // accept everything < 600
  });

  const res = await client.get('https://api.example.com/resource');
  console.log(res.status); // 500
  // data is populated because validateStatus returned true.
  console.log(res.data);   // { trace: 'abcdef' }
}
