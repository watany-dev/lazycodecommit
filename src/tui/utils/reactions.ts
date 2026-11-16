import type { CommentThread } from "../../core/review.js";

/**
 * The comments worth a GetCommentReactions call. CodeCommit counts each
 * comment's reactions in GetCommentsForPullRequest, so one with no counts is
 * skipped; a comment without the field is read, since nothing says it has none.
 */
export function reactedCommentIds(threads: readonly CommentThread[]): string[] {
  return threads.flatMap((t) =>
    t.comments.flatMap((c) => {
      if (!c.commentId) return [];
      const counts = c.reactionCounts;
      return !counts || Object.values(counts).some((n) => n > 0) ? [c.commentId] : [];
    }),
  );
}
