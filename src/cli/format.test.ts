import { describe, expect, it } from "vitest";
import type { RuleEvaluation } from "../aws/codecommit.js";
import type { Inbox, InboxItem } from "../core/inbox.js";
import { pullRequest } from "../testing/fakes.js";
import { branchJson, inboxJson, inboxLines, statusLines, viewLines } from "./format.js";

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
    [rules({ approved: true, satisfied: ["a"] }), true, "✓ 1/1 rules  no conflicts"],
    [rules({ satisfied: ["a"], notSatisfied: ["b", "c"] }), false, "✗ 1/3 rules  conflicts"],
  ])("summarizes %j", (r, mergeable, want) => {
    const lines = inboxLines([mine({ rules: r, mergeable })]);
    expect(lines.at(-1)).toContain(want);
    expect(lines[0]).toBe("Awaiting your approval (0)");
  });

  it("adds a CI column only when some row has CI", () => {
    const r = rules({ approved: true, satisfied: ["a"] });
    const lines = inboxLines([
      mine({ rules: r, mergeable: true, checks: "fail" }),
      mine({ rules: r, mergeable: true, pr: pullRequest({ id: "9", title: "Other" }) }),
    ]);
    expect(lines.at(-2)).toContain("no conflicts  CI ✗ fail  ");
    expect(lines.at(-1)).toMatch(/no conflicts {2}\s+2026/);
    expect(inboxLines([mine({ rules: r, mergeable: true })]).at(-1)).not.toContain("CI");
  });

  it("leaves the CI column out entirely when no row has CI", () => {
    const lines = inboxLines([mine({ rules: rules({}), mergeable: true })]);
    expect(lines.at(-1)).toMatch(/no conflicts {2}2026/);
  });

  it("keeps the unread column one space wide for a read row, with a blank line between sections", () => {
    const lines = inboxLines([mine({}), mine({ unread: true })]);
    expect(lines.slice(0, 4)).toEqual([
      "Awaiting your approval (0)",
      "  none",
      "",
      "Your pull requests (2)",
    ]);
    expect(lines[4]).toMatch(/^ {5}demo/);
    expect(lines[5]).toMatch(/^ {2}● {2}demo/);
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
      checks: null,
    });
    expect(inboxJson(inbox, [mine({ checks: "pass" })], "us-east-1").mine[0]).toMatchObject({
      checks: "pass",
    });
    expect(inboxJson(inbox, [mine({})], "us-east-1").mine[0]).not.toHaveProperty("detailError");
  });
});

describe("branchJson", () => {
  it("passes on the rules and the counts a row has", () => {
    const r = rules({ approved: true, satisfied: ["a"] });
    const json = branchJson({
      repository: "demo",
      rows: [
        { name: "topic", isDefault: false, tip: "t", state: "open", rules: r, ahead: 0, behind: 3 },
      ],
    });
    expect(json.branches[0]).toMatchObject({ approvalRules: r, ahead: 0, behind: 3 });
  });
});

describe("viewLines", () => {
  it("trims the description", () => {
    const lines = viewLines(pullRequest({ description: "\n  body\n\n" }), "us-east-1");
    expect(lines).toContain("body");
  });
});

describe("statusLines", () => {
  const pr = pullRequest({});

  it("lists rules that are all satisfied", () => {
    const lines = statusLines(
      { branch: "topic", pr, rules: rules({ approved: true, satisfied: ["two"] }) },
      "us-east-1",
    );
    expect(lines[1]).toBe("  approval rules: ✓ two");
  });

  it("joins rules and approvers with commas", () => {
    const lines = statusLines(
      {
        branch: "topic",
        pr,
        rules: rules({ satisfied: ["a"], notSatisfied: ["b"] }),
        approvers: ["arn:aws:iam::1:user/x", "arn:aws:iam::1:user/y"],
      },
      "us-east-1",
    );
    expect(lines[1]).toBe("  approval rules: ✓ a, ✗ b");
    expect(lines[2]).toBe("  approved by:    x, y");
  });
});
