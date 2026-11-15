# AGENTS.md

`lazycodecommit` (command `lazycc`) is a TypeScript CLI/TUI for AWS CodeCommit, built with Bun
and shipped as an npm package that runs on plain Node.js (CloudShell's, via
npx). Bun is a development tool only: nothing in `dist/` may need it.

## Rules

- Run `bun run ci` before every push. It mirrors CI (docs/dev/ci.md).
- Write a failing test before a fix. Coverage stays at 95% or above.
- Commit messages: imperative mood with a type prefix (`feat:`, `fix:`,
  `refactor:`, `chore:`, `docs:`, `ci:`). Push to a feature branch, not `main`.
