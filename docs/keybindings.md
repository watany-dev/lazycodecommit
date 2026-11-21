# Keybindings

Every screen lists its keys with `?`. This page collects them.

The keys follow [lazygit](https://github.com/jesseduffield/lazygit)'s
defaults where lazycc has the same action. lazycc's older keys (`g`/`G`,
`n`/`p` for pages, `Tab` for the home sections, `f` for the file list, `n` to
create a PR, `m` to merge, `y` to confirm) still work beside them.

## Everywhere

| Key | Action |
| --- | --- |
| `j` / `↓`, `k` / `↑` | Move the cursor |
| `<` / `Home`, `>` / `End` | First / last row |
| `Esc` | Go back or close; on a top screen it does nothing (except on home, see below) |
| `q`, `Ctrl+c` | Quit lazycc, from any screen (in a text box, `q` is typed) |
| `?` | Open the keys of this screen as a menu |

In the `?` menu, `j`/`k` move, `/` filters the keys, `Enter` closes the menu
and presses the selected key, and `Esc` or `?` closes it.

Confirmation prompts take `Enter` or `y` to go ahead, and `Esc` or `n` to
cancel.

In a text box (a comment, the `/` filter, a search or a ref), `←` / `→` move
the cursor and `Backspace` deletes the character before it.

## Home, branch and browse screens

| Key | Action |
| --- | --- |
| `1` / `2` / `3` | Switch to home / the branch screen / the browse screen |
| `r` / `Ctrl+r` | On the branch and browse screens: pick the repository they show |
| `R` | Refresh |

Outside a clone, `lazycc browse` without a repository opens on the picker.

While filtering with `/`, type to narrow the list, `Enter` keeps the filter
and `Esc` clears it.

## Home (`lazycc`)

| Key | Action |
| --- | --- |
| `]` / `[`, `Tab` | Switch between "awaiting your approval" and "your PRs" |
| `Enter` | Open the PR in the review screen (marks it read) |
| `r` / `Ctrl+r` | Open the repository picker |
| `Esc` | After `Enter` in the picker showed one repository, go back to the watched ones (the header says `<repo> only  Esc back to …`) |
| `/` | Filter |
| `R` | Refresh |
| `u` | Show the PR's console URL |

## Repository picker (`r`)

| Key | Action |
| --- | --- |
| `Enter` | Show only this repository (on the home screen, until `Esc` there; on the branch and browse screens, switch to it) |
| `w` | Add to or remove from the watch list (the config's `repos`) |
| `p` | Open the repository's PR list |
| `/` | Filter |

## PR list (`lazycc pr list`, `p` in the picker)

| Key | Action |
| --- | --- |
| `Enter` | Open the PR in the review screen |
| `f` | Cycle the status filter |
| `/` | Search by title or author |
| `.` / `,`, `n` / `p` | Next / previous page |

## Branch screen (`lazycc branch`)

| Key | Action |
| --- | --- |
| `Enter` | Open the branch's PR in the review screen |
| `o` / `n` | Create a PR for the branch: the screen closes for `pr create`'s editor and push prompt, then opens the new PR |
| `d` | Delete the branch on CodeCommit, after `Enter` or `y` to confirm. Not offered for the default branch or a branch with an open PR |
| `Space` | Switch to the branch (inside a clone) |
| `/` | Filter |
| `R` | `git fetch --prune` and reload |
| `u` | Show the branch's console URL |

## Browse screen (`lazycc browse`)

In a folder:

| Key | Action |
| --- | --- |
| `Enter` / `l` | Open the folder or file |
| `h` / `Esc` / `Backspace` | Up to the parent folder |
| `g` / `G` | First / last entry |
| `b` | Switch the ref (branch or commit) |
| `/` | Filter |
| `R` | Reload |
| `u` | Show the console URL |

In a file:

| Key | Action |
| --- | --- |
| `j` / `k` | Scroll |
| `Ctrl+d` / `Ctrl+u`, `J` / `K`, `PgDn` / `PgUp` | Half a page down / up |
| `g` / `G` | Top / end |
| `h`, `Esc`, `Backspace` | Back to the folder |

## Review screen (`lazycc pr view`, or `Enter` from another screen)

The keys are those of review-codecommit, with lazygit's beside them.

Moving around:

| Key | Action |
| --- | --- |
| `Ctrl+d` / `Ctrl+u`, `J` / `K`, `PgDn` / `PgUp` | Half a page down / up |
| `G` | Jump to the end (`g` reacts; `<` and `>` jump to the top and end) |
| `n` / `N` | Next / previous file |
| `f` / `Ctrl+g` | File list |
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
| `m` / `M` | Merge: pick fast-forward, squash or three-way |
| `x` | Close without merging |
| `A` | Activity timeline |

Confirmation prompts take `Enter` or `y` to go ahead, `Esc` or `n` to cancel.
