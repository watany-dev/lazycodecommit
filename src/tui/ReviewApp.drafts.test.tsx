import { render } from "ink-testing-library";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CommentDraft, type DraftStorage, newDraft } from "../core/commentDrafts.js";
import type { ReviewService } from "../core/review.js";
import { App } from "./ReviewApp.js";

const OLD_TIP = { destinationCommit: "dest1", sourceCommit: "src1" };

function detail(tip = OLD_TIP, after = "x\ny\n") {
  return {
    pullRequest: {
      pullRequestId: "42",
      title: "fix: login",
      authorArn: "arn:aws:iam::111122223333:user/alice",
      revisionId: "rev",
      pullRequestTargets: [
        { ...tip, destinationReference: "refs/heads/main", sourceReference: "refs/heads/fix" },
      ],
    },
    differences: [
      {
        changeType: "M" as const,
        beforeBlob: { blobId: "before", path: "a.ts" },
        afterBlob: { blobId: `after-${tip.sourceCommit}`, path: "a.ts" },
      },
    ],
    commentThreads: [],
    blobs: { before: "x\n", [`after-${tip.sourceCommit}`]: after } as Record<string, string>,
  };
}

function setup(stored: CommentDraft[] = [], threads: unknown[] = []) {
  let current = { ...detail(), commentThreads: threads };
  const saved: (readonly CommentDraft[])[] = [];
  const storage: DraftStorage = {
    load: vi.fn(async () => stored),
    save: vi.fn(async (_id, list) => {
      saved.push(list);
    }),
  };
  const service = {
    getPullRequestDetail: vi.fn(async () => current),
    getBlobContent: vi.fn(async (_repo: string, id: string) => current.blobs[id] ?? ""),
    getComments: vi.fn(async () => []),
    getReactionsForComments: vi.fn(async () => new Map()),
    getCommitsForPR: vi.fn(async () => []),
    getApprovalStates: vi.fn(async () => []),
    evaluateApprovalRules: vi.fn(async () => null),
    postComment: vi.fn(async () => ({ commentId: "new" })),
    postCommentReply: vi.fn(async () => ({ commentId: "new" })),
    drafts: storage,
  };
  const app = render(
    <App
      service={service as unknown as ReviewService}
      repository="repo"
      start={{ pullRequestId: "42" }}
    />,
  );
  return {
    ...app,
    service,
    storage,
    saved,
    moveTip(after: string) {
      current = detail({ destinationCommit: "dest1", sourceCommit: "src2" }, after);
    },
  };
}

const frame = (t: { lastFrame: () => string | undefined }) => t.lastFrame() ?? "";
async function see(t: { lastFrame: () => string | undefined }, text: string) {
  await vi.waitFor(() => expect(frame(t)).toContain(text));
}
async function type(t: { stdin: { write: (s: string) => void } }, ...keys: string[]) {
  for (const k of keys) {
    t.stdin.write(k);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Writes an inline draft on the added line "y" with Tab. */
async function draftOnAddedLine(t: ReturnType<typeof setup>, text: string) {
  await see(t, "+y");
  await type(t, "]", "c", "C");
  await see(t, "Inline comment on a.ts:2");
  await type(t, text, "\t");
  await see(t, "Drafts: 1");
}

describe("comment drafts on the review screen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keys drafts by the PR's account too: PR ids repeat across accounts", async () => {
    const t = setup();
    await see(t, "PR #42");
    await vi.waitFor(() => expect(t.storage.load).toHaveBeenCalledWith("111122223333/42"));
    await type(t, "c");
    await see(t, "Tab save as draft");
    await type(t, "later", "\t");
    await see(t, "Drafts: 1 (D)");
    expect(t.storage.save).toHaveBeenLastCalledWith("111122223333/42", expect.any(Array));
  });

  it("keeps a general comment as a draft with Tab instead of posting it", async () => {
    const t = setup();
    await see(t, "PR #42");
    await type(t, "c");
    await see(t, "Tab save as draft");
    await type(t, "later", "\t");
    await see(t, "Drafts: 1 (D)");
    expect(t.service.postComment).not.toHaveBeenCalled();
    expect(t.saved.at(-1)).toEqual([
      expect.objectContaining({
        content: "later",
        target: { kind: "general" },
        beforeCommitId: "dest1",
        afterCommitId: "src1",
      }),
    ]);
  });

  it("brings back the drafts saved for the PR", async () => {
    const stored = newDraft(
      "from yesterday",
      { kind: "general" },
      {
        beforeCommitId: "dest1",
        afterCommitId: "src1",
      },
    );
    const t = setup([stored]);
    await see(t, "Drafts: 1 (D)");
    expect(t.storage.load).toHaveBeenCalledWith("111122223333/42");
    await type(t, "D");
    await see(t, "[comment] from yesterday");
  });

  it("posts them all, in order, each with its own token", async () => {
    const t = setup();
    await draftOnAddedLine(t, "inline one");
    await type(t, "c", "general two", "\t");
    await see(t, "Drafts: 2");
    await type(t, "D");
    await see(t, "a.ts:2");
    expect(frame(t)).toContain("[comment]");
    await type(t, "S");
    await see(t, "Post 2 drafts, one comment at a time?");
    await type(t, "y");
    await vi.waitFor(() => expect(t.service.postComment).toHaveBeenCalledTimes(2));
    const [inline, general] = t.saved.find((list) => list.length === 2)!;
    expect(t.service.postComment.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({
        content: "inline one",
        clientRequestToken: inline!.token,
        afterCommitId: "src1",
        location: { filePath: "a.ts", filePosition: 2, relativeFileVersion: "AFTER" },
      }),
      expect.objectContaining({ content: "general two", clientRequestToken: general!.token }),
    ]);
    await see(t, "Drafts (0)");
    expect(t.saved.at(-1)).toEqual([]);
    expect(t.service.getComments).toHaveBeenCalled();
  });

  it("stops at a refusal, says how many went out, and keeps the rest", async () => {
    const t = setup();
    await see(t, "PR #42");
    await type(t, "c", "one", "\t", "c", "two", "\t");
    await see(t, "Drafts: 2");
    const refusal = Object.assign(new Error("too long"), { $metadata: { httpStatusCode: 400 } });
    t.service.postComment.mockResolvedValueOnce({ commentId: "1" }).mockRejectedValueOnce(refusal);
    await type(t, "D", "S", "y");
    await see(t, "Posted 1. Stopped at a draft: too long");
    await type(t, " ");
    await see(t, "Not posted: too long");
    expect(t.saved.at(-1)?.map((d) => d.content)).toEqual(["two"]);
  });

  it("holds back an inline draft whose line changed in new commits until p", async () => {
    const t = setup();
    await draftOnAddedLine(t, "about y");
    t.moveTip("x\nz\n");
    await type(t, "D", "S", "y");
    // The PR is read again to show the new commits, with the list still open.
    await see(t, "+z");
    await see(t, "1 draft points at a line that changed");
    expect(t.service.postComment).not.toHaveBeenCalled();
    await type(t, " ");
    await see(t, "Line moved");
    await type(t, "p");
    await vi.waitFor(() => expect(frame(t)).not.toContain("Line moved"));
    await type(t, "S", "y");
    await vi.waitFor(() =>
      expect(t.service.postComment).toHaveBeenCalledWith(
        expect.objectContaining({ afterCommitId: "src2", content: "about y" }),
      ),
    );
  });

  it("posts on the new tip when the commented line still reads the same", async () => {
    const t = setup();
    await draftOnAddedLine(t, "about y");
    t.moveTip("x\ny\nmore\n");
    await type(t, "D", "S", "y");
    await vi.waitFor(() =>
      expect(t.service.postComment).toHaveBeenCalledWith(
        expect.objectContaining({ afterCommitId: "src2" }),
      ),
    );
  });

  it("edits and discards drafts from the list", async () => {
    const t = setup();
    await see(t, "PR #42");
    await type(t, "c", "frist", "\t", "c", "second", "\t");
    await type(t, "D");
    await see(t, "Drafts (2)");
    await type(t, "e");
    await see(t, "Edit draft:");
    await type(t, ..."\u007f".repeat(5).split(""), "first", "\r");
    await see(t, "> [comment] first");
    await type(t, "j", "d");
    await see(t, "Discard this draft?");
    await type(t, "y");
    await see(t, "Drafts (1)");
    expect(t.saved.at(-1)?.map((d) => d.content)).toEqual(["first"]);
  });

  it("will not edit a draft that may already be posted", async () => {
    const t = setup();
    await see(t, "PR #42");
    await type(t, "c", "one", "\t");
    t.service.postComment.mockRejectedValueOnce(new Error("socket hang up"));
    await type(t, "D", "S", "y");
    await see(t, "Stopped at a draft: socket hang up");
    await type(t, " ", "e");
    await see(t, "press S to settle it before editing");
    await type(t, "S", "y");
    await vi.waitFor(() => expect(t.service.postComment).toHaveBeenCalledTimes(2));
    const tokens = t.service.postComment.mock.calls.map(
      (c) => ((c as unknown[])[0] as { clientRequestToken: string }).clientRequestToken,
    );
    expect(tokens[0]).toBe(tokens[1]);
  });

  it("keeps a reply as a draft and posts it as a reply with its token", async () => {
    const t = setup(
      [],
      [
        {
          location: null,
          comments: [{ commentId: "c1", content: "why?", authorArn: "arn:aws:iam::1:user/bob" }],
        },
      ],
    );
    await see(t, "why?");
    await type(t, "G", "R");
    await see(t, "Replying to bob");
    await type(t, "because", "\t", "D");
    await see(t, "↪ bob because");
    await type(t, "S", "y");
    await vi.waitFor(() =>
      expect(t.service.postCommentReply).toHaveBeenCalledWith({
        inReplyTo: "c1",
        content: "because",
        clientRequestToken: expect.any(String),
      }),
    );
  });

  it("says why posting could not start", async () => {
    const t = setup();
    await see(t, "PR #42");
    await type(t, "c", "one", "\t");
    t.service.getPullRequestDetail.mockRejectedValueOnce(new Error("offline"));
    await type(t, "D", "S", "y");
    await see(t, "offline");
    expect(t.service.postComment).not.toHaveBeenCalled();
  });

  it("shows when drafts cannot be written to disk", async () => {
    const t = setup();
    vi.mocked(t.storage.save).mockRejectedValueOnce(new Error("EACCES"));
    await see(t, "PR #42");
    await type(t, "c", "one", "\t");
    await see(t, "Drafts not saved:");
    expect(frame(t)).toContain("Drafts: 1");
  });
});
