# CI

`bun run ci` is the pre-push gate and runs what CI runs: oxlint, biome,
`tsc --noEmit`, knip, `bun audit`, Vitest with the coverage gate (95% overall,
80% for every file), the build, `scripts/pack-smoke.sh`, `scripts/startup.mjs`,
then actionlint, zizmor and Semgrep (through `uvx`; zizmor's online audits need
`GH_TOKEN`, Semgrep downloads its rules from semgrep.dev).

The property-based tests (fast-check, `*.prop.test.ts` and a few others) run a
fixed number of cases in CI. `FC_RUNS_SCALE=10 bun run test` runs every
property ten times as many (explicit `numRuns` and the default 100 alike), with
the test timeouts scaled to match; use it to look for cases CI's runs miss.

## Workflows

`ci.yml`, on every PR and push to `main`:

| Job                                      | What it guards                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Lint (oxlint, biome, tsc, knip)`        | Lint, format, types, unused exports and dependencies                                                                                       |
| `Audit (bun audit)`                      | Known advisories in dependencies; also runs daily                                                                                          |
| `Test (ubuntu-24.04)`, `Test (macos-15)` | Vitest with the coverage gate, on Node 22 (Vitest runs on Node.js, and 22 is the oldest it supports)                                      |
| `Package`                                | `bun run build` and `npm pack`; uploads the tarball                                                                                        |
| `Node 20` … `Node 26`                    | Installs that tarball with npm on plain Node.js, runs both bins, runs `pr list` from it against a stand-in CodeCommit endpoint (the SDK chunk), `pr view` with a `ci` config against stand-in CodeBuild and CodePipeline (the CI chunk), `pr create --dry-run` in a throwaway clone with a CodeCommit origin (git), two `status` runs at once against a held and a stale lock (state files), and opens the review screen on a pseudo-terminal, types a key burst and a character split across two reads, and quits (the TUI chunk and raw stdin), checks `dist/THIRD_PARTY_LICENSES.txt` ships, gates cold start (median of 15 `--version` runs) at the spec's 300 ms, and fails if the files every command loads contain Ink or React |
| `Workflow lint (actionlint)`, `Zizmor`   | Workflow correctness and security; zizmor findings fail the job in its log                                                                 |
| `Semgrep`                                | `p/default`, fails on findings; SARIF to code scanning except from fork PRs, whose token cannot upload                                     |

`bun run audit` ignores one advisory for now: GHSA-fc5q-39xc-vjpf
(picomatch ≤ 4.0.7, ReDoS). picomatch reaches only dev tools (knip, vitest), no
release fixes it yet, and it is not bundled. Drop the `--ignore` from the
`audit` script once a fixed picomatch is installable (bunfig's 7-day
`minimumReleaseAge` applies).

The Node jobs are why the package can promise "runs on CloudShell's Node.js
through npx, no Bun": Bun builds and tests, but nothing in the tarball needs it.
`scripts/smoke-dist.mjs` (called by `pack-smoke.sh`) is the part that runs the
bundled SDK and TUI, which `--version` never loads, and the code that leans on
`node:` modules (git subprocesses, state files and their locks, raw stdin). On
Node 20, below Vitest's floor, it is the only test that runs. It needs `git`, and
`python3` for the pseudo-terminal, locally too.

Every dependency is bundled, so `build.ts` writes the bundled packages' license
texts to `dist/THIRD_PARTY_LICENSES.txt` and fails when a package ships none;
add its text to `MISSING_LICENSE_FILES` in `build.ts` then.
The lowest Node in the matrix is `engines.node` in `package.json`.

`release.yml`, on a `v*` tag (or by hand as a rehearsal, below): checks the tag equals `v` + `package.json`
version and points at a commit on `main`; audits, builds and tests without
caches; runs the Node matrix (install and cold start) on the tarball; publishes that same tarball to npm with
Trusted Publishing (OIDC, provenance); attests the tarball's build provenance
(`gh attestation verify <tgz> -R watany-dev/lazycodecommit`) and creates the
GitHub Release with the tarball and `SHA256SUMS` in one call.

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
- One pinned version per tool: Bun in `packageManager`; actionlint and zizmor
  in `lint:workflows` and `ci.yml`; Semgrep in `lint:semgrep` and `ci.yml`
  (keep each pair in sync). CI installs actionlint from its release binary,
  checked against a SHA-256 in `ci.yml`.

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

**Rehearsal.** Actions → Release → Run workflow runs every job on the chosen
branch without publishing: the tag checks only warn, publish is
`npm publish --dry-run` with no OIDC token (skipped with a warning while
`package.json` is private), and no GitHub Release is created. Run it after
any change to `release.yml` and before the first tag.

**Before the first tag**, in this order. npm only lets you add a Trusted
Publisher to a package that already exists, so the name has to be published
once by hand before `release.yml` can publish it:

1. Create the `npm` environment (Settings → Environments): deployment tags
   `v*` only, the maintainer as required reviewer. A workflow that names a
   missing environment creates it with no protection, so do this first.
2. Add a `v*` tag ruleset limiting creation, update and deletion to the
   maintainer, and enable immutable releases (Settings → General → Releases).
3. Run the rehearsal on `main`; everything should pass, with the "private"
   warning on the dry-run publish.
4. Publish a placeholder by hand from your machine, with 2FA, to claim
   `lazycodecommit` (it is unclaimed as of 2026-11): for example
   `npx setup-npm-trusted-publish lazycodecommit`, which publishes an empty
   placeholder version. Never publish the real package by hand: it would
   have no provenance.
5. On npmjs.com, add the Trusted Publisher: repository
   `watany-dev/lazycodecommit`, workflow `release.yml`, environment `npm`.
   Then, under the package's publishing access, require 2FA and disallow
   tokens. Create no publish tokens.
6. On a branch, remove `"private": true` from `package.json` and set
   `version` above the placeholder's; merge it, run the rehearsal on `main`
   again (now a real `npm publish --dry-run`), then push the tag.

**To release** after that: bump `version` in `package.json` on `main`, then
push the tag `v<version>`.

## Not yet decided

- **Lowest Node.js.** `engines.node` is `>=20` and the matrix starts at 20
  until CloudShell's actual `node --version` is confirmed. If it is 22 or
  later, raise both.
