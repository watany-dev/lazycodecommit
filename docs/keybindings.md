# Keybindings

Every screen lists its keys with `?`. This page collects them.

## Everywhere

| Key | Action |
| --- | --- |
| `j` / `↓`, `k` / `↑` | Move the cursor |
| `q` / `Esc` | Go back; quit at the top screen |
| `Ctrl+c` | Quit at once |
| `?` | Toggle help |

In a text box (a comment, the `/` filter, a search or a ref), `←` / `→` move
the cursor and `Backspace` deletes the character before it.

## Home, branch and browse screens

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Switch to home / the branch screen / the browse screen |
| `r` | On the branch and browse screens: pick the repository they show |

Outside a clone, `lazycc browse` without a repository opens on the picker.

While filtering with `/`, type to narrow the list, `Enter` keeps the filter
and `Esc` clears it.

## Home (`lazycc`)

| Key | Action |
| --- | --- |
| `Tab` | Switch between "awaiting your approval" and "your PRs" |
| `Enter` | Open the PR in the review screen (marks it read) |
| `r` | Open the repository picker |
| `/` | Filter |
| `Ctrl+r` | Refresh |
| `u` | Show the PR's console URL |

## Repository picker (`r`)

| Key | Action |
| --- | --- |
| `Enter` | Show only this repository (on the home screen; on the branch and browse screens, switch to it) |
| `w` | Add to or remove from the watch list (the config's `repos`) |
| `p` | Open the repository's PR list |
| `/` | Filter |

## PR list (`lazycc pr list`, `p` in the picker)

| Key | Action |
| --- | --- |
| `Enter` | Open the PR in the review screen |
| `f` | Cycle the status filter |
| `/` | Search by title or author |
| `n` / `p` | Next / previous page |

## Branch screen (`lazycc branch`)

| Key | Action |
| --- | --- |
| `Enter` | Open the branch's PR in the review screen |
| `n` | Create a PR for the branch: the screen closes for `pr create`'s editor and push prompt, then opens the new PR |
| `d` | Delete the branch on CodeCommit, after `y` to confirm. Not offered for the default branch or a branch with an open PR |
| `Space` | Switch to the branch (inside a clone) |
| `/` | Filter |
| `Ctrl+r` | `git fetch --prune` and reload |
| `u` | Show the branch's console URL |

## Browse screen (`lazycc browse`)

In a folder:

| Key | Action |
| --- | --- |
| `Enter` / `l` | Open the folder or file |
| `h` / `Backspace` | Up to the parent folder |
| `g` / `G` | First / last entry |
| `b` | Switch the ref (branch or commit) |
| `/` | Filter |
| `Ctrl+r` | Reload |
| `u` | Show the console URL |

In a file:

| Key | Action |
| --- | --- |
| `j` / `k` | Scroll |
| `Ctrl+d` / `Ctrl+u` | Half a page down / up |
| `g` / `G` | Top / end |
| `h`, `q`, `Esc`, `Backspace` | Back to the folder |

## Review screen (`lazycc pr view`, or `Enter` from another screen)

The keys are those of review-codecommit.

Moving around:

| Key | Action |
| --- | --- |
| `Ctrl+d` / `Ctrl+u` | Half a page down / up |
| `G` | Jump to the end |
| `n` / `N` | Next / previous file |
| `f` | File list |
| `]c` / `[c` | Next / previous changed line |
| `t` | Show more of a large diff |
| `Tab` / `Shift+Tab` | Step through "All changes" and each commit |

Comments:

| Key | Action |
| --- | --- |
| `c` | Comment on the PR |
| `C` | Inline comment on the cursor line |
| `R` | Reply to the comment at the cursor |
| `o` | Fold or unfold a thread |
| `e` | Edit your comment |
| `d` | Delete your comment (asks to confirm) |
| `g` | React (`h`/`l` or `←`/`→` to pick, `Enter` to send) |

Drafts: in the `c`, `C` and `R` boxes, `Enter` posts at once and `Tab` keeps
the text as a draft instead. Drafts are saved per PR in
`~/.local/state/lazycc/drafts.json` until posted. CodeCommit has no way to
post several comments at once, so they go out one at a time, in the order you
wrote them.

| Key | Action |
| --- | --- |
| `D` | Draft list |
| `S` (in the list) | Post all drafts (asks to confirm) |
| `e` / `d` (in the list) | Edit / discard a draft (discard asks to confirm) |
| `Enter` (in the list) | Go to an inline draft's line |
| `p` (in the list) | Post a draft whose line changed in new commits anyway |

Pull request:

| Key | Action |
| --- | --- |
| `a` / `r` | Approve / revoke approval (asks to confirm) |
| `m` | Merge: pick fast-forward, squash or three-way |
| `x` | Close without merging |
| `A` | Activity timeline |

Confirmation prompts take `y` or `n` (`Esc` cancels).
