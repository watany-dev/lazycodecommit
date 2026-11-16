import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import type { DisplayLine } from "../utils/formatDiff.js";
import { DiffRow, expandTabs } from "./DiffLine.js";

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

  it("draws tabs as spaces to the next eight-column stop of the code, after the +/- mark", () => {
    expect(frame({ type: "add", text: "+\tx\ty", afterLineNumber: 1 })).toBe(
      `          1 │ +${" ".repeat(8)}x${" ".repeat(7)}y`,
    );
    // A wide character takes two columns toward the stop.
    expect(frame({ type: "comment", text: "a: 日本\tx" })).toBe(`   a: 日本${" ".repeat(1)}x`);
  });
});

describe("expandTabs", () => {
  it("leaves text without tabs as it is", () => {
    expect(expandTabs("a b")).toBe("a b");
  });
});
