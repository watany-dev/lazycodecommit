import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CommentDraft, parseDrafts } from "./commentDrafts.js";

const id = fc.string({ minLength: 1 });
const commits = { beforeCommitId: id, afterCommitId: id };
const target = fc.oneof(
  fc.constant({ kind: "general" as const }),
  fc.record({
    kind: fc.constant("inline" as const),
    location: fc.record({
      filePath: id,
      filePosition: fc.integer({ min: 1 }),
      relativeFileVersion: fc.constantFrom("BEFORE" as const, "AFTER" as const),
      lineText: fc.string(),
    }),
  }),
  fc.record({
    kind: fc.constant("reply" as const),
    inReplyTo: id,
    replyTo: fc.record({ author: fc.string(), excerpt: fc.string() }),
  }),
);
const draft: fc.Arbitrary<CommentDraft> = fc.record(
  {
    id,
    token: id,
    content: id,
    createdAt: id,
    target,
    ...commits,
    sent: fc.record(commits),
    problem: fc.record({
      kind: fc.constantFrom("failed" as const, "unknown" as const, "moved" as const),
      message: fc.string(),
    }),
  },
  {
    requiredKeys: [
      "id",
      "token",
      "content",
      "createdAt",
      "target",
      "beforeCommitId",
      "afterCommitId",
    ],
  },
);

describe("parseDrafts (drafts.json is a file anyone with the account can edit)", () => {
  it("keeps every whole draft as it was written", () => {
    fc.assert(
      fc.property(fc.array(draft), (drafts) => {
        expect(parseDrafts(JSON.parse(JSON.stringify(drafts)))).toEqual(drafts);
      }),
    );
  });

  it("never throws, and returns only drafts it could read back the same", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const out = parseDrafts(raw);
        expect(parseDrafts(JSON.parse(JSON.stringify(out)))).toEqual(out);
      }),
    );
  });

  it("drops a draft with one field broken, and keeps its neighbours", () => {
    fc.assert(
      fc.property(
        draft,
        draft,
        fc.constantFrom("id", "token", "content", "createdAt", "target", "afterCommitId"),
        fc.oneof(fc.constant(null), fc.integer(), fc.constant("")),
        (good, other, key, junk) => {
          const broken = { ...other, [key]: junk };
          expect(parseDrafts(JSON.parse(JSON.stringify([broken, good])))).toEqual([good]);
        },
      ),
    );
  });
});
