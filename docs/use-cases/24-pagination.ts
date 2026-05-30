/**
 * 24-pagination.ts
 *
 * Tool: createResilientHttp + per-request params.
 * Recipe: paginate a cursor-based or offset-based API, retrying each page.
 *
 * Contract:
 *   - The resilient client is used for EACH page request independently.
 *     If a page fetch fails, only that page is retried — not the entire sequence.
 *   - Cursor-based pagination (nextCursor) and offset-based pagination (page/limit)
 *     are both shown.
 *   - Pagination is a caller-side loop; the library provides per-request resilience.
 */

import { createResilientHttp } from 'resilient-http';

// ---------------------------------------------------------------------------
// Shared types for the example.
// ---------------------------------------------------------------------------

interface ItemsPage {
  items: Array<{ id: number; name: string }>;
  nextCursor: string | null;
}

interface OffsetPage {
  items: Array<{ id: number }>;
  total: number;
}

// ---------------------------------------------------------------------------
// Inline fetch mock — cursor-based, 3 pages then done.
// ---------------------------------------------------------------------------

function makeCursorFetch(): typeof globalThis.fetch {
  const pages: ItemsPage[] = [
    { items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], nextCursor: 'cursor-2' },
    { items: [{ id: 3, name: 'c' }, { id: 4, name: 'd' }], nextCursor: 'cursor-3' },
    { items: [{ id: 5, name: 'e' }],                        nextCursor: null },
  ];
  const byKey: Record<string, ItemsPage> = {
    'start':    pages[0],
    'cursor-2': pages[1],
    'cursor-3': pages[2],
  };

  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const searchParams = new URL(url).searchParams;
    const cursor = searchParams.get('cursor') ?? 'start';
    const page = byKey[cursor] ?? { items: [], nextCursor: null };
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Inline fetch mock — offset-based, total = 5, page size = 2.
// ---------------------------------------------------------------------------

function makeOffsetFetch(): typeof globalThis.fetch {
  const allItems = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));

  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const sp = new URL(url).searchParams;
    const offset = Number(sp.get('offset') ?? '0');
    const limit  = Number(sp.get('limit')  ?? '2');
    const page: OffsetPage = {
      items: allItems.slice(offset, offset + limit),
      total: allItems.length,
    };
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Example A: cursor-based pagination — collect all items across pages.
// ---------------------------------------------------------------------------

export async function example24a(): Promise<void> {
  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeCursorFetch(),
    retry: { maxAttempts: 3, initialDelay: 50, jitter: 'full' },
  });

  const allItems: Array<{ id: number; name: string }> = [];
  let cursor: string | null = null; // null = first page (no cursor param)

  while (true) {
    const params: Record<string, string> = cursor ? { cursor } : {};
    const { data } = await client.get<ItemsPage>('/items', { params });

    if (!data) break;

    allItems.push(...data.items);

    if (!data.nextCursor) break; // last page
    cursor = data.nextCursor;
  }

  console.log(allItems.length);          // 5
  console.log(allItems.map((i) => i.id)); // [1, 2, 3, 4, 5]
}

// ---------------------------------------------------------------------------
// Example B: offset-based pagination — iterate with page number.
// ---------------------------------------------------------------------------

export async function example24b(): Promise<void> {
  const PAGE_SIZE = 2;

  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeOffsetFetch(),
    retry: { maxAttempts: 3, initialDelay: 50, jitter: 'full' },
  });

  const allIds: number[] = [];
  let offset = 0;

  while (true) {
    const { data } = await client.get<OffsetPage>('/data', {
      params: { offset, limit: PAGE_SIZE },
    });

    if (!data || data.items.length === 0) break;

    allIds.push(...data.items.map((i) => i.id));

    if (allIds.length >= data.total) break;
    offset += PAGE_SIZE;
  }

  console.log(allIds.length); // 5
  console.log(allIds);        // [1, 2, 3, 4, 5]
}

// ---------------------------------------------------------------------------
// Example C: paginate with an early-exit predicate (stop on first matching page).
// ---------------------------------------------------------------------------

export async function example24c(): Promise<void> {
  const client = createResilientHttp({
    baseURL: 'https://api.example.com',
    fetch: makeCursorFetch(),
    retry: { maxAttempts: 2, initialDelay: 0 },
  });

  let pagesRead = 0;
  let cursor: string | null = null;

  // Stop as soon as we find an item with id === 3.
  while (true) {
    const params: Record<string, string> = cursor ? { cursor } : {};
    const { data } = await client.get<ItemsPage>('/items', { params });

    if (!data) break;
    pagesRead++;

    const found = data.items.find((item) => item.id === 3);
    if (found) {
      console.log(`found id=3 on page ${pagesRead}:`, found.name); // 'c'
      break;
    }

    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }

  console.log(pagesRead); // 2 — stopped after the second page
}
