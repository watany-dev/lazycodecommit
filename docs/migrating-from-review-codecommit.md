# Migrating from review-codecommit

lazycodecommit includes review-codecommit's review screen with the same keys,
and adds commands for the rest of the day: creating PRs, an inbox across
repositories, a branch table, browsing without a clone.

## What changes

| review-codecommit | lazycodecommit |
| --- | --- |
| `review-codecommit` (pick a repository, then a PR) | `lazycc`, then `r` for the repository picker and `p` for its PR list. With no watched repositories and outside a clone, `lazycc` opens on the picker |
| `review-codecommit <repo>` | `lazycc pr list -R <repo>` (opens the PR list screen on a terminal) |
| Opening one PR | `lazycc pr view <id> -R <repo>`, or `lazycc pr view` on the PR's branch inside a clone |
| `--profile`, `--region` | Same flags. Inside a clone they also come from the `origin` remote, so they are usually unnecessary |
| `--completions bash\|zsh\|fish` | `lazycc completion bash\|zsh\|fish` |
| Bun required (`bun install -g`) | Runs on Node.js 20+; Bun is needed only to build from source |

## The review screen

Same keys as before: `c` comment, `C` inline comment, `R` reply, `o` fold,
`e` edit, `d` delete, `g` react, `a` approve, `r` revoke, `m` merge, `x`
close, `A` activity, `Tab` commits, `]c` / `[c` changes, plus `f` for the
file list and `t` to show more of a large diff. See
[keybindings.md](keybindings.md).

Two keys behave differently, to match lazygit: `q` quits from any screen
(`Esc` goes back), and confirmations also take `Enter`.

Inside a clone the diff now comes from local git (fetching the PR's branches
if needed) instead of the API.

## New things you can do

- `lazycc pr create --fill --push` instead of the console's "Create pull
  request"
- `lazycc pr approve`, `pr merge --squash` and friends from the shell, with
  `--json` for scripts
- `lazycc` / `lazycc status` for the PRs waiting on you across repositories:
  list them in `~/.config/lazycc/config.json` under `repos`, or press `w` in
  the repository picker
- `lazycc branch` for branches and their PRs, `lazycc browse` for reading code
  without a clone, `lazycc clone <name>`

## Permissions

The review features need the same IAM actions as before. The new features
need a few more; see [iam.md](iam.md).
