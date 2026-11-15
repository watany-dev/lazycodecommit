import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pullRequest } from "../testing/fakes.js";
import { listLines, statusLines, viewLines } from "./format.js";

// Titles and descriptions are written by other people and printed to the
// user's terminal, so text output must not carry control characters through.
const anyText = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\x1b", "\x9b", "\x07", "\r", "\n", "\t", "\x7f", "]", "[", "2", "J"),
    fc.string({ minLength: 1, maxLength: 1, unit: "binary" }),
  ),
});
// C0, DEL and C1. Each output element is one line, so \n counts too.
// oxlint-disable-next-line no-control-regex -- finding them is the point
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

describe("text output with hostile titles and descriptions", () => {
  it("contains no control characters", () => {
    fc.assert(
      fc.property(anyText, anyText, anyText, (title, description, rule) => {
        const pr = pullRequest({ title, description });
        // A description keeps its line breaks and tabs; every other field is one line.
        for (const line of viewLines(pr, "us-east-1").flatMap((l) => l.split("\n")))
          expect(line.replaceAll("\t", "")).not.toMatch(CONTROL);
        const lines = [
          ...listLines([pr, pullRequest({ id: "2" })]),
          ...statusLines(
            {
              branch: "topic",
              pr,
              approvers: [],
              rules: { approved: false, overridden: false, satisfied: [rule], notSatisfied: [] },
              mergeable: true,
            },
            "us-east-1",
          ),
        ];
        for (const line of lines) expect(line).not.toMatch(CONTROL);
      }),
    );
  });

  it("keeps the description's line breaks in pr view", () => {
    const lines = viewLines(pullRequest({ description: "one\r\ntwo\n\tthree" }), "us-east-1");
    expect(lines).toContain("one\ntwo\n\tthree");
  });
});

// Wide (CJK) characters take two terminal cells; the test's own rule.
const cells = (s: string) =>
  [...s].reduce((n, ch) => n + ((ch.codePointAt(0) as number) >= 0x3000 ? 2 : 1), 0);

describe("pr list columns", () => {
  it("line up in terminal cells, with Japanese titles too", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ unit: fc.constantFrom("a", "Z", " ", "日", "本", "語", "ア", "！") }),
          { minLength: 1, maxLength: 5 },
        ),
        (titles) => {
          const lines = listLines(
            titles.map((title, i) => pullRequest({ id: String(i + 1), title })),
          );
          // The last column (an ISO date) has a fixed width, so aligned rows are equally wide.
          expect(new Set(lines.map(cells)).size).toBe(1);
        },
      ),
    );
  });

  it("line up with emoji (gitmoji) and combining marks in titles", () => {
    // What a terminal shows: emoji take two cells, combining marks none.
    const width: Record<string, number> = {
      a: 1,
      "🚀": 2,
      "✅": 2,
      "✨": 2,
      "🐛": 2,
      "́": 0,
      "゙": 0,
      "️": 0,
    };
    const emojiCells = (s: string) => [...s].reduce((n, ch) => n + (width[ch] ?? 1), 0);
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: fc.constantFrom(...Object.keys(width)) }), {
          minLength: 1,
          maxLength: 5,
        }),
        (titles) => {
          const lines = listLines(
            titles.map((title, i) => pullRequest({ id: String(i + 1), title: `x${title}` })),
          );
          expect(new Set(lines.map(emojiCells)).size).toBe(1);
        },
      ),
    );
  });
});
