import type { Difference } from "@aws-sdk/client-codecommit";
import { describe, expect, it } from "vitest";
import type { CommentThread, ReactionsByComment } from "../../core/review.js";
import { buildDisplayLines, diffLimitKey, getThreadKey } from "./displayLines.js";

const NO_REACTIONS: ReactionsByComment = new Map();

function makeDiff(): {
  differences: Difference[];
  diffTexts: Map<string, { before: string; after: string }>;
  diffTextStatus: Map<string, "loading" | "loaded" | "error">;
  blobKey: string;
} {
  const differences: Difference[] = [
    {
      beforeBlob: { blobId: "b1", path: "src/a.ts" },
      afterBlob: { blobId: "a1", path: "src/a.ts" },
      changeType: "M",
    },
  ];
  const blobKey = "b1:a1";
  const diffTexts = new Map([[blobKey, { before: "old1\nold2", after: "new1\nnew2" }]]);
  const diffTextStatus = new Map<string, "loading" | "loaded" | "error">([[blobKey, "loaded"]]);
  return { differences, diffTexts, diffTextStatus, blobKey };
}

describe("buildDisplayLines inline threads", () => {
  it("anchors BEFORE-version threads and renders multiple threads on the same line", () => {
    const { differences, diffTexts, diffTextStatus } = makeDiff();
    // Two threads anchored to the same BEFORE line (filePosition 1) on the same file.
    const commentThreads: CommentThread[] = [
      {
        location: { filePath: "src/a.ts", filePosition: 1, relativeFileVersion: "BEFORE" },
        comments: [{ commentId: "c1", content: "first", authorArn: "arn:aws:iam::1:user/alice" }],
      },
      {
        location: { filePath: "src/a.ts", filePosition: 1, relativeFileVersion: "BEFORE" },
        comments: [{ commentId: "c2", content: "second", authorArn: "arn:aws:iam::1:user/bob" }],
      },
    ];

    const lines = buildDisplayLines(
      differences,
      diffTexts,
      diffTextStatus,
      new Map(),
      commentThreads,
      new Map(),
      NO_REACTIONS,
    );

    const inlineTexts = lines.filter((l) => l.type === "inline-comment").map((l) => l.text);
    expect(inlineTexts).toContain("💬 alice: first");
    expect(inlineTexts).toContain("💬 bob: second");
  });
});

describe("buildDisplayLines earlier revisions", () => {
  it("lists inline threads from before a push apart, with where they were written", () => {
    const { differences, diffTexts, diffTextStatus } = makeDiff();
    const commentThreads: CommentThread[] = [
      {
        location: { filePath: "src/a.ts", filePosition: 1, relativeFileVersion: "AFTER" },
        comments: [{ commentId: "c1", content: "now", authorArn: "arn:aws:iam::1:user/alice" }],
      },
      {
        location: { filePath: "src/a.ts", filePosition: 1, relativeFileVersion: "AFTER" },
        outdated: true,
        comments: [{ commentId: "c2", content: "then", authorArn: "arn:aws:iam::1:user/bob" }],
      },
      {
        location: { filePath: "src/a.ts", filePosition: 2, relativeFileVersion: "BEFORE" },
        outdated: true,
        comments: [{ commentId: "c3", content: "old", authorArn: "arn:aws:iam::1:user/bob" }],
      },
    ];

    const lines = buildDisplayLines(
      differences,
      diffTexts,
      diffTextStatus,
      new Map(),
      commentThreads,
      new Map(),
      NO_REACTIONS,
    );

    expect(lines.filter((l) => l.type === "inline-comment").map((l) => l.text)).toEqual([
      "💬 alice: now",
    ]);
    const at = lines.findIndex((l) => l.text === "Earlier revisions (2):");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1).map((l) => [l.type, l.text, l.threadIndex])).toEqual([
      ["comment-header", "src/a.ts:1", undefined],
      ["comment", "bob: then", 1],
      ["comment-header", "src/a.ts:2 (old)", undefined],
      ["comment", "bob: old", 2],
    ]);
  });
});

describe("buildDisplayLines diff cache", () => {
  it("keeps each file's own filePath when two files share identical blob ids", () => {
    // Two files added in one PR with the same content have the same afterBlob id
    // and no beforeBlob, so their blob keys collide.
    const differences: Difference[] = [
      { afterBlob: { blobId: "E", path: "pkg/a/__init__.py" }, changeType: "A" },
      { afterBlob: { blobId: "E", path: "pkg/b/__init__.py" }, changeType: "A" },
    ];
    const diffTexts = new Map([[":E", { before: "", after: "# package\n" }]]);
    const diffTextStatus = new Map<string, "loading" | "loaded" | "error">([[":E", "loaded"]]);
    const cache = new Map();

    const lines = buildDisplayLines(
      differences,
      diffTexts,
      diffTextStatus,
      new Map(),
      [],
      new Map(),
      NO_REACTIONS,
      cache,
    );

    let currentHeader = "";
    let checked = 0;
    for (const line of lines) {
      if (line.type === "header") {
        currentHeader = line.text;
      } else if (line.type === "add") {
        expect(line.filePath).toBe(currentHeader);
        checked++;
      }
    }
    expect(checked).toBe(2);
  });

  it("returns stable filePath across cached rebuilds", () => {
    const differences: Difference[] = [
      { afterBlob: { blobId: "E", path: "a.txt" }, changeType: "A" },
      { afterBlob: { blobId: "E", path: "b.txt" }, changeType: "A" },
    ];
    const diffTexts = new Map([[":E", { before: "x", after: "x" }]]);
    const diffTextStatus = new Map<string, "loading" | "loaded" | "error">([[":E", "loaded"]]);
    const cache = new Map();
    const build = () =>
      buildDisplayLines(
        differences,
        diffTexts,
        diffTextStatus,
        new Map(),
        [],
        new Map(),
        NO_REACTIONS,
        cache,
      );
    const first = build()
      .filter((l) => l.type === "context")
      .map((l) => l.filePath);
    const second = build()
      .filter((l) => l.type === "context")
      .map((l) => l.filePath);
    expect(first).toEqual(["a.txt", "b.txt"]);
    expect(second).toEqual(["a.txt", "b.txt"]);
  });
});

function buildTruncated(
  before: string,
  after: string,
  limit: number,
): ReturnType<typeof buildDisplayLines> {
  const differences: Difference[] = [
    {
      beforeBlob: { blobId: "b1", path: "f.ts" },
      afterBlob: { blobId: "a1", path: "f.ts" },
      changeType: "M",
    },
  ];
  const blobKey = "b1:a1";
  return buildDisplayLines(
    differences,
    new Map([[blobKey, { before, after }]]),
    new Map([[blobKey, "loaded"]]),
    new Map([[diffLimitKey("f.ts", blobKey), limit]]),
    [],
    new Map(),
    NO_REACTIONS,
  );
}

function contentLineCount(lines: ReturnType<typeof buildDisplayLines>): number {
  return lines.filter((l) => l.type === "add" || l.type === "delete" || l.type === "context")
    .length;
}

describe("buildDisplayLines slice limits", () => {
  it("emits no content lines when totalLimit is 0", () => {
    const lines = buildTruncated("old1\nold2", "new1\nnew2", 0);
    expect(contentLineCount(lines)).toBe(0);
    expect(lines.some((l) => l.type === "truncation")).toBe(true);
  });

  it("emits no content lines when totalLimit is negative", () => {
    const lines = buildTruncated("old1\nold2", "new1", -3);
    expect(contentLineCount(lines)).toBe(0);
    expect(lines.some((l) => l.type === "truncation")).toBe(true);
  });

  it("keeps the full diff when both sides fit in the limit", () => {
    const { differences, diffTexts, diffTextStatus } = makeDiff();
    const lines = buildDisplayLines(
      differences,
      diffTexts,
      diffTextStatus,
      new Map(),
      [],
      new Map(),
      NO_REACTIONS,
    );
    expect(lines.some((l) => l.type === "truncation")).toBe(false);
    expect(contentLineCount(lines)).toBeGreaterThan(0);
  });

  it("splits an over-budget diff and still shows truncation", () => {
    const before = Array.from({ length: 10 }, (_, i) => `before-${i}`).join("\n");
    const after = Array.from({ length: 2 }, (_, i) => `after-${i}`).join("\n");
    const lines = buildTruncated(before, after, 6);
    expect(lines.some((l) => l.text.includes("truncated 6/12"))).toBe(true);
    expect(contentLineCount(lines)).toBeLessThan(12);
    expect(contentLineCount(lines)).toBeGreaterThan(0);
  });

  it("gives leftover budget to the before side when after is smaller than its share", () => {
    // 10 before + 1 after, limit 8: after cannot absorb rounding remainder.
    const before = Array.from({ length: 10 }, (_, i) => `b${i}`).join("\n");
    const after = "only-after";
    const lines = buildTruncated(before, after, 8);
    expect(lines.some((l) => l.text.includes("truncated 8/11"))).toBe(true);
    expect(contentLineCount(lines)).toBeLessThan(11);
  });
});

const diffLines = (before: string, after: string, beforeId = "b", afterId = "a") => {
  const differences: Difference[] = [
    {
      ...(beforeId ? { beforeBlob: { blobId: beforeId, path: "f" } } : {}),
      ...(afterId ? { afterBlob: { blobId: afterId, path: "f" } } : {}),
    },
  ];
  const key = `${beforeId}:${afterId}`;
  return buildDisplayLines(
    differences,
    new Map([[key, { before, after }]]),
    new Map([[key, "loaded" as const]]),
    new Map(),
    [],
    new Map(),
    NO_REACTIONS,
  )
    .filter((l) => ["add", "delete", "context"].includes(l.type))
    .map((l) => [l.text, l.beforeLineNumber, l.afterLineNumber]);
};

describe("buildDisplayLines line endings", () => {
  // A final newline ends the last line; it does not start an empty one that
  // could be commented on past the end of the file.
  it("shows no line after a file's final newline", () => {
    expect(diffLines("a\n", "a\nb\n")).toEqual([
      [" a", 1, 1],
      ["+b", undefined, 2],
    ]);
  });

  it("shows an added file as additions only, and a deleted one as deletions only", () => {
    expect(diffLines("", "x\ny\n", "")).toEqual([
      ["+x", undefined, 1],
      ["+y", undefined, 2],
    ]);
    expect(diffLines("gone", "", "b", "")).toEqual([["-gone", 1, undefined]]);
  });

  it("keeps a last line that has no newline", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      [" a", 1, 1],
      ["+b", undefined, 2],
    ]);
  });
});

const pngThread = (id: string, version: "BEFORE" | "AFTER", filePosition: number) => ({
  location: { filePath: "logo.png", filePosition, relativeFileVersion: version },
  comments: [{ commentId: id, content: id, authorArn: "arn:aws:iam::1:user/alice" }],
});

describe("buildDisplayLines notes", () => {
  it("shows a file's note under its header, on a line that takes no inline comment", () => {
    const differences: Difference[] = [{ afterBlob: { blobId: "a", path: "logo.png" } }];
    const lines = buildDisplayLines(
      differences,
      new Map([[":a", { before: "", after: "", note: "(binary file, 4 bytes)" }]]),
      new Map([[":a", "loaded" as const]]),
      new Map(),
      [],
      new Map(),
      NO_REACTIONS,
    );
    expect(lines.map((l) => l.text)).toEqual([
      "logo.png",
      expect.any(String),
      "(binary file, 4 bytes)",
      "",
    ]);
    expect(lines[2]).toEqual({
      type: "context",
      text: "(binary file, 4 bytes)",
      filePath: "logo.png",
      diffKey: ":a",
    });
  });

  it("shows inline threads on a file with no lines (binary) under its note, in thread order", () => {
    const lines = buildDisplayLines(
      [
        {
          beforeBlob: { blobId: "b", path: "logo.png" },
          afterBlob: { blobId: "a", path: "logo.png" },
        },
      ],
      new Map([["b:a", { before: "", after: "", note: "(binary file, 4 bytes → 5 bytes)" }]]),
      new Map([["b:a", "loaded" as const]]),
      new Map(),
      [pngThread("first", "AFTER", 3), pngThread("second", "BEFORE", 1)],
      new Map(),
      NO_REACTIONS,
    );
    expect(lines.slice(2, 5).map((l) => l.text)).toEqual([
      "(binary file, 4 bytes → 5 bytes)",
      "💬 alice: first",
      "💬 alice: second",
    ]);
  });
});

describe("buildDisplayLines file paths", () => {
  it("makes control characters in a path visible in its header, and keeps the path for the API", () => {
    const path = "a\x1b]52;c;aGk=\x07.txt";
    const differences: Difference[] = [{ afterBlob: { blobId: "E", path }, changeType: "A" }];
    const diffTexts = new Map([[":E", { before: "", after: "x\n" }]]);
    const status = new Map<string, "loading" | "loaded" | "error">([[":E", "loaded"]]);
    const lines = buildDisplayLines(
      differences,
      diffTexts,
      status,
      new Map(),
      [],
      new Map(),
      NO_REACTIONS,
    );
    expect(lines.find((l) => l.type === "header")?.text).toBe("a^[]52;c;aGk=^G.txt");
    expect(lines.find((l) => l.type === "add")?.filePath).toBe(path);
  });
});

describe("buildDisplayLines deleted comments", () => {
  it("marks a deleted comment or reply instead of showing an empty body", () => {
    const commentThreads: CommentThread[] = [
      {
        location: null,
        comments: [
          { commentId: "c1", content: "", deleted: true, authorArn: "arn:aws:iam::1:user/alice" },
          {
            commentId: "c2",
            inReplyTo: "c1",
            content: "",
            deleted: true,
            authorArn: "arn:aws:iam::1:user/bob",
          },
          {
            commentId: "c3",
            inReplyTo: "c1",
            content: "still here",
            authorArn: "arn:aws:iam::1:user/bob",
          },
        ],
      },
    ];
    const lines = buildDisplayLines(
      [],
      new Map(),
      new Map(),
      new Map(),
      commentThreads,
      new Map(),
      NO_REACTIONS,
    );
    const texts = lines
      .filter((l) => l.type === "comment" || l.type === "comment-reply")
      .map((l) => l.text);
    expect(texts).toEqual(["alice: (deleted)", "└ bob: (deleted)", "└ bob: still here"]);
  });
});

const buildWithComments = (
  commentThreads: CommentThread[],
  reactions: ReactionsByComment = NO_REACTIONS,
) => {
  const { differences, diffTexts, diffTextStatus } = makeDiff();
  return buildDisplayLines(
    differences,
    diffTexts,
    diffTextStatus,
    new Map(),
    commentThreads,
    new Map(),
    reactions,
  );
};

describe("buildDisplayLines, comment rows", () => {
  const at = { filePath: "src/a.ts", filePosition: 1, relativeFileVersion: "AFTER" as const };
  const alice = "arn:aws:iam::1:user/alice";

  it("shows a comment without content as empty, and leaves out a thread with no comments", () => {
    const lines = buildWithComments([
      { location: null, comments: [] },
      { location: null, comments: [{ commentId: "c1", authorArn: alice }] },
    ]);
    expect(lines.filter((l) => l.type === "comment").map((l) => l.text)).toEqual(["alice: "]);
  });

  it("indents a comment's further lines under its first, and marks inline replies", () => {
    const lines = buildWithComments([
      {
        location: at,
        comments: [
          { commentId: "r", content: "reply\nmore", authorArn: alice, inReplyTo: "c" },
          { commentId: "c", content: "root", authorArn: alice },
        ],
      },
    ]);
    const thread = lines.filter((l) => l.commentId !== undefined);
    expect(thread.map((l) => [l.type, l.text])).toEqual([
      ["inline-comment", "💬 alice: root"],
      ["inline-reply", "└ alice: reply"],
      ["inline-reply", "  more"],
    ]);
  });

  it("shows the reactions a comment has, and nothing for none", () => {
    const reactions: ReactionsByComment = new Map([
      [
        "c1",
        [
          { emoji: "👍", count: 2 },
          { emoji: "👀", count: 0 },
          { emoji: "🎉", count: 1 },
        ],
      ],
    ]) as unknown as ReactionsByComment;
    const lines = buildWithComments(
      [
        { location: null, comments: [{ commentId: "c1", content: "a", authorArn: alice }] },
        { location: null, comments: [{ commentId: "c2", content: "b", authorArn: alice }] },
      ],
      reactions,
    );
    const comments = lines.filter((l) => l.type === "comment");
    expect(comments.map((l) => l.reactionText)).toEqual(["👍×2 🎉×1", ""]);
  });
});

const manyLines = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n");
const buildFromTexts = (before: string, after: string, limits = new Map<string, number>()) => {
  const { differences, diffTextStatus, blobKey } = makeDiff();
  return buildDisplayLines(
    differences,
    new Map([[blobKey, { before, after }]]),
    diffTextStatus,
    limits,
    [],
    new Map(),
    NO_REACTIONS,
  );
};

describe("buildDisplayLines, diff size", () => {
  it("shows a diff below the large-diff threshold whole, even past one chunk", () => {
    const lines = buildFromTexts(manyLines("a", 200), manyLines("b", 200));
    expect(lines.some((l) => l.type === "truncation")).toBe(false);
    expect(lines.filter((l) => l.type === "add")).toHaveLength(200);
  });

  it("offers only the lines that are left when fewer than a chunk remain", () => {
    const { blobKey } = makeDiff();
    const lines = buildFromTexts(
      manyLines("a", 200),
      manyLines("b", 200),
      new Map([[diffLimitKey("src/a.ts", blobKey), 350]]),
    );
    expect(lines.find((l) => l.type === "truncation")?.text).toBe("[t] show next 50 lines");
  });

  it("counts an unchanged row as a line of each file", () => {
    const { blobKey } = makeDiff();
    const lines = buildFromTexts(
      "x\ny\nz",
      "x\ny\nz",
      new Map([[diffLimitKey("src/a.ts", blobKey), 4]]),
    );
    expect(lines.filter((l) => l.type === "context").map((l) => l.text)).toEqual([" x", " y"]);
  });
});

describe("getThreadKey", () => {
  it("keys a thread by its root comment, wherever it comes, or by its place without one", () => {
    const thread: CommentThread = {
      location: null,
      comments: [{ commentId: "r", inReplyTo: "c" }, { commentId: "c" }],
    };
    expect(getThreadKey(thread, 0)).toBe("c");
    expect(getThreadKey({ location: null, comments: [] }, 3)).toBe("thread-3");
  });
});
