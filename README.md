# lazycodecommit

A daily-driver client for AWS CodeCommit: subcommands like `gh`, a TUI like
lazygit. The command is `lazycc`. It is the successor to
[review-codecommit](https://github.com/watany-dev/review-codecommit).

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)

> **Status: pre-release.** The package is not on npm yet, and every feature
> has so far been tested only against mocked AWS APIs, not a real CodeCommit
> repository. Expect rough edges and please report them.

## Features

- Open a pull request from the branch you are on, pushing it first if needed:
  `lazycc pr create --fill --push`
- List, view, check out, comment on, approve, merge and close pull requests
  from the command line, with `--json` for scripts
- An inbox across repositories: PRs awaiting your approval and your own open
  PRs, with unread markers (`lazycc`, or `lazycc status` as text)
- The review screen from review-codecommit: diffs, inline comments, replies,
  reactions, approval, merge and close, plus comment drafts you post together
  (`Tab` keeps a comment as a draft, `D` lists them, `S` posts them)
- A branch table: every branch with its PR, ahead/behind counts and approval
  rules; open, create or delete from there
- Read a repository's files without cloning it (`lazycc browse`), which suits
  CloudShell
- Clone by repository name (`lazycc clone my-repo`)
- Shell completion for bash, zsh and fish
- Works out of the box inside a clone: the repository, region and profile come
  from the `origin` remote

## Requirements

- Node.js 20 or later (CloudShell's Node.js works; Bun is not needed to run it)
- git, for the commands that work on a clone
- AWS credentials from the SDK's default chain (CloudShell has them already)
- IAM permissions for the features you use: see [docs/iam.md](docs/iam.md)

## Installation

The package is not on npm yet, so for now you build it once and install the
result. Building needs [Bun](https://bun.sh); the result is a single `.tgz`
that runs on plain Node.js 20 or later (CI installs it on Node 20 to 26).

### On AWS CloudShell

CloudShell has Node.js, git and credentials, so nothing else is needed.
`npx` fetches Bun for the build. Work in `/tmp`: `node_modules` takes a few
hundred MB and the home directory has only 1 GB.

```bash
cd /tmp
git clone https://github.com/watany-dev/lazycodecommit.git
cd lazycodecommit
npx -y bun@1.4.4 install --frozen-lockfile
npx -y bun@1.4.4 run build
npm pack                                  # writes lazycodecommit-0.0.0.tgz
npm install -g ./lazycodecommit-0.0.0.tgz # puts lazycc and lazycodecommit on PATH
cp lazycodecommit-0.0.0.tgz ~/            # optional: /tmp is wiped when the session ends
lazycc --version
```

These steps run as written on Linux with Node.js 22; on CloudShell itself
they have not been tried yet. If `npm install -g` is refused with `EACCES`,
run it with `sudo`. In a later session, reinstall from the copy in your home
directory with `npm install -g ~/lazycodecommit-0.0.0.tgz`.

### On your own machine

With Bun installed:

```bash
git clone https://github.com/watany-dev/lazycodecommit.git
cd lazycodecommit
bun install
bun run build
npm pack
npm install -g ./lazycodecommit-0.0.0.tgz
```

The `.tgz` also installs on a machine without Bun, for example CloudShell
(Actions > Upload file, then the same `npm install -g` line). To try it
without installing, run `node dist/cli.mjs` in place of `lazycc`.

### After the npm release

```bash
npx lazycodecommit            # run without installing; same as lazycc
npm install -g lazycodecommit # puts lazycc and lazycodecommit on PATH
```

## Getting started

lazycc finds the repository, region and profile from the `origin` remote of
the clone you are in, so the quickest start is inside a clone. Outside one,
add `-R <repo>` and, if the repository is not in your default region,
`--region`.

```bash
lazycc --version                 # check the install
lazycc pr list -R my-repo --region ap-northeast-1   # the PR list: checks credentials and permissions
lazycc clone my-repo             # clone by name over HTTPS (--protocol ssh|grc for the others)
cd my-repo
lazycc                           # the home screen (TUI); ? lists the keys, q quits
```

An HTTPS clone needs git to have CodeCommit credentials, for example
`git config --global credential.helper '!aws codecommit credential-helper $@'`
and `git config --global credential.UseHttpPath true`.

From there:

```bash
lazycc pr list                   # the PR list screen; Enter opens a PR's review screen
lazycc pr view 12                # review PR 12: diff, comments, approve (a), merge (m)
git switch -c fix-typo           # ...commit...
lazycc pr create --fill --push   # push the branch and open a PR from its commits
lazycc pr status                 # approvals, approval rules and conflicts of this branch's PR
lazycc browse my-other-repo      # read a repository without cloning it
```

To watch several repositories on the home screen, open the repository picker
with `r` and press `w` on each one: lazycc saves them as `repos` in the
config file, and from then on bare `lazycc` shows them from anywhere.

If a command says the credentials are missing or expired, sign in again
(`aws sso login`, or `aws configure`). If it names an action that was denied,
see [docs/iam.md](docs/iam.md) for the permissions each command needs.

## Commands

`lazycc --help` prints the full usage. `<id>` is a pull request ID; where it
is optional, the current branch's open PR is used.

| Command | What it does |
| --- | --- |
| `lazycc` | The home screen (TUI): the same inbox as `status`. With nothing to watch, it opens the repository picker |
| `lazycc status` | The inbox as text: open PRs awaiting your approval, and your own open PRs with their approval rules and conflicts. ● marks activity since you last opened the PR |
| `lazycc pr create` | Push the current branch if needed and open a PR (see below) |
| `lazycc pr list` | List PRs. `--state open\|closed` (default `open`), `-L/--limit` (default 30): the N most recently created PRs, most recently active first, as `gh pr list`. On a terminal with no flags it opens the PR list screen |
| `lazycc pr view [<id>]` | Show a PR. On a terminal it opens the review screen |
| `lazycc pr status` | Approvals, approval rules and conflicts of the current branch's PR. Needs a clone. With the config's `ci`, `pr view`, `pr status`, the review screen and the home screen add CodeBuild and CodePipeline results ([CI results](docs/configuration.md#ci-results)) |
| `lazycc pr checkout <id>` | Fetch the PR's source branch and switch to it, fast-forwarding an existing local branch. Needs a clone |
| `lazycc pr comment [<id>]` | Comment with `-b text`, `-F file` (`-F -` for stdin), or the editor on a terminal. Closed PRs can be commented on too |
| `lazycc pr approve [<id>]` | Approve; `--revoke` takes the approval back |
| `lazycc pr merge [<id>]` | Merge with one of `--ff`, `--squash`, `--three-way`, or without a flag by the config's `pr.mergeOption`. Refuses if the source branch moved since the PR was read |
| `lazycc pr close [<id>]` | Close without merging |
| `lazycc branch` | Branches with their PR state, ahead/behind counts against the default branch, last commit and approval rules. On a terminal it opens the branch screen |
| `lazycc browse [<repo>]` | Read a repository's tree and files through the API, no clone needed. `--ref` picks a branch or a full 40-character commit ID (default: the default branch), `--path` where to start. On a terminal it opens the browse screen; otherwise it prints the folder listing or the file |
| `lazycc clone <repo> [<dir>]` | Clone by name. `--protocol https\|ssh\|grc` (default `https`; `grc` is [git-remote-codecommit](https://github.com/aws/git-remote-codecommit)). Flags after `--` go to `git clone` |
| `lazycc completion bash\|zsh\|fish` | Print a completion script |

`approve`, `merge` and `close` refuse a PR that is already merged or closed,
without calling the API.

Every command takes `--profile`, `--region` and `--json`. All but `clone` take
`-R/--repo`. With `--json`, or when the output is not a terminal, nothing
opens a TUI: `pr view`, `pr list`, `branch` and `browse` print instead.

Exit codes: 0 success, 1 error, 2 bad arguments.

### pr create

```bash
lazycc pr create                       # edit the draft in $VISUAL / $EDITOR (default vi)
lazycc pr create --fill                # use the draft as is, no editor
lazycc pr create -t "Title" -b "Body"  # no editor either
lazycc pr create --dry-run             # show the draft, create nothing
lazycc pr create -R my-repo -H feature -B main --fill   # outside a clone
```

- Inside a clone, the draft's title and body come from the branch's commits, and the body
  starts from `.codecommit/pull_request_template.md` when the repository has
  one (`pr.template` in the config picks another path).
- `-B/--base` defaults to the repository's default branch, `-H/--head` to the
  current branch. `-F/--body-file` reads the body from a file, or from stdin with `-F -`.
- If the branch has commits that are not on `origin`, a terminal asks before
  pushing. `--push` pushes without asking; `--no-push` stops instead. Without
  a terminal, give `--push`.
- If the branch already has an open PR to the same base, that PR is shown and
  nothing is created.

### Shell completion

```bash
# bash: in ~/.bashrc
source <(lazycc completion bash)
# zsh: in ~/.zshrc
source <(lazycc completion zsh)
# fish
lazycc completion fish > ~/.config/fish/completions/lazycc.fish
```

## How the repository, region and profile are chosen

The repository is `-R/--repo`, else the `origin` remote of the clone you are
in. These remote URLs are understood, and give the region (and, for
git-remote-codecommit, the profile) as well:

| Form | Example |
| --- | --- |
| HTTPS | `https://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/my-repo` |
| SSH | `ssh://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/my-repo` |
| git-remote-codecommit | `codecommit::ap-northeast-1://profile@my-repo` |

The region and profile are taken from the first of: the `--region` /
`--profile` flags, the `origin` remote, `AWS_REGION` / `AWS_DEFAULT_REGION` /
`AWS_PROFILE`, the config file, and the AWS SDK's defaults. The remote comes
before the environment so a repository in another region than your shell's
default is not mixed up.

If `--repo` or `--region` names a different repository than `origin` (another
name, or the same name in another region), lazycc treats you as outside the
clone: it will not push to `origin` or draft from local commits.

## The TUI

The keys follow lazygit's defaults where lazycc does the same thing. Every
screen opens its keys as a menu with `?` (`/` filters, `Enter` presses the
key). Everywhere, `j`/`k` or the arrow keys move, `<`/`>` jump to the first
or last row, `Esc` goes back, and `q` or `Ctrl+c` quits from any screen.
Confirmations take `Enter` (or `y`). The full list is in
[docs/keybindings.md](docs/keybindings.md).

Home, the branch screen and the browse screen are one TUI: `1`, `2` and `3`
switch between them, `r` or `Ctrl+r` on the branch and browse screens picks the
repository they show, and `R` refreshes. Outside a clone, `lazycc browse` without a repository
opens on that picker.

- **Home** (`lazycc`): `]`/`[` (or `Tab`) switch between "awaiting your
  approval" and "your PRs", `Enter` opens the review screen (and marks the PR
  read), `r` opens the repository picker, `/` filters, `u` shows the PR's
  console URL. It shows the last result at once while it refreshes.
- **Repository picker**: `Enter` shows only that repository on the home
  screen, `w` adds it to or removes it from the watch list (saved in the
  config's `repos`), `p` opens its PR list.
- **Branch screen** (`lazycc branch`): `Enter` opens the branch's PR, `o`
  creates one (through `pr create`'s editor and push prompt), `d` deletes the
  branch on CodeCommit, Space switches to it inside a clone, `/` filters,
  `R` runs `git fetch --prune` and reloads, `u` shows the console URL.
  The default branch and branches with an open PR cannot be deleted.
- **Browse screen** (`lazycc browse`): `Enter`/`l` opens, `h`/Backspace goes
  up, `b` switches the ref, `g`/`G` jumps to the top or end.
- **PR list** (`lazycc pr list`, `p` in the picker): `Enter` opens the review
  screen, `f` cycles the status filter, `/` searches, `.`/`,` page.
- **Review screen** (`pr view`, or `Enter` elsewhere): the keys of
  review-codecommit. `n`/`N` move between files, `f` or `Ctrl+g` lists them,
  `c` comments on the PR, `C` on the cursor line, `R` replies, `a` approves,
  `m` or `M` merges (opening on the
  config's `pr.mergeOption`), `x` closes, `A` shows the activity. In a comment
  box `Enter` posts and `Tab` keeps a draft; `D` lists the drafts and `S`
  there posts them all. With the config's `ci`, the CodeBuild and CodePipeline
  results of the PR's commit show in the header. Inside a clone the diff comes
  from git, fetching the PR's branches if needed; otherwise from the API.

## Configuration

Nothing needs configuring. Optional settings live in
`~/.config/lazycc/config.json` (`$XDG_CONFIG_HOME/lazycc/config.json`):

```json
{
  "profile": "dev",
  "region": "ap-northeast-1",
  "repos": ["my-service", "my-infra"],
  "pr": {
    "template": ".codecommit/pull_request_template.md",
    "mergeOption": "squash"
  },
  "branch": { "closedPrLookback": 100 },
  "concurrency": 8,
  "ci": {
    "my-service": {
      "codebuild": ["my-service-pr-check"],
      "codepipeline": ["my-service-release"]
    }
  }
}
```

`ci` names, per repository, the CodeBuild projects and CodePipeline pipelines
whose result for a PR's source commit lazycc shows; a repository not listed
makes no CI calls.

Every key, and the files lazycc keeps under `~/.local/state/lazycc/`, are
described in [docs/configuration.md](docs/configuration.md).

## Authentication and permissions

lazycc uses the AWS SDK's default credential chain, so `aws configure`,
`aws sso login`, environment variables and CloudShell's credentials all work.
When credentials are missing or expired it says so and suggests
`aws sso login` (with `--profile` when one is in use).

Read-only use needs only read actions; each write feature needs its own. See
[docs/iam.md](docs/iam.md) for the action list per command and example
policies.

## Coming from review-codecommit

The review screen and its keys are the same. See
[docs/migrating-from-review-codecommit.md](docs/migrating-from-review-codecommit.md)
for how the old commands map to the new ones.

## Development

Requires [Bun](https://bun.sh) (version in `package.json` `packageManager`)
and [uv](https://docs.astral.sh/uv/) for the workflow linters.

```bash
bun install
bun run ci   # everything CI checks, before every push
```

See [docs/dev/ci.md](docs/dev/ci.md) for the pipeline and release process,
and [docs/dev/spec.ja.md](docs/dev/spec.ja.md) for the specification
(Japanese). [docs/dev/real-aws-check.md](docs/dev/real-aws-check.md) runs
everything against a throwaway CodeCommit repository on real AWS and writes
one report. [docs/dev/emulator.md](docs/dev/emulator.md) points lazycc and
realcheck at AWS Emulator, for trying it without an AWS account (not a
substitute for the real-AWS check).

## License

MIT
