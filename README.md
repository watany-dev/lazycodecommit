# lazycodecommit

A daily-driver client for AWS CodeCommit: subcommands like `gh`, a TUI like
lazygit. Work in progress: Phase 1 (pull requests from the command line) is
in; the TUI comes later. See [docs/dev/spec.ja.md](docs/dev/spec.ja.md).

## Usage

Runs on Node.js 20 or later, CloudShell's included, with no install:

```bash
npx lazycodecommit pr create --fill --push   # push the branch and open a PR
```

Inside a clone, the repository, region and profile come from the `origin`
remote (HTTPS, SSH or `codecommit::` URLs). Elsewhere, pass `--repo`.

| Command | What it does |
| --- | --- |
| `lazycc pr create` | Push the current branch if needed and open a PR. The draft comes from the commits and `.codecommit/pull_request_template.md`; `--fill` skips the editor, `--dry-run` only shows it |
| `lazycc pr list` | List PRs (`--state open\|closed`, `--limit`) |
| `lazycc pr view [id]` | Show a PR; without an id, the current branch's |
| `lazycc pr status` | Approvals, approval rules and conflicts of the current branch's PR |

Every `pr` command takes `-R/--repo`, `--profile`, `--region` and `--json`.
Exit codes: 0 success, 1 error, 2 bad arguments. Optional settings live in
`~/.config/lazycc/config.json` (`profile`, `region`, `pr.template`,
`concurrency`).

## Development

Requires [Bun](https://bun.sh) (version in `package.json` `packageManager`)
and [uv](https://docs.astral.sh/uv/) for the workflow linters.

```bash
bun install
bun run ci   # everything CI checks, before every push
```

See [docs/dev/ci.md](docs/dev/ci.md) for the pipeline and release process.
