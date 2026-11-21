const CREDENTIAL_ERRORS = new Set([
  "CredentialsProviderError",
  "TokenProviderError",
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "InvalidSignatureException",
]);

/** CodeCommit refusals the user can act on, phrased as what to do about them. */
const PULL_REQUEST_ERRORS = new Map(
  Object.entries({
    PullRequestCannotBeApprovedByAuthorException: "You cannot approve your own pull request.",
    PullRequestAlreadyClosedException: "The pull request is already closed.",
    ManualMergeRequiredException:
      "The pull request cannot be merged automatically with this strategy (conflicts, or it cannot fast-forward). Resolve them, or pick another strategy.",
    TipOfSourceReferenceIsDifferentException:
      "The source branch has moved since the pull request was read. Check the new commits, then retry.",
    PullRequestApprovalRulesNotSatisfiedException:
      "The pull request's approval rules are not satisfied yet.",
    TipsDivergenceExceededException:
      "The branches have diverged too far to merge here. Merge them locally with git.",
    ConcurrentReferenceUpdateException: "The branch was updated at the same moment. Retry.",
    CommentContentSizeLimitExceededException:
      "The comment is over CodeCommit's 10,240 character limit.",
    CommentNotCreatedByCallerException: "You can only edit your own comments.",
    CommentDeletedException: "Comment has already been deleted.",
  }),
);

/** CodeCommit's refusal of a pull request action, phrased as what to do; the CLI and the TUI share it. */
export function refusalText(name: string): string | undefined {
  return PULL_REQUEST_ERRORS.get(name);
}

const notSent = new WeakSet<object>();

/** Records that this error was raised before the request left this process. */
export function markNotSent(error: unknown): void {
  if (typeof error === "object" && error !== null) notSent.add(error);
}

/** True only when the request certainly never left, so nothing was posted. */
export function wasNotSent(error: unknown): boolean {
  return typeof error === "object" && error !== null && notSent.has(error);
}

/** Missing or expired credentials: the fix is to sign in again, not to change a policy. */
export function isCredentialError(error: Error): boolean {
  if (CREDENTIAL_ERRORS.has(error.name)) return true;
  // A service's answer is known by its name: its message can quote a repository or branch name.
  if ("$fault" in error) return false;
  return /sso.*(expired|token)|token.*expired/i.test(error.message);
}

const ACCESS_DENIED = new Set(["AccessDeniedException", "AccessDenied"]);

/**
 * Turns an AWS SDK error into what the user should do next, or undefined when
 * the SDK message is already the best we have.
 */
export function explainAwsError(error: unknown, profile: string | undefined): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const name = error.name;
  if (isCredentialError(error)) {
    const flag = profile ? ` --profile ${profile}` : "";
    return [
      `AWS credentials are missing or expired (${name}: ${error.message})`,
      `Sign in again, for example \`aws sso login${flag}\`, then retry.`,
    ].join("\n");
  }
  const known = refusalText(name);
  if (known) return known;
  if (ACCESS_DENIED.has(name)) {
    // The message names the codecommit:<Action> that was refused.
    return `Access denied: ${error.message}`;
  }
  if (name === "PullRequestDoesNotExistException" || name === "RepositoryDoesNotExistException") {
    const flag = profile ? ` and --profile ${profile}` : " and --profile";
    return `${error.message.replace(/\.$/, "")}. Check the name or id, --region${flag}.`;
  }
  if (name === "TimeoutError") {
    return `CodeCommit did not answer in time (${error.message.replace(/\.$/, "")}). Check the network and the region, then retry.`;
  }
  if (/region is missing/i.test(error.message)) {
    return 'No AWS region. Pass --region, set AWS_REGION, or add "region" to the config file.';
  }
  return undefined;
}
