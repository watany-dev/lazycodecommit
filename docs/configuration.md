# Configuration

lazycc runs without any configuration. Everything here is optional.

## Config file

`~/.config/lazycc/config.json`, or `$XDG_CONFIG_HOME/lazycc/config.json`.

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

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `profile` | string | none | AWS profile, used when no flag, remote or `AWS_PROFILE` gives one |
| `region` | string | none | AWS region, used when no flag, remote or `AWS_REGION` / `AWS_DEFAULT_REGION` gives one |
| `repos` | array of strings | none | Repositories the home screen and `status` watch. Without it, the clone you are in. The repository picker's `w` edits this list |
| `pr.template` | string | `.codecommit/pull_request_template.md` | PR body template for `pr create`, relative to the clone's root |
| `pr.mergeOption` | `"ff"`, `"squash"` or `"three-way"` | none | The merge strategy `pr merge` uses when given none of `--ff`, `--squash`, `--three-way`, and the one selected first in the review screen's merge picker. Without it, `pr merge` needs a flag |
| `branch.closedPrLookback` | positive integer | 100 | How many recent closed PRs the branch table checks to tell whether a branch was merged |
| `concurrency` | positive integer | 8 | How many API calls run at once when reading many repositories or PRs |
| `ci.<repo>.codebuild`, `ci.<repo>.codepipeline` | arrays of strings | none | CodeBuild projects and CodePipeline pipelines whose runs are the repository's CI results. See [CI results](#ci-results) |

A config file that is not valid JSON, or has a value of the wrong type, stops
every command with an error naming the file and the key. Unknown keys are
ignored, so a config written for a newer lazycc still loads.

When the repository picker saves `repos`, it rewrites the file with two-space
indents and keeps the other keys.

## CI results

CodeCommit does not link a pull request to CodeBuild or CodePipeline, so
lazycc links them by commit: for each project and pipeline listed under the
repository in `ci`, it reads the 20 newest runs and shows the newest one that
built the PR's source commit (a build's `resolvedSourceVersion`, an
execution's source revision). `pr view` and `pr status` print one line per
project and pipeline, and add `checks` to their `--json` output.

The runs are read in the same region and with the same credentials as the
repository, and need `codebuild:ListBuildsForProject`,
`codebuild:BatchGetBuilds` and `codepipeline:ListPipelineExecutions`. A
repository without an entry in `ci` calls none of them. A lookup that fails
(a missing permission, a misspelt name) is shown on its line and does not
stop the command.

A pipeline that only builds the default branch has no run for an open PR's
source commit, so its line says `no run`.

## Region and profile

Taken from the first of:

1. The `--region` / `--profile` flags
2. Inside a clone, the `origin` remote URL
3. `AWS_REGION`, then `AWS_DEFAULT_REGION` / `AWS_PROFILE`
4. The config file
5. The AWS SDK's defaults (`~/.aws/config` and so on)

## Environment variables

| Variable | Used for |
| --- | --- |
| `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION` | See above |
| `VISUAL`, `EDITOR` | The editor for `pr create` and `pr comment` (default `vi`). Run through the shell, so `EDITOR="code --wait"` works |
| `XDG_CONFIG_HOME` | Where the config file lives |
| `XDG_STATE_HOME` | Where local state lives |

Credentials themselves come from the SDK's default chain, so the usual
`AWS_ACCESS_KEY_ID` and friends apply.

## Local state

lazycc keeps a few files under `~/.local/state/lazycc/`
(`$XDG_STATE_HOME/lazycc/`):

| File | Contents |
| --- | --- |
| `seen.json` | When you last opened each PR, for the unread marker |
| `cache.json` | The home screen's last result, shown while it refreshes |
| `identity.json` | Your ARN per profile, from `sts:GetCallerIdentity` |

The directory and files are created readable only by you (`0700` / `0600`).
They are safe to delete. A damaged file is discarded and rebuilt rather than
stopping lazycc. In CloudShell the home directory persists per region, so
unread state survives between sessions in the same region.
