---
"resilient-http": minor
---

feat: widen supported Node.js range to >=22 (was >=24)

Lower the `engines.node` floor from `>=24.0.0` to `>=22.0.0`. This is the
version the code has actually required all along — `src/core/signals.ts`
documents a Node 22+ floor and the only modern API it uses, `AbortSignal.any`,
has been available since Node 20.3. The `>=24` constraint was stricter than the
code needs.

- `engines.node`: `>=24.0.0` → `>=22.0.0` (backward-compatible: widens the set
  of supported runtimes, never narrows it).
- CI now tests the full supported range — the matrix runs Node 22, 24, and 26
  instead of 24 only.
- `@types/node` aligned to `^22` to match the new minimum (it was `^20`, below
  the engine floor).

No runtime behavior changes; no public API changes.
