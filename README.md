# lazycodecommit

A daily-driver client for AWS CodeCommit: subcommands like `gh`, a TUI like
lazygit. Work in progress: Phase 1 (pull requests from the command line) is
in, and Phase 2 has started with the review screen. See [docs/dev/spec.ja.md](docs/dev/spec.ja.md).

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
| `lazycc pr list` | List PRs (`--state open\|closed`, `--limit`). On a terminal, a bare `pr list` opens the PR list screen |
| `lazycc pr view [id]` | Show a PR; without an id, the current branch's. On a terminal it opens the review screen |
| `lazycc pr status` | Approvals, approval rules and conflicts of the current branch's PR |
| `lazycc pr checkout <id>` | Fetch the PR's source branch and switch to it (fast-forwarding an existing local branch) |
| `lazycc pr comment [id]` | Comment on a PR with `-b text`, `-F file`, or the editor on a terminal |
| `lazycc pr approve [id]` | Approve a PR; `--revoke` takes your approval back |
| `lazycc pr merge [id]` | Merge with one of `--ff`, `--squash`, `--three-way`; refuses if the source branch moved since it was read |
| `lazycc pr close [id]` | Close a PR without merging |
| `lazycc clone <repo> [dir]` | Clone by repository name. `--protocol https\|ssh\|grc` picks the URL (default `https`; `grc` is git-remote-codecommit); flags after `--` go to `git clone` |

The review screen is the one from
[review-codecommit](https://github.com/watany-dev/review-codecommit), with the
same keys (`?` lists them): diff, comments, inline comments, replies,
reactions, approval, merge and close. Inside a clone the diff comes from git
(fetching the PR's branches if needed), and from the API otherwise. With
`--json`, or when not on a terminal, `pr view` and `pr list` print instead.

Every command takes `--profile`, `--region` and `--json`; the `pr` commands
also take `-R/--repo`.
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
