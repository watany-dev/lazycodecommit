import { describe, expect, it } from "vitest";
import type { RuleEvaluation } from "../aws/codecommit.js";
import type { Inbox, InboxItem } from "../core/inbox.js";
import { pullRequest } from "../testing/fakes.js";
import { inboxJson, inboxLines } from "./format.js";

const rules = (r: Partial<RuleEvaluation>): RuleEvaluation => ({
  approved: false,
  overridden: false,
  satisfied: [],
  notSatisfied: [],
  ...r,
});

const mine = (extra: Partial<InboxItem>): InboxItem => ({
  section: "mine",
  pr: pullRequest({ title: "Mine" }),
  unread: false,
  ...extra,
});

describe("inboxLines", () => {
  it.each([
    [rules({ overridden: true, notSatisfied: ["a"] }), true, "rules overridden  no conflicts"],
    [rules({}), false, "no rules  conflicts"],
    [rules({ approved: true, satisfied: ["a"] }), true, "approved  no conflicts"],
    [rules({ satisfied: ["a"], notSatisfied: ["b", "c"] }), false, "rules 1/3  conflicts"],
  ])("summarizes %j", (r, mergeable, want) => {
    const lines = inboxLines([mine({ rules: r, mergeable })]);
    expect(lines.at(-1)).toContain(want);
    expect(lines[0]).toBe("Awaiting your approval (0)");
  });

  it("shows control characters in titles as text", () => {
    const lines = inboxLines([mine({ pr: pullRequest({ title: "a\x1b[2Jb" }) })]);
    expect(lines.at(-1)).toContain("a^[[2Jb");
  });
});

describe("inboxJson", () => {
  it("adds the detail error when there is one", () => {
    const item = mine({ detailError: "denied" });
    const inbox: Inbox = {
      me: "arn:me",
      repositories: ["demo"],
      items: [item],
      errors: [],
      fetchedAt: new Date(0),
    };
    expect(inboxJson(inbox, [item], "us-east-1").mine[0]).toMatchObject({
      detailError: "denied",
      approvalRules: null,
      mergeable: null,
    });
  });
});
