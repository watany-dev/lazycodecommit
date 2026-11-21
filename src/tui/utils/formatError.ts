import { isCredentialError, refusalText } from "../../aws/errors.js";
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
  EncryptionKeyAccessDeniedException: "Encryption key access denied.",
};

const contextErrors: Record<string, Record<string, string>> = {
  reply: {
    CommentContentRequiredException: "Reply cannot be empty.",
    CommentDoesNotExistException: "The comment you are replying to no longer exists.",
    InvalidCommentIdException: "Invalid comment ID format.",
  },
  edit: {
    CommentNotCreatedByCallerException: "You can only edit your own comments.",
  },
  comment: {
    CommentContentRequiredException: "Comment cannot be empty.",
  },
  approval: {
    RevisionIdRequiredException:
      "Invalid revision. The PR may have been updated. Go back and reopen.",
    InvalidRevisionIdException:
      "Invalid revision. The PR may have been updated. Go back and reopen.",
  },
  reaction: {
    ReactionValueRequiredException: "Reaction value is required.",
    InvalidReactionValueException: "Invalid reaction value.",
  },
};

/** Node's codes for a connection that failed or a host that did not resolve (offline). */
const NETWORK_CODES = /\b(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ENETUNREACH)\b/;

function sanitizeMessage(message: string): string {
  return (
    message
      .replace(/arn:[^\s"')]+/gi, "[ARN]")
      .replace(/\b\d{12}\b/g, "[ACCOUNT_ID]")
      .replace(/AKIA[0-9A-Z]{16}/g, "[ACCESS_KEY]")
      .replace(/\b(?:us|eu|ap|sa|ca|me|af)-[a-z]+-\d+\b/g, "[REGION]")
      // A commit ID is 40 lowercase hex characters too, and the user needs it.
      .replace(/(?<=[^A-Za-z0-9/+=]|^)[A-Za-z0-9/+=]{40}(?=[^A-Za-z0-9/+=]|$)/g, (m) =>
        /^[0-9a-f]{40}$/.test(m) ? m : "[SECRET_KEY]",
      )
      .replace(/IQoJb2lnaW5[A-Za-z0-9/+=]+/g, "[SESSION_TOKEN]")
      .replace(/vpce-[a-z0-9]+/gi, "[VPC_ENDPOINT]")
  );
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

  const message =
    (context && contextErrors[context]?.[name]) ?? refusalText(name) ?? commonErrors[name];
  if (message) return message;

  if (isCredentialError(err)) {
    return "AWS credentials are missing or expired. Sign in again, for example `aws sso login`, then retry.";
  }
  if (name === "RepositoryDoesNotExistException") {
    return "Repository not found.";
  }

  if (name === "AccessDeniedException") {
    // Spec (IAM 権限): name the action the policy is missing.
    const action = /\bcodecommit:[A-Za-z]+/.exec(err.message)?.[0];
    if (action) return `Access denied: your IAM policy does not allow ${action}.`;
    if (context === "comment") {
      return "Access denied. Check your IAM policy allows CodeCommit write access.";
    }
    return "Access denied. Check your IAM policy.";
  }

  if (name === "TimeoutError" || NETWORK_CODES.test(err.message)) {
    return "Network error. Check your connection.";
  }

  return printable(sanitizeMessage(err.message));
}

/** Our own refusals and git's messages are already written for the user; anything else is explained. */
export function screenErrorText(err: unknown): string {
  if (err instanceof Error && ["UserError", "UsageError", "GitError"].includes(err.name)) {
    return err.message;
  }
  return formatErrorMessage(err);
}
