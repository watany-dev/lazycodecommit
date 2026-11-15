import { isCredentialError } from "../../aws/errors.js";
import { printable } from "../../core/text.js";

type ErrorContext =
  | "comment"
  | "reply"
  | "approval"
  | "merge"
  | "close"
  | "edit"
  | "delete"
  | "reaction"
  | "activity";

const commonErrors: Record<string, string> = {
  PullRequestDoesNotExistException: "Pull request not found.",
  CommentDoesNotExistException: "Comment no longer exists.",
  CommentDeletedException: "Comment has already been deleted.",
  PullRequestAlreadyClosedException: "Pull request is already closed.",
  EncryptionKeyAccessDeniedException: "Encryption key access denied.",
};

const contextErrors: Record<string, Record<string, string>> = {
  reply: {
    CommentContentRequiredException: "Reply cannot be empty.",
    CommentContentSizeLimitExceededException: "Reply exceeds the 10,240 character limit.",
    CommentDoesNotExistException: "The comment you are replying to no longer exists.",
    InvalidCommentIdException: "Invalid comment ID format.",
  },
  edit: {
    CommentNotCreatedByCallerException: "You can only edit your own comments.",
    CommentContentSizeLimitExceededException: "Comment exceeds the 10,240 character limit.",
  },
  comment: {
    CommentContentRequiredException: "Comment cannot be empty.",
    CommentContentSizeLimitExceededException: "Comment exceeds the 10,240 character limit.",
  },
  approval: {
    RevisionIdRequiredException:
      "Invalid revision. The PR may have been updated. Go back and reopen.",
    InvalidRevisionIdException:
      "Invalid revision. The PR may have been updated. Go back and reopen.",
  },
  merge: {
    ManualMergeRequiredException:
      "Conflicts detected. Cannot auto-merge. Resolve conflicts manually.",
    PullRequestApprovalRulesNotSatisfiedException:
      "Approval rules not satisfied. Get required approvals first.",
    TipOfSourceReferenceIsDifferentException:
      "Source branch has been updated. Go back and reopen the PR.",
    ConcurrentReferenceUpdateException: "Branch was updated concurrently. Try again.",
    TipsDivergenceExceededException: "Branches have diverged too much. Merge manually.",
  },
  reaction: {
    ReactionValueRequiredException: "Reaction value is required.",
    InvalidReactionValueException: "Invalid reaction value.",
  },
};

function sanitizeMessage(message: string): string {
  return message
    .replace(/arn:[^\s"')]+/gi, "[ARN]")
    .replace(/\b\d{12}\b/g, "[ACCOUNT_ID]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[ACCESS_KEY]")
    .replace(/(?:us|eu|ap|sa|ca|me|af)-[a-z]+-\d+/g, "[REGION]")
    .replace(/(?<=[^A-Za-z0-9/+=]|^)[A-Za-z0-9/+=]{40}(?=[^A-Za-z0-9/+=]|$)/g, "[SECRET_KEY]")
    .replace(/IQoJb2lnaW5[A-Za-z0-9/+=]+/g, "[SESSION_TOKEN]")
    .replace(/vpce-[a-z0-9]+/gi, "[VPC_ENDPOINT]");
}

export function formatErrorMessage(
  err: unknown,
  context?: ErrorContext,
  approvalAction?: "approve" | "revoke",
): string {
  if (!(err instanceof Error)) {
    return context ? String(err) : "An unexpected error occurred.";
  }

  const name = err.name;

  // Special case: approval action depends on approve/revoke
  if (context === "approval" && name === "PullRequestCannotBeApprovedByAuthorException") {
    return approvalAction === "revoke"
      ? "Cannot revoke approval on your own pull request."
      : "Cannot approve your own pull request.";
  }

  const message = (context && contextErrors[context]?.[name]) ?? commonErrors[name];
  if (message) return message;

  if (name === "CredentialError" || isCredentialError(err)) {
    return "AWS credentials are missing or expired. Sign in again, for example `aws sso login`, then retry.";
  }
  if (name === "RepositoryDoesNotExistException") {
    return "Repository not found.";
  }

  if (name === "AccessDeniedException" || name === "UnauthorizedException") {
    // Spec (IAM 権限): name the action the policy is missing.
    const action = /\bcodecommit:[A-Za-z]+/.exec(err.message)?.[0];
    if (action) return `Access denied: your IAM policy does not allow ${action}.`;
    if (context === "comment") {
      return "Access denied. Check your IAM policy allows CodeCommit write access.";
    }
    return "Access denied. Check your IAM policy.";
  }

  if (
    name === "NetworkingError" ||
    err.message.includes("ECONNREFUSED") ||
    err.message.includes("ETIMEDOUT")
  ) {
    return "Network error. Check your connection.";
  }

  return printable(sanitizeMessage(err.message));
}
