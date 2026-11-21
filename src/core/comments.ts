import type { Comment } from "@aws-sdk/client-codecommit";
import type { PullRequest } from "../aws/codecommit.js";
import type { CommentThread, ReviewApi } from "../aws/review.js";
import { UsageError, UserError } from "./errors.js";
import { commentBody, type PrDeps, resolvePullRequest } from "./pr.js";
import { head, shortArn } from "./text.js";

/** The calls the comment commands make beyond CodeCommitApi: the review screen's own. */
export type CommentApi = Pick<
  ReviewApi,
  "getComments" | "postComment" | "postCommentReply" | "updateComment" | "deleteComment"
>;

interface InlineTarget {
  readonly filePath: string;
  readonly filePosition: number;
  readonly relativeFileVersion: "BEFORE" | "AFTER";
}

/** What `pr comment` does; the TUI's c, C, R, e and x. */
export type CommentAction =
  | { readonly kind: "comment"; readonly location?: InlineTarget }
  | { readonly kind: "reply"; readonly commentId: string }
  | { readonly kind: "edit"; readonly commentId: string }
  | { readonly kind: "delete"; readonly commentId: string; readonly yes: boolean };

export interface CommentFlags {
  readonly replyTo?: string;
  readonly path?: string;
  readonly line?: string;
  readonly before: boolean;
  readonly edit?: string;
  readonly delete?: string;
  readonly yes: boolean;
  readonly body?: string;
  readonly bodyFile?: string;
}

/** The action the flags ask for; every misuse is a usage error, found before any AWS call. */
export function commentAction(flags: CommentFlags, interactive: boolean): CommentAction {
  const action = pickAction(flags, interactive);
  const hasBody = flags.body !== undefined || flags.bodyFile !== undefined;
  if (flags.body !== undefined && flags.bodyFile !== undefined) {
    throw new UsageError("--body and --body-file cannot be used together");
  }
  if (action.kind !== "delete" && !hasBody && !interactive) {
    throw new UsageError("Not a terminal: pass --body or --body-file");
  }
  return action;
}

function pickAction(flags: CommentFlags, interactive: boolean): CommentAction {
  const picked = (
    [
      ["--reply-to", flags.replyTo],
      ["--edit", flags.edit],
      ["--delete", flags.delete],
    ] as const
  ).filter(([, v]) => v !== undefined);
  if (picked.length > 1) {
    throw new UsageError(`${picked.map(([f]) => f).join(" and ")} cannot be used together`);
  }
  for (const [flag, value] of picked) {
    if (value === "") throw new UsageError(`${flag} needs a comment id`);
  }
  const inline = flags.path !== undefined || flags.line !== undefined || flags.before;
  if (inline && picked.length > 0) {
    throw new UsageError(`--path and --line cannot be used with ${picked[0]?.[0]}`);
  }
  if (flags.yes && flags.delete === undefined) throw new UsageError("--yes goes with --delete");
  if (flags.delete !== undefined) {
    if (flags.body !== undefined || flags.bodyFile !== undefined) {
      throw new UsageError("--delete takes no --body or --body-file");
    }
    if (!flags.yes && !interactive) {
      throw new UsageError("Not a terminal: pass --yes to delete without confirming");
    }
    return { kind: "delete", commentId: flags.delete, yes: flags.yes };
  }
  if (flags.replyTo !== undefined) return { kind: "reply", commentId: flags.replyTo };
  if (flags.edit !== undefined) return { kind: "edit", commentId: flags.edit };
  if (!inline) return { kind: "comment" };
  if (flags.path === "") throw new UsageError("--path needs a file path");
  if (flags.path === undefined) throw new UsageError("--line needs --path");
  if (flags.line === undefined) throw new UsageError("--path needs --line");
  // Digits only, as for --limit: Number() also takes "0x10" and "1e1".
  if (!/^\d+$/.test(flags.line) || Number(flags.line) < 1) {
    throw new UsageError(`--line must be a positive integer: ${flags.line}`);
  }
  return {
    kind: "comment",
    location: {
      filePath: flags.path,
      filePosition: Number(flags.line),
      relativeFileVersion: flags.before ? "BEFORE" : "AFTER",
    },
  };
}

export interface CommentResult {
  readonly pr: PullRequest;
  readonly action: CommentAction;
  readonly commentId: string;
}

export interface CommentDeps extends PrDeps {
  /** Created only for an action CodeCommitApi does not cover. */
  review(): Promise<CommentApi>;
}

/**
 * Comments on the PR, inline or on the whole, replies to, edits or deletes a
 * comment. A closed PR still takes all of them, as in the console. A comment
 * id must be one of this PR's, so a pasted id cannot act on another PR.
 * `action` comes from commentAction, which has checked the flags.
 */
export async function commentOnPullRequest(
  id: string | undefined,
  action: CommentAction,
  opts: { readonly body?: string; readonly bodyFile?: string },
  deps: CommentDeps,
): Promise<CommentResult> {
  const pr = await resolvePullRequest(id, deps);
  if (action.kind === "comment") {
    const body = await commentBody(opts, "", deps);
    if (!action.location) return { pr, action, commentId: await deps.api.postComment(pr, body) };
    const comment = await (await deps.review()).postComment({
      pullRequestId: pr.id,
      repositoryName: pr.repository,
      beforeCommitId: pr.destinationCommit,
      afterCommitId: pr.sourceCommit,
      content: body,
      location: action.location,
    });
    return { pr, action, commentId: idOf(comment) };
  }
  const review = await deps.review();
  switch (action.kind) {
    case "reply": {
      await findComment(pr, action.commentId, review);
      const body = await commentBody(opts, "", deps);
      const comment = await review.postCommentReply({ inReplyTo: action.commentId, content: body });
      return { pr, action, commentId: idOf(comment) };
    }
    case "edit": {
      const old = await findComment(pr, action.commentId, review);
      if (old.deleted) throw new UserError(`Comment ${action.commentId} is deleted.`);
      const body = await commentBody(opts, old.content ?? "", deps);
      if (body === (old.content ?? "").trim())
        throw new UserError("Aborted: the comment is unchanged.");
      await review.updateComment({ commentId: action.commentId, content: body });
      return { pr, action, commentId: action.commentId };
    }
    default: {
      const old = await findComment(pr, action.commentId, review);
      if (old.deleted) throw new UserError(`Comment ${action.commentId} is already deleted.`);
      const what = `${shortArn(old.authorArn ?? "")}: ${head((old.content ?? "").split("\n")[0] ?? "", 60)}`;
      if (!action.yes && !(await deps.confirm(`Delete comment ${action.commentId} (${what})?`))) {
        throw new UserError("Aborted: the comment was not deleted.");
      }
      await review.deleteComment({ commentId: action.commentId });
      return { pr, action, commentId: action.commentId };
    }
  }
}

function idOf(comment: Comment): string {
  if (!comment.commentId) throw new Error("CodeCommit returned no comment id");
  return comment.commentId;
}

/** Every revision's comments on the PR, threaded as the review screen shows them. */
export function loadComments(pr: PullRequest, review: CommentApi): Promise<CommentThread[]> {
  return review.getComments(pr.id, pr.sourceCommit);
}

async function findComment(pr: PullRequest, id: string, review: CommentApi): Promise<Comment> {
  const threads = await loadComments(pr, review);
  const comment = threads.flatMap((t) => t.comments).find((c) => c.commentId === id);
  if (!comment) {
    throw new UserError(
      `#${pr.id} has no comment ${id}. Run \`lazycc pr view ${pr.id} --comments\` for the ids.`,
    );
  }
  return comment;
}
