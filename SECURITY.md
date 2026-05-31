# Security Policy

## Supported versions

Security fixes are released for the current `2.x` line. Older versions are not
maintained — please upgrade to the latest `2.x` before reporting.

| Version | Supported |
|---------|-----------|
| 2.x     | ✅        |
| 1.x     | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **private vulnerability reporting**:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue with enough detail to reproduce it (affected version, a
   minimal repro, and the impact).

You can expect an initial acknowledgement within a few days. Once the report is
validated, a fix and a coordinated release will follow; the advisory is published
after the fix ships so users can upgrade first.

## Scope notes

`resilient-http` is a zero-dependency library that wraps `fetch`. The areas most
relevant to security are:

- **Error serialization (`ResilientHttpError.toJSON()`).** It is safe-by-default:
  it excludes `body`, `cause`, and `meta`, redacts a denylist of sensitive
  headers, and redacts the query parameters named in `redactQueryParams`. The
  error `message` is length-capped to prevent a large response body from leaking
  through it. A regression in any of these behaviors is a security issue.
- **Redaction configuration.** `redactQueryParams` is opt-in: a secret placed in
  a query parameter you did not name will appear in `toJSON().url`. When handling
  sensitive URLs (tokens in the query string), configure `redactQueryParams`
  accordingly. Reports of unsafe defaults are welcome.
- **No body inspection.** The library does not read request/response bodies
  except to derive an error message (which is capped and never included raw in
  `toJSON()`).

## What is not a vulnerability

- A `kind:'network'` error exposing a connection code (e.g. `ECONNREFUSED`) in
  `error.code` / `error.message` — this is intended diagnostic information and
  never includes host, port, URL, headers, or body.
- Behavior that is explicitly documented in `docs/configuration.md` (e.g. POST
  not being retried by default).
