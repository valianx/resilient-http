/**
 * dist-smoke.test.ts — smoke test over the compiled dist output.
 *
 * Purpose:
 *   1. Verify that ESM and CJS dist artefacts export the expected surface.
 *   2. Prove the global brand (Symbol.for('resilient-http.error')) survives the
 *      dual-package boundary: a ResilientHttpError constructed from the CJS copy
 *      is recognised by isResilientHttpError from the ESM copy, and vice-versa.
 *      This is the definitive test against the dual-package hazard.
 *
 * Pre-requisite: run `pnpm build` before this test suite. The test runner in CI
 * always runs build before test:node, so the dist files will be present.
 *
 * Running this test locally:
 *   pnpm build && pnpm test:node
 *   # or to run only this file:
 *   pnpm build && node --import tsx --test tests/dist-smoke.test.ts
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// ============================================================================
// Resolve dist paths
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

// On Windows, dynamic import() requires file:// URLs — bare Win32 paths fail.
const esmDistUrl = pathToFileURL(path.join(distDir, 'index.js')).href;
const cjsDistPath = path.join(distDir, 'index.cjs');

// ============================================================================
// Dynamic imports — deferred to allow build check in `before()`
// ============================================================================

type DistModule = {
  createResilientHttp: (opts?: Record<string, unknown>) => unknown;
  ResilientHttpError: new (init: { kind: string; message?: string; statusCode?: number }) => unknown;
  isResilientHttpError: (e: unknown) => boolean;
};

let esmModule: DistModule;
let cjsModule: DistModule;

// ============================================================================
// Test suite
// ============================================================================

describe('dist smoke — ESM + CJS artefacts', () => {
  before(async () => {
    // Dynamic import of ESM dist — use file:// URL for Windows compatibility
    esmModule = (await import(esmDistUrl)) as DistModule;

    // CJS dist via createRequire (avoids ESM/CJS loader confusion)
    const requireCjs = createRequire(import.meta.url);
    cjsModule = requireCjs(cjsDistPath) as DistModule;
  });

  // --------------------------------------------------------------------------
  // Surface checks
  // --------------------------------------------------------------------------

  it('ESM dist exports createResilientHttp as a function', () => {
    assert.strictEqual(typeof esmModule.createResilientHttp, 'function');
  });

  it('ESM dist exports ResilientHttpError as a constructor', () => {
    assert.strictEqual(typeof esmModule.ResilientHttpError, 'function');
  });

  it('ESM dist exports isResilientHttpError as a function', () => {
    assert.strictEqual(typeof esmModule.isResilientHttpError, 'function');
  });

  it('CJS dist exports createResilientHttp as a function', () => {
    assert.strictEqual(typeof cjsModule.createResilientHttp, 'function');
  });

  it('CJS dist exports ResilientHttpError as a constructor', () => {
    assert.strictEqual(typeof cjsModule.ResilientHttpError, 'function');
  });

  it('CJS dist exports isResilientHttpError as a function', () => {
    assert.strictEqual(typeof cjsModule.isResilientHttpError, 'function');
  });

  // --------------------------------------------------------------------------
  // Basic smoke: createResilientHttp returns an object with HTTP methods
  // --------------------------------------------------------------------------

  it('ESM createResilientHttp() returns a client with .get and .post', () => {
    const client = esmModule.createResilientHttp({}) as Record<string, unknown>;
    assert.strictEqual(typeof client['get'], 'function');
    assert.strictEqual(typeof client['post'], 'function');
  });

  it('CJS createResilientHttp() returns a client with .get and .post', () => {
    const client = cjsModule.createResilientHttp({}) as Record<string, unknown>;
    assert.strictEqual(typeof client['get'], 'function');
    assert.strictEqual(typeof client['post'], 'function');
  });

  // --------------------------------------------------------------------------
  // Brand cross-module check: the critical dual-package hazard test
  // --------------------------------------------------------------------------

  it('CJS ResilientHttpError is recognised by ESM isResilientHttpError (cross-boundary brand)', () => {
    // Construct an error via the CJS module
    const cjsError = new cjsModule.ResilientHttpError({
      kind: 'setup',
      message: 'cjs-origin error',
    });

    // Detect it via the ESM module — if brand used instanceof, this would fail
    // because the CJS and ESM copies are different class objects. Symbol.for()
    // makes both copies write/read the same global symbol key.
    assert.ok(
      esmModule.isResilientHttpError(cjsError),
      'ESM isResilientHttpError should recognise a CJS-constructed ResilientHttpError'
    );
  });

  it('ESM ResilientHttpError is recognised by CJS isResilientHttpError (cross-boundary brand)', () => {
    // Construct an error via the ESM module
    const esmError = new esmModule.ResilientHttpError({
      kind: 'setup',
      message: 'esm-origin error',
    });

    // Detect it via the CJS module
    assert.ok(
      cjsModule.isResilientHttpError(esmError),
      'CJS isResilientHttpError should recognise an ESM-constructed ResilientHttpError'
    );
  });

  it('plain Error objects are NOT recognised as ResilientHttpError by either module', () => {
    const plain = new Error('not a resilient error');
    assert.strictEqual(esmModule.isResilientHttpError(plain), false);
    assert.strictEqual(cjsModule.isResilientHttpError(plain), false);
  });

  it('ResilientHttpError toJSON() omits body and cause (safe-by-default)', () => {
    const err = new esmModule.ResilientHttpError({
      kind: 'response',
      statusCode: 422,
    }) as { toJSON: () => Record<string, unknown> };

    const json = err.toJSON();
    assert.ok(!('body' in json), 'toJSON() must not include body');
    assert.ok(!('cause' in json), 'toJSON() must not include cause');
    assert.ok(!('meta' in json), 'toJSON() must not include meta');
    assert.strictEqual(json['statusCode'], 422);
    assert.strictEqual(json['kind'], 'response');
  });

  // --------------------------------------------------------------------------
  // Fetch mock smoke: end-to-end request with mocked fetch
  // --------------------------------------------------------------------------

  it('ESM client.get() resolves ResilientResponse with mocked fetch (status 200)', async () => {
    const mockFetch = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const client = esmModule.createResilientHttp({
      baseURL: 'https://example.com',
      fetch: mockFetch,
    }) as { get: (url: string) => Promise<{ status: number; data: unknown }> };

    const result = await client.get('/ping');
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.data, { ok: true });
  });
});
