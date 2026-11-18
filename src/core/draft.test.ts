import { describe, expect, it } from "vitest";
import {
  draftFromCommits,
  fromEditorText,
  humanizeBranch,
  toEditorText,
  withTemplate,
} from "./draft.js";

describe("draft", () => {
  it("humanizes branch names", () => {
    expect(humanizeBranch("feature/add-login_page")).toBe("Feature/add login page");
    expect(humanizeBranch("fix")).toBe("Fix");
    expect(humanizeBranch("-fix--it_")).toBe("Fix it");
  });

  it("uses a single commit's subject and body", () => {
    expect(draftFromCommits("topic", [{ subject: "Add x", body: "Why." }])).toEqual({
      title: "Add x",
      body: "Why.",
    });
  });

  it("lists subjects for several commits", () => {
    expect(
      draftFromCommits("add-x", [
        { subject: "a", body: "" },
        { subject: "b", body: "z" },
      ]),
    ).toEqual({
      title: "Add x",
      body: "- a\n- b",
    });
  });

  it("appends a template", () => {
    expect(withTemplate({ title: "t", body: "b" }, "## Test\n")).toEqual({
      title: "t",
      body: "b\n\n## Test",
    });
    expect(withTemplate({ title: "t", body: "" }, "## Test")).toEqual({
      title: "t",
      body: "## Test",
    });
    expect(withTemplate({ title: "t", body: "b" }, "  \n")).toEqual({ title: "t", body: "b" });
    expect(withTemplate({ title: "t", body: "b" }, undefined)).toEqual({ title: "t", body: "b" });
  });

  it("round-trips the editor buffer", () => {
    const draft = { title: "Title", body: "Line 1\n\nLine 2" };
    expect(fromEditorText(toEditorText(draft))).toEqual(draft);
    expect(fromEditorText("  T  \r\n\r\n\r\nbody\r\n")).toEqual({ title: "T", body: "body" });
    expect(fromEditorText("")).toEqual({ title: "", body: "" });
  });
});
