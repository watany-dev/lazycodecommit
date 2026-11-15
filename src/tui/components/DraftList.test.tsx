import React from "react";
import { describe, expect, it, vi } from "vitest";
import { type CommentDraft, newDraft } from "../../core/commentDrafts.js";
import { press, render } from "../../testing/keys.js";
import { DraftList, type DraftSubmitState } from "./DraftList.js";

const commits = { beforeCommitId: "d", afterCommitId: "s" };
const IDLE: DraftSubmitState = {
  isProcessing: false,
  progress: null,
  error: null,
  clearError: () => {},
};

function show(drafts: CommentDraft[], submit: DraftSubmitState = IDLE) {
  const props = {
    onSubmit: vi.fn(),
    onEdit: vi.fn(),
    onDiscard: vi.fn(),
    onPostAnyway: vi.fn(),
    onJump: vi.fn(),
    onClose: vi.fn(),
  };
  const app = render(<DraftList drafts={drafts} submit={submit} {...props} />);
  return { ...app, ...props };
}

const before = newDraft(
  "on the old side",
  {
    kind: "inline",
    location: { filePath: "a.ts", filePosition: 4, relativeFileVersion: "BEFORE", lineText: "x" },
  },
  commits,
);
const reply = newDraft(
  `${"long ".repeat(20)}\nsecond line`,
  { kind: "reply", inReplyTo: "c1", replyTo: { author: "bob\x1b[31m", excerpt: "why" } },
  commits,
);

describe("DraftList", () => {
  it("says how to make a draft when there is none, and closes with q", async () => {
    const t = show([]);
    expect(t.lastFrame()).toContain("No drafts. Press Tab in a comment box");
    expect(t.lastFrame()).not.toContain("S post all");
    await press(t, "S", "q");
    expect(t.onSubmit).not.toHaveBeenCalled();
    expect(t.onClose).toHaveBeenCalledOnce();
  });

  it("shows where each draft goes, with others' text made harmless", () => {
    const frame = show([before, reply]).lastFrame() ?? "";
    expect(frame).toContain("a.ts:4 (old) on the old side");
    expect(frame).toContain("↪ bob^[[31m");
    expect(frame).toContain(`${"long ".repeat(12)}…`);
    expect(frame).not.toContain("second line");
  });

  it("jumps to an inline draft's line with Enter, and not for a reply", async () => {
    const t = show([before, reply]);
    await press(t, "\r");
    expect(t.onJump).toHaveBeenCalledWith(before);
    await press(t, "j", "\r", "k");
    expect(t.onJump).toHaveBeenCalledOnce();
  });

  it("backs out of edit, discard and post without changing anything", async () => {
    const t = show([before]);
    await press(t, "e");
    expect(t.lastFrame()).toContain("Edit draft:");
    await press(t, "\x1b", "d");
    expect(t.lastFrame()).toContain("Discard this draft?");
    await press(t, "n", "S");
    expect(t.lastFrame()).toContain("Post 1 draft, one comment at a time?");
    await press(t, "n");
    expect(t.onEdit).not.toHaveBeenCalled();
    expect(t.onDiscard).not.toHaveBeenCalled();
    expect(t.onSubmit).not.toHaveBeenCalled();
  });

  it("labels each problem", () => {
    const frame =
      show([
        { ...before, problem: { kind: "failed", message: "no such comment" } },
        { ...reply, problem: { kind: "unknown", message: "timeout" } },
      ]).lastFrame() ?? "";
    expect(frame).toContain("Not posted: no such comment");
    expect(frame).toContain("May be posted (S retries safely): timeout");
  });

  it("counts only postable drafts and offers p on a moved one", async () => {
    const moved = { ...before, problem: { kind: "moved" as const, message: "changed" } };
    const t = show([moved]);
    expect(t.lastFrame()).toContain("p post anyway");
    expect(t.lastFrame()).not.toContain("S post all");
    await press(t, "p");
    expect(t.onPostAnyway).toHaveBeenCalledWith(moved.id);
  });

  it("shows progress while posting and ignores keys", async () => {
    const t = show([before], { ...IDLE, isProcessing: true, progress: { done: 1, total: 3 } });
    expect(t.lastFrame()).toContain("Posting drafts 2/3...");
    await press(t, "q");
    expect(t.onClose).not.toHaveBeenCalled();
  });

  it("clears the last run's message on any key", async () => {
    const clearError = vi.fn();
    const t = show([before], { ...IDLE, error: "Posted 0.", clearError });
    expect(t.lastFrame()).toContain("Press any key to return");
    await press(t, "q");
    expect(clearError).toHaveBeenCalled();
    expect(t.onClose).not.toHaveBeenCalled();
  });

  it("cuts a long first line between characters, not inside an emoji", () => {
    const emoji = newDraft(`${"a".repeat(59)}😀 and more`, { kind: "general" }, commits);
    const t = show([emoji]);
    expect(t.lastFrame()).toContain("a😀…");
    expect(t.lastFrame()).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
