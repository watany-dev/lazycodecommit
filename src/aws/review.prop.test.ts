import {
  CodeCommitClient,
  type Comment,
  GetCommentsForPullRequestCommand,
  GetCommitCommand,
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

type History = Map<string, string[]>;

function ancestors(history: History, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(history.get(id) ?? []));
  }
  return seen;
}

/** git merge-base: a common ancestor that no other common ancestor descends from. */
function mergeBaseOf(history: History, a: string, b: string): string {
  const inB = ancestors(history, b);
  const common = [...ancestors(history, a)].filter((c) => inB.has(c));
  return common.find((c) => !common.some((d) => d !== c && ancestors(history, d).has(c))) as string;
}

/** git log --first-parent base..head, oldest first. */
function firstParentLog(history: History, base: string, head: string): string[] {
  const excluded = ancestors(history, base);
  const out: string[] = [];
  for (let at: string | undefined = head; at && !excluded.has(at); at = history.get(at)?.[0]) {
    out.push(at);
  }
  return out.toReversed();
}

describe("getCommitsForPR", () => {
  it("lists what git log --first-parent mergeBase..source lists, also after merges", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("main", "feature", "main-into-feature", "feature-into-main"), {
          maxLength: 15,
        }),
        async (ops) => {
          cc.reset();
          const history: History = new Map([["root", []]]);
          let main = "root";
          let feature = "root";
          ops.forEach((op, i) => {
            const id = `c${i}`;
            if (op === "main") history.set(id, [main]);
            if (op === "feature") history.set(id, [feature]);
            if (op === "main-into-feature") history.set(id, [feature, main]);
            if (op === "feature-into-main") history.set(id, [main, feature]);
            if (op === "main" || op === "feature-into-main") main = id;
            else feature = id;
          });
          const base = mergeBaseOf(history, main, feature);
          cc.on(GetCommitCommand).callsFake(({ commitId }: { commitId: string }) => ({
            commit: { commitId, message: commitId, parents: history.get(commitId) },
          }));
          const api = createReviewApi(new CodeCommitClient({ region: "us-east-1" }));
          const commits = await api.getCommitsForPR("repo", feature, base);
          expect(
            commits.map((c) => c.commitId),
            JSON.stringify({ ops, base }),
          ).toEqual(firstParentLog(history, base, feature));
        },
      ),
      { numRuns: 300 },
    );
  });
});

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
