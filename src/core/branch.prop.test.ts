import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fakeApi, fakeGit, pullRequest } from "../testing/fakes.js";
import { loadBranchTable } from "./branch.js";

// spec: 状態の判定, written out independently and checked against generated
// branches and pull requests. Small pools of names and commits make
// collisions (several PRs per branch, a tip matching an old PR) common.
const name = fc.constantFrom("main", "a", "b", "c");
const commit = fc.constantFrom("c1", "c2", "c3");
const pr = fc.record({
  status: fc.constantFrom("OPEN", "CLOSED"),
  isMerged: fc.boolean(),
  sourceBranch: name,
  sourceCommit: commit,
  activity: fc.integer({ min: 0, max: 50 }),
});

describe("branch state", () => {
  it("follows the spec's table for any branches and PRs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.record({ name, tip: commit }), { selector: (b) => b.name, minLength: 1 }),
        fc.array(pr, { maxLength: 8 }),
        fc.integer({ min: 1, max: 5 }),
        fc.boolean(),
        async (branches, specs, lookback, clone) => {
          const prs = specs.map((s, i) =>
            pullRequest({
              id: String(i + 1),
              status: s.status,
              isMerged: s.status === "CLOSED" && s.isMerged,
              sourceBranch: s.sourceBranch,
              sourceCommit: s.sourceCommit,
              lastActivityDate: new Date(s.activity * 1000),
            }),
          );
          const api = fakeApi(prs, {
            listBranches: async () => branches.map((b) => b.name),
            branchCommit: async (_r, n) => branches.find((b) => b.name === n)?.tip,
          });
          const git = fakeGit({
            remoteBranches: async () =>
              branches.map((b) => ({ ...b, date: new Date(0), author: "x" })),
          });
          const table = await loadBranchTable({
            api,
            git,
            ctx: { repository: "demo", ...(clone ? { clone: { root: "/w" } } : {}) },
            config: { branch: { closedPrLookback: lookback } },
          });

          // The service lists PRs in its own order; only the first `lookback` closed ones count.
          const recentClosed = prs.filter((p) => p.status === "CLOSED").slice(0, lookback);
          const byActivity = (list: typeof prs) =>
            list.toSorted((x, y) => y.lastActivityDate.getTime() - x.lastActivityDate.getTime());
          expect(table.rows.map((r) => r.name).toSorted()).toEqual(
            branches.map((b) => b.name).toSorted(),
          );
          for (const b of branches) {
            const row = table.rows.find((r) => r.name === b.name);
            const open = byActivity(
              prs.filter((p) => p.status === "OPEN" && p.sourceBranch === b.name),
            );
            const merged = byActivity(
              recentClosed.filter(
                (p) => p.isMerged && p.sourceBranch === b.name && p.sourceCommit === b.tip,
              ),
            );
            const want = open.length ? "open" : merged.length ? "merged" : "none";
            expect(row?.state, JSON.stringify({ b, prs: specs, lookback })).toBe(want);
            expect(row?.pr?.id).toBe((open[0] ?? merged[0])?.id);
            expect(row?.isDefault).toBe(b.name === "main");
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
