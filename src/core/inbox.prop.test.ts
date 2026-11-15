import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fakeApi, pullRequest } from "../testing/fakes.js";
import { fetchInbox, type InboxItem, inApprovalPool } from "./inbox.js";

const ruleWith = (members: string[]) => ({
  name: "r",
  content: JSON.stringify({
    Version: "2018-11-08",
    Statements: [{ Type: "Approvers", NumberOfApprovalsNeeded: 1, ApprovalPoolMembers: members }],
  }),
});

// The oracle: the wildcard rules as a direct recursive definition, not the
// implementation's greedy backtracking.
const matches = (p: string, t: string): boolean => {
  if (p === "") return t === "";
  if (p[0] === "*") return matches(p.slice(1), t) || (t !== "" && matches(p, t.slice(1)));
  return t !== "" && (p[0] === "?" || p[0] === t[0]) && matches(p.slice(1), t.slice(1));
};

describe("approval pool ARN patterns", () => {
  it("match exactly when * and ? as wildcards would", () => {
    const alphabet = fc.constantFrom("a", "b", ":", "/", ".");
    fc.assert(
      fc.property(
        fc.string({ unit: fc.oneof(alphabet, fc.constantFrom("*", "?")), maxLength: 10 }),
        fc.string({ unit: alphabet, maxLength: 12 }),
        (tail, meTail) => {
          const pattern = `arn:${tail}`;
          const me = `arn:${meTail}`;
          const pr = pullRequest({ approvalRules: [ruleWith([pattern])] });
          expect(inApprovalPool(pr, me), JSON.stringify({ pattern, me })).toBe(
            matches(pattern, me),
          );
        },
      ),
      { numRuns: 5000 },
    );
  });
});

// A model of the region: repositories, their PRs, and which repositories fail to list.
const REPOS = ["a", "b", "c"] as const;
const ME_ARN = "arn:aws:iam::123456789012:user/me";
const OTHER = "arn:aws:iam::123456789012:user/alice";
const rank = (s: string) => (s === "awaiting" ? 0 : 1);

describe("fetchInbox against a model of the region", () => {
  it("lists every open PR of the watched repositories exactly once, sorted", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            repository: fc.constantFrom(...REPOS),
            mine: fc.boolean(),
            open: fc.boolean(),
            at: fc.integer({ min: 0, max: 5 }),
          }),
          { maxLength: 12 },
        ),
        // The config's repos as a user may write them, repeats included.
        fc.array(fc.constantFrom(...REPOS), { minLength: 1, maxLength: 5 }),
        fc.subarray<string>([...REPOS]),
        fc.integer({ min: 1, max: 4 }),
        async (specs, watched, broken, concurrency) => {
          const prs = specs.map((s, i) =>
            pullRequest({
              id: String(i + 1),
              repository: s.repository,
              authorArn: s.mine ? ME_ARN : OTHER,
              status: s.open ? "OPEN" : "CLOSED",
              lastActivityDate: new Date(s.at * 1000),
            }),
          );
          const api = fakeApi(prs, {
            listPullRequestIds: async (repo, status, limit) => {
              if (broken.includes(repo)) throw new Error(`no ${repo}`);
              return prs
                .filter((p) => p.repository === repo && p.status === status)
                .map((p) => p.id)
                .slice(0, limit);
            },
          });
          const deps = { api, me: ME_ARN, region: "r", seen: new Map(), concurrency };
          const reachable = new Set<string>(watched.filter((r) => !broken.includes(r)));
          if (reachable.size === 0) {
            await expect(fetchInbox(watched, deps)).rejects.toThrow();
            return;
          }
          const inbox = await fetchInbox(watched, deps);
          const expected = prs.filter((p) => p.status === "OPEN" && reachable.has(p.repository));
          expect(inbox.items.map((i) => i.pr.id).toSorted()).toEqual(
            expected.map((p) => p.id).toSorted(),
          );
          expect(inbox.errors.map((e) => e.repository).toSorted()).toEqual(
            [...new Set(watched.filter((r) => broken.includes(r)))].toSorted(),
          );
          for (let i = 1; i < inbox.items.length; i++) {
            const [a, b] = [inbox.items[i - 1], inbox.items[i]] as [InboxItem, InboxItem];
            expect(
              rank(a.section) < rank(b.section) ||
                (a.section === b.section &&
                  a.pr.lastActivityDate.getTime() >= b.pr.lastActivityDate.getTime()),
            ).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
