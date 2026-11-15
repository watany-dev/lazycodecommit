import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CommentThread } from "../../core/review.js";
import {
  buildDisplayLines,
  COMMENT_LINE_TYPES,
  countLines,
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
