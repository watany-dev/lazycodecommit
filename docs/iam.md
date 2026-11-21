# IAM permissions

lazycc calls the CodeCommit API with your credentials, so each feature needs
the actions it calls. Reading needs only read actions; each write is a
separate action you can leave out. Action names below drop the
`codecommit:` prefix.

This list was compiled from the API calls in the source, not yet checked
against a real account. If a command fails with `Access denied: ...`, the
message names the refused action.

`sts:GetCallerIdentity` (used to find your own ARN for the inbox) needs no
permission.

## Per command

| Command | Actions |
| --- | --- |
| `lazycc`, `lazycc status` | `ListPullRequests`, `GetPullRequest`, `GetPullRequestApprovalStates`, `EvaluatePullRequestApprovalRules`, `GetMergeConflicts`; the repository picker adds `ListRepositories` |
| `pr list` | `ListPullRequests`, `GetPullRequest` |
| `pr view` and the review screen (reading) | `ListPullRequests` (without an id), `GetPullRequest`, `GetCommit`, `GetDifferences`, `GetBlob`, `GetCommentsForPullRequest`, `GetCommentReactions`, `DescribePullRequestEvents`, `GetPullRequestApprovalStates`, `EvaluatePullRequestApprovalRules`, `GetMergeConflicts`; inside a clone, `GitPull` to fetch the PR's branches |
| `pr diff` | `GetPullRequest` (`ListPullRequests` without an id); `GetDifferences`, `GetBlob` outside a clone, or when the clone lacks the PR's commits |
| `pr status` | `ListPullRequests`, `GetPullRequest`, `GetPullRequestApprovalStates`, `EvaluatePullRequestApprovalRules`, `GetMergeConflicts` |
| `pr create` | `GetRepository` (without `--base`), `ListPullRequests`, `GetPullRequest`, `CreatePullRequest`; `GitPush` when it pushes; `GetBranch` outside a clone, or when the branch has no local copy |
| `pr checkout` | `GetPullRequest`, `GitPull` |
| `pr comment` | `GetPullRequest` (`ListPullRequests` without an id), `PostCommentForPullRequest` |
| `pr approve` | `GetPullRequest` (`ListPullRequests` without an id), `UpdatePullRequestApprovalState` |
| `pr merge` | `GetPullRequest` (`ListPullRequests` without an id), one of `MergePullRequestByFastForward`, `MergePullRequestBySquash`, `MergePullRequestByThreeWay` |
| `pr close` | `GetPullRequest` (`ListPullRequests` without an id), `UpdatePullRequestStatus` |
| `branch` | `GetRepository`, `ListBranches`, `GetBranch`, `ListPullRequests`, `GetPullRequest`, `EvaluatePullRequestApprovalRules`; `DeleteBranch` to delete; `R` runs `git fetch`, which needs `GitPull` |
| `browse` | `GetFolder`, `GetFile`, `ListBranches` (the `b` ref picker), `GetRepository` (without `--ref`) |
| `clone` | `GetRepository`, `GitPull` |
| CI results in `pr view`, `pr status`, the review screen and the home screen, only for repositories listed under `ci` in the config | `codebuild:ListBuildsForProject`, `codebuild:BatchGetBuilds`, `codepipeline:ListPipelineExecutions`. The result is informational; see [CI results](configuration.md#ci-results) for who can influence it |
| Review screen (writing) | `PostCommentForPullRequest`, `PostCommentReply`, `UpdateComment`, `DeleteCommentContent`, `PutCommentReaction`, `UpdatePullRequestApprovalState`, `UpdatePullRequestStatus`, `MergePullRequestByFastForward`, `MergePullRequestBySquash`, `MergePullRequestByThreeWay` |

## Example: read only

Everything except writing: the inbox, lists, the review screen, the branch
table, browse, checkout and clone.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "codecommit:ListRepositories",
        "codecommit:GetRepository",
        "codecommit:ListBranches",
        "codecommit:GetBranch",
        "codecommit:ListPullRequests",
        "codecommit:GetPullRequest",
        "codecommit:GetPullRequestApprovalStates",
        "codecommit:EvaluatePullRequestApprovalRules",
        "codecommit:GetMergeConflicts",
        "codecommit:GetCommit",
        "codecommit:GetDifferences",
        "codecommit:GetBlob",
        "codecommit:GetFolder",
        "codecommit:GetFile",
        "codecommit:GetCommentsForPullRequest",
        "codecommit:GetCommentReactions",
        "codecommit:DescribePullRequestEvents",
        "codecommit:GitPull"
      ],
      "Resource": "*"
    }
  ]
}
```

## Example: daily use

Add these to the read-only actions to create PRs, comment, review and merge.
Leave out what you do not want lazycc to do.

```json
{
  "Effect": "Allow",
  "Action": [
    "codecommit:GitPush",
    "codecommit:CreatePullRequest",
    "codecommit:PostCommentForPullRequest",
    "codecommit:PostCommentReply",
    "codecommit:UpdateComment",
    "codecommit:DeleteCommentContent",
    "codecommit:PutCommentReaction",
    "codecommit:UpdatePullRequestApprovalState",
    "codecommit:UpdatePullRequestStatus",
    "codecommit:MergePullRequestByFastForward",
    "codecommit:MergePullRequestBySquash",
    "codecommit:MergePullRequestByThreeWay",
    "codecommit:DeleteBranch"
  ],
  "Resource": "*"
}
```

`"Resource": "*"` is the simplest; you can narrow it to repository ARNs
(`arn:aws:codecommit:<region>:<account>:<repo>`), except for
`ListRepositories`, which needs `*`.
