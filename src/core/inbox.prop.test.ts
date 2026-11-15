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

// The oracle: the same wildcard rules through a RegExp built from escaped pieces.
const asRegExp = (pattern: string) =>
  new RegExp(
    `^${[...pattern].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\/]/g, "\\$&"))).join("")}$`,
    "s",
  );

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
            asRegExp(pattern).test(me),
          );
        },
      ),
      { numRuns: 5000 },
    );
  });
});
