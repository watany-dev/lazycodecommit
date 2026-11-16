import { describe, expect, it } from "vitest";
import type { CommentThread } from "../../core/review.js";
import { reactedCommentIds } from "./reactions.js";

const thread = (...comments: CommentThread["comments"]): CommentThread => ({
  location: null,
  comments,
});

describe("reactedCommentIds", () => {
  it("skips comments whose reactionCounts count nothing", () => {
    expect(
      reactedCommentIds([
        thread(
          { commentId: "a", reactionCounts: {} },
          { commentId: "b", reactionCounts: { ":thumbsup:": 0 } },
        ),
      ]),
    ).toEqual([]);
  });

  it("keeps comments with a reaction, across threads", () => {
    expect(
      reactedCommentIds([
        thread({ commentId: "a", reactionCounts: { ":thumbsup:": 2 } }),
        thread(
          { commentId: "b", reactionCounts: {} },
          { commentId: "c", reactionCounts: { "🎉": 1 } },
        ),
      ]),
    ).toEqual(["a", "c"]);
  });

  it("keeps a comment without reactionCounts: nothing says it has none", () => {
    expect(reactedCommentIds([thread({ commentId: "a" })])).toEqual(["a"]);
  });

  it("drops comments without an id", () => {
    expect(reactedCommentIds([thread({ reactionCounts: { x: 1 } })])).toEqual([]);
  });
});
