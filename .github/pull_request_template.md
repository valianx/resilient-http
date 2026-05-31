<!--
Title: use Conventional Commits, e.g. "fix(errors): surface nested codes"
See CONTRIBUTING.md before opening.
-->

## What & why

<!-- What does this change do, and why is it needed? -->

## How it was verified

<!-- Commands run and their result. Paste real output where useful. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test:node`

## Checklist

- [ ] Tests added/updated (bug fixes include a failing-first regression test)
- [ ] JSDoc updated for any public API change
- [ ] `CHANGELOG.md` updated (SemVer-appropriate)
- [ ] No new runtime dependencies
- [ ] Stays in scope per `ROADMAP.md` (orchestration belongs in consumer code)
- [ ] If touching the error path: `toJSON()` still excludes body/cause/meta and
      leaks no secrets into `message`
