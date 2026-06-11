---
"resilient-http": minor
---

fix(deadline): reject relative `deadline` values with a clear setup error + never throw `undefined`

A `deadline` configured as a relative duration (e.g. `deadline: 8000`) previously made **every** request fail instantly with a contentless `Network error` — `fetch` was never called, because the engine compares `deadline` as an absolute epoch (`Date.now() >= 8000` is always true) and then `throw lastError` threw `undefined`.

- **Guardrail:** `deadline` remains an absolute `Date.now()`-based timestamp. A value below `1e12` (≈ year 2001) is now rejected as a relative-value mistake with a descriptive `ResilientHttpError{kind:'setup'}` — both at client construction and per request — e.g. `"deadline 8000 looks like a relative duration; deadline is an absolute Date.now()-based timestamp — did you mean Date.now() + 8000?"`.
- **Never throw `undefined`:** when the retry loop exits before any attempt runs (a legitimately-past absolute deadline), it now surfaces a meaningful `classification:'timeout'` error instead of a contentless `Network error`.

No new options; `deadline` semantics are unchanged for correct (absolute) usage. Fixes #37.
