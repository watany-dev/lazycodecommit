# CI

`bun run ci` is the pre-push gate and runs what CI runs, except Semgrep:
oxlint, biome, `tsc --noEmit`, knip, `bun audit`, Vitest with a 95% coverage
gate, the build, `scripts/pack-smoke.sh`, `scripts/startup.mjs`, then
actionlint and zizmor (through `uvx`; zizmor's online audits need `GH_TOKEN`).

## Workflows

`ci.yml`, on every PR and push to `main`:

| Job                                      | What it guards                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Lint (oxlint, biome, tsc, knip)`        | Lint, format, types, unused exports and dependencies                                                                                       |
| `Audit (bun audit)`                      | Known advisories in dependencies; also runs daily                                                                                          |
| `Test (ubuntu-24.04)`, `Test (macos-15)` | Vitest with the coverage gate                                                                                                              |
| `Package`                                | `bun run build` and `npm pack`; uploads the tarball                                                                                        |
| `Node 20` … `Node 26`                    | Installs that tarball with npm on plain Node.js, runs both bins, gates cold start (median of 15 `--version` runs) at the spec's 300 ms, and fails if the files every command loads contain Ink or React |
| `Workflow lint (actionlint)`, `Zizmor`   | Workflow correctness and security; zizmor findings fail the job in its log                                                                 |
| `Semgrep`                                | `p/default`, fails on findings; SARIF to code scanning except from fork PRs, whose token cannot upload                                     |

The Node jobs are why the package can promise "runs on CloudShell's Node.js
through npx, no Bun": Bun builds and tests, but nothing in the tarball needs it.
The lowest Node in the matrix is `engines.node` in `package.json`.

`release.yml`, on a `v*` tag: checks the tag equals `v` + `package.json`
version and points at a commit on `main`; audits, builds and tests without
caches; runs the Node matrix (install and cold start) on the tarball; publishes that same tarball to npm with
Trusted Publishing (OIDC, provenance); creates the GitHub Release with the
tarball and `SHA256SUMS` in one call.

Conventions every workflow follows (zizmor enforces most of them):

- Actions pinned to a full commit SHA with the tag in a comment; Dependabot
  bumps actions and bun dependencies weekly after a 7-day cooldown, and
  `bunfig.toml` refuses packages younger than 7 days.
- `permissions: {}` at the top, the minimum per job, a comment on every
  permission beyond `contents: read`.
- `actions/checkout` with `persist-credentials: false`; a `timeout-minutes`
  on every job; no caches in `release.yml`.
- `src/` is type-checked with Node types only (`tsconfig.json`); Bun types
  are limited to `build.ts` (`tsconfig.build.json`), so a `Bun.*` call in
  shipped code fails `tsc`.
- One pinned version per tool: Bun in `packageManager`, actionlint and zizmor
  in `lint:workflows` and `ci.yml` (keep them in sync).

## Repository settings checklist

These live in GitHub and npm settings, not in the repository. Review them
when a maintainer, workflow, or job name changes.

**`main` branch ruleset** (Settings → Rules → Rulesets):

- Restrict deletions and block force pushes.
- Require a pull request before merging, with review from Code Owners
  (`.github/CODEOWNERS`). A PR author cannot approve their own PR, so while
  there is a single maintainer, add them to the bypass list (pull requests
  only) or no maintainer PR can merge.
- Require every `ci.yml` job in the table above as a status check, with the
  branch up to date. A renamed job drops out of the required list silently,
  so update the ruleset in the same PR.

**Actions** (Settings → Actions → General): workflow permissions read-only;
do not allow Actions to create or approve pull requests; require actions to
be pinned to a full-length commit SHA.

**Security** (Settings → Advanced Security): code scanning on (Semgrep's
SARIF upload is skipped with a warning while it is off), private
vulnerability reporting (SECURITY.md points to it), Dependabot alerts,
secret scanning with push protection.

## Releases

Before the first tag:

1. Remove `"private": true` from `package.json`. The package is
   `lazycodecommit` with bins `lazycodecommit` and `lazycc`; the flag stays
   until the steps below are done, so an early tag cannot publish.
2. On npmjs.com, add a Trusted Publisher for the package: repository
   `watany-dev/lazycodecommit`, workflow `release.yml`, environment `npm`.
   Enable 2FA for every maintainer and create no publish tokens.
3. Create the `npm` environment (Settings → Environments): deployment tags
   `v*` only, the maintainer as required reviewer.
4. Add a `v*` tag ruleset limiting creation, update and deletion to the
   maintainer, and enable immutable releases (Settings → General → Releases).

To release: bump `version` in `package.json` on `main`, then push the tag
`v<version>`.

## Not yet decided

- **Lowest Node.js.** `engines.node` is `>=20` and the matrix starts at 20
  until CloudShell's actual `node --version` is confirmed. If it is 22 or
  later, raise both.
