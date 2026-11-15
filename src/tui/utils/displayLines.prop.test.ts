import type { Difference } from "@aws-sdk/client-codecommit";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CommentThread } from "../../core/review.js";
import {
  buildDisplayLines,
  COMMENT_LINE_TYPES,
  countLines,
  diffLimitKey,
  FOLD_THRESHOLD,
} from "./displayLines.js";

const text = fc
  .array(fc.constantFrom("a", "b", "c", ""), { maxLength: 12 })
  .chain((ls) =>
    fc.boolean().map((nl) => (ls.length === 0 ? "" : ls.join("\n") + (nl ? "\n" : ""))),
  );

const diff = {
  beforeBlob: { blobId: "b", path: "f.ts" },
  afterBlob: { blobId: "a", path: "f.ts" },
};

function thread(id: string, size: number, location: CommentThread["location"]): CommentThread {
  return {
    location,
    comments: Array.from({ length: size }, (_, i) => ({
      commentId: i === 0 ? id : `${id}-${i}`,
      authorArn: "arn:aws:iam::1:user/u",
      content: `c${i}`,
      ...(i === 0 ? {} : { inReplyTo: id }),
    })),
  } as CommentThread;
}

describe("buildDisplayLines", () => {
  it("shows every line of both versions and every anchored thread exactly once", () => {
    fc.assert(
      fc.property(
        text,
        text,
        fc.array(
          fc.record({
            version: fc.constantFrom("BEFORE" as const, "AFTER" as const),
            line: fc.integer({ min: 1, max: 14 }),
            size: fc.integer({ min: 1, max: 5 }),
          }),
          { maxLength: 5 },
        ),
        fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 3 }),
        (before, after, inline, general) => {
          const threads = [
            ...inline.map((t, i) =>
              thread(`i${i}`, t.size, {
                filePath: "f.ts",
                filePosition: t.line,
                relativeFileVersion: t.version,
              } as CommentThread["location"]),
            ),
            ...general.map((size, i) => thread(`g${i}`, size, null)),
          ];
          const lines = buildDisplayLines(
            [diff],
            new Map([["b:a", { before, after }]]),
            new Map(),
            new Map(),
            threads,
            new Map(),
            new Map(),
          );
          const diffRows = lines.filter((l) => ["add", "delete", "context"].includes(l.type));
          expect(diffRows.filter((l) => l.type !== "add")).toHaveLength(countLines(before));
          expect(diffRows.filter((l) => l.type !== "delete")).toHaveLength(countLines(after));
          threads.forEach((t, i) => {
            const roots = lines.filter(
              (l) => COMMENT_LINE_TYPES.has(l.type) && l.commentId === t.comments[0]!.commentId,
            );
            const loc = t.location;
            const anchored =
              !loc ||
              loc.filePosition <=
                (loc.relativeFileVersion === "BEFORE" ? countLines(before) : countLines(after));
            expect(roots).toHaveLength(anchored ? 1 : 0);
            const rows = lines.filter((l) => l.threadIndex === i);
            if (anchored) {
              expect(rows).toHaveLength(
                t.comments.length >= FOLD_THRESHOLD ? 2 : t.comments.length,
              );
            }
          });
        },
      ),
      { numRuns: 1500 },
    );
  });
});

const lineArrays = fc.array(fc.constantFrom("a", "b", "c", "d", ""), { maxLength: 30 });

/** A file of these lines; a trailing "x" keeps an empty last line from being read as a final newline. */
const fileOf = (l: string[]) => (l.length === 0 ? "" : `${l.join("\n")}\nx`);

/** The diff rows of one modified file shown with at most `limit` lines (undefined: all). */
function diffRows(before: string[], after: string[], limit?: number): string[] {
  const differences: Difference[] = [
    { beforeBlob: { blobId: "b", path: "f" }, afterBlob: { blobId: "a", path: "f" } },
  ];
  return buildDisplayLines(
    differences,
    new Map([["b:a", { before: fileOf(before), after: fileOf(after) }]]),
    new Map([["b:a", "loaded" as const]]),
    limit === undefined ? new Map() : new Map([[diffLimitKey("f", "b:a"), limit]]),
    [],
    new Map(),
    new Map(),
  )
    .filter((l) => l.type === "add" || l.type === "delete" || l.type === "context")
    .map((l) => `${l.text}|${l.beforeLineNumber}|${l.afterLineNumber}`);
}

describe("buildDisplayLines truncation", () => {
  // A cut-off diff shows the first rows of the whole diff: cutting each side
  // on its own made lines past the cut on one side read as deleted or added.
  it("shows a prefix of the whole diff", () => {
    fc.assert(
      fc.property(lineArrays, lineArrays, fc.nat(80), (before, after, limit) => {
        const all = diffRows(before, after);
        const shown = diffRows(before, after, limit);
        expect(shown).toEqual(all.slice(0, shown.length));
      }),
      { numRuns: 2000 },
    );
  });

  it("does not mark an unchanged line as deleted when the cut falls after an added line", () => {
    const before = ["one", "two", "three", "four"];
    const after = ["new", ...before];
    expect(diffRows(before, after, 4)).not.toContain("-two|2|undefined");
  });
});

describe("buildDisplayLines comments", () => {
  // A row is one terminal line: a comment's newline made one row take
  // several, so the window over the rows ran off the screen.
  it("shows each line of a comment on a row of its own, with the comment's id", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("x", "y", "", " "), { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        (parts, inline) => {
          const content = parts.join("\n");
          const thread = {
            location: inline
              ? { filePath: "f", filePosition: 1, relativeFileVersion: "AFTER" as const }
              : null,
            comments: [{ commentId: "c1", authorArn: "arn:aws:iam::1:user/u", content }],
          };
          const built = buildDisplayLines(
            [{ afterBlob: { blobId: "a", path: "f" } }],
            new Map([[":a", { before: "", after: "line\n" }]]),
            new Map([[":a", "loaded" as const]]),
            new Map(),
            [thread],
            new Map(),
            new Map(),
          );
          const rowsOf = built.filter((l) => l.commentId === "c1");
          expect(rowsOf).toHaveLength(parts.length);
          for (const r of rowsOf) {
            expect(r.text).not.toContain("\n");
            expect(r.threadIndex).toBe(0);
          }
        },
      ),
    );
  });
});
