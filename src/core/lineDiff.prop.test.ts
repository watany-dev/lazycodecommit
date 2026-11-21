import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeSimpleDiff } from "./lineDiff.js";

// A small alphabet makes repeated and reordered lines common, which is where
// a greedy diff can go wrong.
const lines = fc.array(fc.constantFrom("a", "b", "c", "d", ""), { maxLength: 30 });

describe("computeSimpleDiff", () => {
  it("is an edit script from before to after with consistent line numbers", () => {
    fc.assert(
      fc.property(lines, lines, (before, after) => {
        const diff = computeSimpleDiff(before, after);
        expect(diff.filter((l) => l.type !== "add").map((l) => l.text.slice(1))).toEqual(before);
        expect(diff.filter((l) => l.type !== "delete").map((l) => l.text.slice(1))).toEqual(after);
        let b = 0;
        let a = 0;
        for (const l of diff) {
          if (l.type !== "add") expect(l.beforeLineNumber).toBe(++b);
          if (l.type !== "delete") expect(l.afterLineNumber).toBe(++a);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
