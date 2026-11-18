import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { topSwitch } from "./top.js";

const key = (over: Partial<Key> = {}) => over as Key;

describe("topSwitch", () => {
  it("maps 1/2/3 to the other views and r to the picker", () => {
    expect(topSwitch("1", key(), "browse")).toEqual({ view: "home" });
    expect(topSwitch("2", key(), "home")).toEqual({ view: "branches" });
    expect(topSwitch("3", key(), "branches")).toEqual({ view: "browse" });
    expect(topSwitch("r", key(), "branches")).toEqual({ pick: true });
  });

  it("opens the picker on Ctrl+r, lazygit's switch to a recent repo", () => {
    expect(topSwitch("r", key({ ctrl: true }), "browse")).toEqual({ pick: true });
  });

  it("ignores the current view's key, other keys, and Ctrl or Meta", () => {
    expect(topSwitch("2", key(), "branches")).toBeUndefined();
    expect(topSwitch("x", key(), "home")).toBeUndefined();
    expect(topSwitch("d", key({ ctrl: true }), "home")).toBeUndefined();
    expect(topSwitch("1", key({ meta: true }), "browse")).toBeUndefined();
  });
});
