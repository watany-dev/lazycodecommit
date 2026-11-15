import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import type { DisplayLine } from "../utils/formatDiff.js";
import { DiffRow } from "./DiffLine.js";

const frame = (line: DisplayLine, isCursor = false) =>
  render(<DiffRow line={line} isCursor={isCursor} />).lastFrame();

describe("DiffRow", () => {
  it("draws the line-number gutter for add, delete and context rows", () => {
    for (const type of ["add", "delete", "context"] as const) {
      expect(frame({ type, text: "x", beforeLineNumber: 3, afterLineNumber: 12 })).toBe(
        "     3   12 │ x",
      );
    }
    expect(frame({ type: "add", text: "y", afterLineNumber: 1 }, true)).toBe(">         1 │ y");
  });

  it("indents replies past roots and adds the reaction badge to every comment row", () => {
    expect(frame({ type: "comment", text: "a: hi", reactionText: "👍1" })).toBe("   a: hi 👍1");
    expect(frame({ type: "inline-comment", text: "💬 a: hi", reactionText: "👍1" })).toBe(
      "   💬 a: hi 👍1",
    );
    expect(frame({ type: "comment-reply", text: "└ b: ok", reactionText: "🎉2" })).toBe(
      "     └ b: ok 🎉2",
    );
    expect(frame({ type: "inline-reply", text: "└ b: ok" })).toBe("     └ b: ok");
  });
});
