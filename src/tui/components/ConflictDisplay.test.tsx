import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ConflictDisplay } from "./ConflictDisplay.js";

const blocked = { mergeable: false, conflictCount: 0, conflictFiles: [] };

describe("ConflictDisplay", () => {
  it("says a fast-forward is impossible instead of counting zero conflicting files", () => {
    const frame = render(
      <ConflictDisplay conflictSummary={blocked} strategy="fast-forward" onDismiss={vi.fn()} />,
    ).lastFrame();
    expect(frame).not.toContain("0 conflicting");
    expect(frame).toContain("Cannot fast-forward");
    expect(frame).toContain("squash or three-way");
  });

  it("names the conflicting files when there are some", () => {
    const frame = render(
      <ConflictDisplay
        conflictSummary={{ mergeable: false, conflictCount: 1, conflictFiles: ["a.txt"] }}
        strategy="squash"
        onDismiss={vi.fn()}
      />,
    ).lastFrame();
    expect(frame).toContain("Cannot merge: 1 conflicting file\n");
    expect(frame).toContain("a.txt");
    expect(frame).toContain("Resolve conflicts before merging.");
  });

  it("says plainly that CodeCommit refused when no file conflicts on another strategy", () => {
    const frame = render(
      <ConflictDisplay conflictSummary={blocked} strategy="squash" onDismiss={vi.fn()} />,
    ).lastFrame();
    expect(frame).not.toContain("0 conflicting");
    expect(frame).toContain("cannot be merged with squash");
  });
});
