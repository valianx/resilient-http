---
"resilient-http": minor
---

feat(errors): expose the real error in `toJSON()` (cause/body/meta) + resolve network code from AggregateError/errno

`ResilientHttpError` now surfaces the full structured error instead of masking it.

- **`toJSON()` now exposes `cause` (serialized), `body`, and `meta`.** Previously these were dropped on the assumption they "may contain secrets" — but that is a redaction decision the library cannot make on the consumer's behalf (it does not know which fields are sensitive in a given app). The library's job is to expose the structured error; the consuming app decides what to redact, log, or show. **Sensitive-header redaction (`redactHeaders`) and the message-size cap are retained** as the opt-in primitives the consumer controls.
- **Network `code` now resolves through `AggregateError.errors[]` and `errno`.** undici buries the real `ECONNREFUSED` / `ENOTFOUND` inside an `AggregateError` (multi-address connect failures) or in `errno`; the cause-walk now descends both, so `error.code` is populated and the message reads `Network error: ECONNREFUSED` instead of a bare `Network error`. The walk is bounded + cycle-guarded; the new cause serializer is fail-safe (never throws).

**⚠️ Behavior change:** `toJSON()` is no longer safe to forward verbatim to an untrusted client (the previously documented "BFF pattern"). Build a sanitized projection before returning errors to a browser; `redactHeaders` / `redactQueryParams` and the message cap still apply. Fixes #36.
