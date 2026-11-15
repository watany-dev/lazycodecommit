import {
  CodeCommitClient,
  type Comment,
  GetCommentsForPullRequestCommand,
} from "@aws-sdk/client-codecommit";
import { mockClient } from "aws-sdk-client-mock";
import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createReviewApi } from "./review.js";

const cc = mockClient(CodeCommitClient);
afterEach(() => cc.reset());

/** The comment a reply chain ends at within `group`, as the oracle: no shortcuts, a step limit. */
function oracleRoot(group: Comment[], c: Comment): string | undefined {
  let at = c;
  for (let i = 0; i <= group.length; i++) {
    const parent = group.find((p) => p.commentId === at.inReplyTo);
    if (!at.inReplyTo || !parent) return at.commentId;
    at = parent;
  }
  return undefined; // a cycle: any member may stand as the root
}

describe("getComments", () => {
  it("puts every comment in exactly one thread, under the comment its replies lead to", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Each comment answers nothing, an earlier comment, or one not in the group.
        fc.array(fc.option(fc.integer({ min: -1, max: 20 }), { nil: undefined }), {
          maxLength: 12,
        }),
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 12 }),
        async (parents, hours) => {
          cc.reset();
          const group: Comment[] = parents.map((p, i) => ({
            commentId: `c${i}`,
            creationDate: new Date((hours[i] ?? 0) * 3_600_000),
            ...(p === undefined ? {} : { inReplyTo: p === -1 ? "elsewhere" : `c${p}` }),
          }));
          cc.on(GetCommentsForPullRequestCommand).resolves({
            commentsForPullRequestData: [{ comments: group }],
          });
          const api = createReviewApi(new CodeCommitClient({ region: "us-east-1" }));
          const threads = await api.getComments("1");
          const ids = threads.flatMap((t) => t.comments.map((c) => c.commentId));
          expect(ids.toSorted()).toEqual(group.map((c) => c.commentId).toSorted());
          for (const t of threads) {
            const [root, ...replies] = t.comments as [Comment, ...Comment[]];
            for (const r of replies) {
              const want = oracleRoot(group, r);
              if (want !== undefined) expect(want).toBe(root.commentId);
            }
            const times = replies.map((r) => r.creationDate?.getTime() ?? 0);
            expect(times).toEqual(times.toSorted((a, b) => a - b));
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
