import React from "react";
import { describe, expect, it } from "vitest";
import { press, render } from "../../testing/keys.js";
import { useKeys } from "../hooks/useKeys.js";
import { FilterLine, useFilter, windowStart } from "./FilterLine.js";

function Screen() {
  const filter = useFilter();
  useKeys((input, key) => {
    if (filter.handleKey(key)) return;
    if (input === "/") filter.start();
  });
  return <FilterLine state={filter} />;
}

describe("useFilter and FilterLine", () => {
  it("types into the box after /, keeps the filter on Enter and clears it on Esc", async () => {
    const { lastFrame, stdin } = render(<Screen />);
    await press(stdin, "/", "a", "b");
    expect(lastFrame()).toContain("/ab");
    await press(stdin, "\r");
    expect(lastFrame()).toContain("filter: ab");
    await press(stdin, "/", "\u001B");
    expect(lastFrame()).not.toContain("ab");
  });
});

describe("windowStart", () => {
  it("keeps the cursor in a window of height rows", () => {
    expect(windowStart(0, 5, 20)).toBe(0);
    expect(windowStart(4, 5, 20)).toBe(0);
    expect(windowStart(7, 5, 20)).toBe(3);
    expect(windowStart(19, 5, 20)).toBe(15);
    expect(windowStart(2, 5, 3)).toBe(0);
  });
});
