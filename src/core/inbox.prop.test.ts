import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pullRequest } from "../testing/fakes.js";
import { inApprovalPool } from "./inbox.js";

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
