import { describe, expect, it } from "vitest";
import { issueRepo as repo } from "../testing/issueRepo.js";
import { UserError } from "./errors.js";
import {
  commentOnIssue,
  createIssue,
  formatFrontMatter,
  isUnreadable,
  listIssues,
  parseFrontMatter,
  parseIssue,
  setIssueState,
  viewIssue,
} from "./issues.js";

const issue = (title: string, state = "open", extra = "") =>
  `---\ntitle: ${title}\nstate: ${state}\nauthor: arn:me\ncreated: 2026-11-01T00:00:00Z\n${extra}---\nBody of ${title}\n`;

describe("front matter", () => {
  it("reads key: value lines and the body after", () => {
    expect(parseFrontMatter("---\ntitle: a: b\nx:\n---\nbody\n")).toEqual({
      fields: [
        ["title", "a: b"],
        ["x", ""],
      ],
      body: "body\n",
    });
  });

  it("takes CRLF and a BOM, and skips lines without a key", () => {
    expect(parseFrontMatter("﻿---\r\ntitle: t\r\nnot a field\r\n: no key\r\n---\r\nb")).toEqual({
      fields: [["title", "t"]],
      body: "b",
    });
  });

  it("is null without an opening or closing fence", () => {
    expect(parseFrontMatter("title: t\n")).toBeNull();
    expect(parseFrontMatter("---\ntitle: t\n")).toBeNull();
  });

  it("writes one line per value, so a newline cannot forge a field", () => {
    const text = formatFrontMatter([["title", "a\nstate: closed"]], "body");
    expect(text).toBe("---\ntitle: a state: closed\n---\nbody\n");
    expect(parseFrontMatter(text)?.fields).toEqual([["title", "a state: closed"]]);
  });

  it("leaves an empty body empty", () => {
    expect(formatFrontMatter([["a", "b"]], "")).toBe("---\na: b\n---\n");
  });
});

describe("parseIssue", () => {
  it("reads the fields and labels", () => {
    const parsed = parseIssue(
      3,
      "issue/3/issue.md",
      issue("T", "closed", "labels: bug, , ui\nclosed: x\n"),
    );
    expect(parsed).toMatchObject({
      number: 3,
      title: "T",
      state: "closed",
      closed: "x",
      labels: ["bug", "ui"],
      body: "Body of T",
    });
  });

  it("treats an unknown state as open", () => {
    expect(parseIssue(1, "p", issue("T", "weird"))).toMatchObject({ state: "open" });
  });

  it("reports a file without front matter or title as unreadable", () => {
    expect(parseIssue(1, "p", "hello")).toEqual({
      number: 1,
      path: "p",
      problem: "no front matter",
    });
    expect(parseIssue(1, "p", "---\nstate: open\n---\n")).toEqual({
      number: 1,
      path: "p",
      problem: "no title",
    });
  });
});

describe("listIssues", () => {
  it("is empty while the issue branch does not exist", async () => {
    const r = repo();
    expect(await listIssues(r.deps, { state: "open", limit: 30 })).toEqual({
      branch: "issues",
      issues: [],
    });
  });

  it("is empty when the branch has no issue folder", async () => {
    const r = repo({ branches: ["issues"] });
    expect((await listIssues(r.deps, { state: "all", limit: 30 })).issues).toEqual([]);
  });

  it("lists newest first, filters by state and keeps unreadable ones", async () => {
    const r = repo({
      files: {
        "issue/1/issue.md": issue("one"),
        "issue/2/issue.md": issue("two", "closed"),
        "issue/10/issue.md": issue("ten"),
        "issue/11/issue.md": "broken",
        "issue/12/comments/x.md": "a folder without issue.md",
        "issue/notes/issue.md": issue("not a number"),
        "issue/README.md": "a file",
      },
    });
    const open = await listIssues(r.deps, { state: "open", limit: 30 });
    expect(open.issues.map((i) => i.number)).toEqual([11, 10, 1]);
    expect(isUnreadable(open.issues[0] as never)).toBe(true);
    const closed = await listIssues(r.deps, { state: "closed", limit: 30 });
    expect(closed.issues.map((i) => i.number)).toEqual([11, 2]);
    const two = await listIssues(r.deps, { state: "all", limit: 2 });
    expect(two.issues.map((i) => i.number)).toEqual([11, 10]);
  });

  it("reads the branch the config names", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    r.tips.set("tracker", r.tips.get("issues") as string);
    r.tips.delete("issues");
    const list = await listIssues(
      { ...r.deps, config: { issues: { branch: "tracker" } } },
      { state: "all", limit: 30 },
    );
    expect(list.branch).toBe("tracker");
    expect(list.issues).toHaveLength(1);
  });
});

describe("viewIssue", () => {
  it("returns the issue and its comments in file name order", async () => {
    const r = repo({
      files: {
        "issue/1/issue.md": issue("one"),
        "issue/1/comments/20261102T000000Z-bbbbbb.md": "---\nauthor: b\ncreated: 2\n---\nsecond\n",
        "issue/1/comments/20261101T000000Z-aaaaaa.md": "---\nauthor: a\ncreated: 1\n---\nfirst\n\n",
        "issue/1/comments/notes.txt": "ignored",
        "issue/1/comments/20261103T000000Z-cccccc.md": "no front matter",
      },
    });
    const { issue: got, comments } = await viewIssue(r.deps, 1);
    expect(got.title).toBe("one");
    expect(comments).toEqual([
      { author: "a", created: "1", body: "first" },
      { author: "b", created: "2", body: "second" },
      { author: "", created: "", body: "no front matter" },
    ]);
  });

  it("has no comments when there is no comments folder", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    expect((await viewIssue(r.deps, 1)).comments).toEqual([]);
  });

  it("fails for a missing issue, a missing branch and an unreadable file", async () => {
    const r = repo({ files: { "issue/1/issue.md": "broken" } });
    await expect(viewIssue(r.deps, 2)).rejects.toThrow(new UserError("Issue #2 does not exist"));
    await expect(viewIssue(r.deps, 1)).rejects.toThrow(
      "Cannot read issue/1/issue.md: no front matter",
    );
    await expect(viewIssue(repo().deps, 1)).rejects.toThrow("Issue #1 does not exist");
  });
});

describe("createIssue", () => {
  it("creates the branch off the default branch, then issue 1", async () => {
    const r = repo();
    const created = await createIssue(r.deps, {
      title: " Login\nbreaks ",
      body: "It breaks.",
      labels: [],
    });
    expect(created).toMatchObject({
      number: 1,
      title: "Login breaks",
      state: "open",
      body: "It breaks.",
    });
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0]).toMatchObject({
      branch: "issues",
      parent: "c0",
      message: "issue #1: create",
    });
    expect(r.fileAt("issue/1/issue.md")).toBe(
      "---\ntitle: Login breaks\nstate: open\nauthor: arn:aws:iam::123456789012:user/me\ncreated: 2026-11-21T05:10:00.123Z\n---\nIt breaks.\n",
    );
  });

  it("numbers after the highest issue and writes labels", async () => {
    const r = repo({
      files: { "issue/1/issue.md": issue("one"), "issue/7/issue.md": issue("seven") },
    });
    const created = await createIssue(r.deps, { title: "t", body: "", labels: ["bug", " ", "ui"] });
    expect(created.number).toBe(8);
    expect(created.labels).toEqual(["bug", "ui"]);
  });

  it("takes the next number when someone created one first", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    r.raceOnce(() => r.put({ "issue/2/issue.md": issue("theirs") }));
    const created = await createIssue(r.deps, { title: "mine", body: "", labels: [] });
    expect(created.number).toBe(3);
    expect(r.fileAt("issue/2/issue.md")).toContain("theirs");
    expect(r.fileAt("issue/3/issue.md")).toContain("mine");
  });

  it("gives up after three refused commits", async () => {
    const r = repo({ files: {} });
    const outdated = Object.assign(new Error("outdated"), {
      name: "ParentCommitIdOutdatedException",
    });
    let calls = 0;
    const deps = {
      ...r.deps,
      api: {
        ...r.deps.api,
        createCommit: async () => {
          calls++;
          throw outdated;
        },
      },
    };
    await expect(createIssue(deps, { title: "t", body: "", labels: [] })).rejects.toBe(outdated);
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    const r = repo({ files: {} });
    const denied = Object.assign(new Error("no"), { name: "AccessDeniedException" });
    let calls = 0;
    const deps = {
      ...r.deps,
      api: {
        ...r.deps.api,
        createCommit: async () => {
          calls++;
          throw denied;
        },
      },
    };
    await expect(createIssue(deps, { title: "t", body: "", labels: [] })).rejects.toBe(denied);
    expect(calls).toBe(1);
  });

  it("uses the branch another client created in between", async () => {
    const r = repo();
    const api = r.deps.api;
    const deps = {
      ...r.deps,
      api: {
        ...api,
        createBranch: async (repository: string, branch: string, commitId: string) => {
          await api.createBranch(repository, branch, commitId);
          await api.createBranch(repository, branch, commitId);
        },
      },
    };
    expect((await createIssue(deps, { title: "t", body: "", labels: [] })).number).toBe(1);
  });

  it("rethrows a failure to create the branch", async () => {
    const r = repo();
    const denied = Object.assign(new Error("no"), { name: "AccessDeniedException" });
    const deps = {
      ...r.deps,
      api: { ...r.deps.api, createBranch: async () => Promise.reject(denied) },
    };
    await expect(createIssue(deps, { title: "t", body: "", labels: [] })).rejects.toBe(denied);
  });

  it("refuses an empty repository, where it would make the default branch", async () => {
    const r = repo();
    r.tips.delete("main");
    await expect(createIssue(r.deps, { title: "t", body: "", labels: [] })).rejects.toThrow(
      "demo has no commits yet. Push a first commit before adding issues.",
    );
    expect(r.commits).toEqual([]);
  });

  it("does not create the issue twice when its commit landed but the reply was lost", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    r.loseReplyOnce();
    const created = await createIssue(r.deps, { title: "mine", body: "", labels: [] });
    expect(created.number).toBe(2);
    expect(r.commits).toHaveLength(1);
    expect(r.fileAt("issue/3/issue.md")).toBeUndefined();
  });

  it("still numbers after an issue someone else created at the number it tried", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    r.raceOnce(() => r.put({ "issue/2/issue.md": "broken" }));
    expect((await createIssue(r.deps, { title: "mine", body: "", labels: [] })).number).toBe(3);
  });

  it("refuses an empty title", async () => {
    await expect(createIssue(repo().deps, { title: " \n", body: "", labels: [] })).rejects.toThrow(
      "An issue needs a title",
    );
  });
});

describe("commentOnIssue", () => {
  it("adds one file per comment", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    const comment = await commentOnIssue(r.deps, 1, "Looks bad.\n\n");
    expect(comment).toEqual({
      author: "arn:aws:iam::123456789012:user/me",
      created: "2026-11-21T05:10:00.123Z",
      body: "Looks bad.",
    });
    expect(r.commits[0]?.message).toBe("issue #1: comment");
    const path = r.commits[0]?.files[0]?.path as string;
    expect(path).toMatch(/^issue\/1\/comments\/20261121T051000Z-[0-9a-f]{6}\.md$/);
    expect(r.fileAt(path)).toBe(
      "---\nauthor: arn:aws:iam::123456789012:user/me\ncreated: 2026-11-21T05:10:00.123Z\n---\nLooks bad.\n\n",
    );
  });

  it("does not comment twice when its commit landed but the reply was lost", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    r.loseReplyOnce();
    expect((await commentOnIssue(r.deps, 1, "once")).body).toBe("once");
    expect(r.commits).toHaveLength(1);
  });

  it("refuses an empty comment and a missing issue", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    await expect(commentOnIssue(r.deps, 1, "  \n")).rejects.toThrow("The comment is empty");
    await expect(commentOnIssue(r.deps, 2, "x")).rejects.toThrow("Issue #2 does not exist");
    const empty = repo();
    await expect(commentOnIssue(empty.deps, 1, "x")).rejects.toThrow("Issue #1 does not exist");
    expect(empty.tips.has("issues")).toBe(false);
  });
});

describe("setIssueState", () => {
  it("closes, keeping unknown fields and the body", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one", "open", "priority: high\n") } });
    const { issue: closed, changed } = await setIssueState(r.deps, 1, "closed");
    expect(changed).toBe(true);
    expect(closed).toMatchObject({ state: "closed", closed: "2026-11-21T05:10:00.123Z" });
    expect(r.commits[0]?.message).toBe("issue #1: close");
    expect(r.fileAt("issue/1/issue.md")).toBe(
      "---\ntitle: one\nstate: closed\nauthor: arn:me\ncreated: 2026-11-01T00:00:00Z\npriority: high\nclosed: 2026-11-21T05:10:00.123Z\n---\nBody of one\n",
    );
  });

  it("reopens and drops the closed time", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one", "closed", "closed: x\n") } });
    const { issue: open } = await setIssueState(r.deps, 1, "open");
    expect(open.state).toBe("open");
    expect(open.closed).toBeUndefined();
    expect(r.commits[0]?.message).toBe("issue #1: reopen");
    expect(r.fileAt("issue/1/issue.md")).not.toContain("closed:");
  });

  it("commits nothing when already in that state", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    expect((await setIssueState(r.deps, 1, "open")).changed).toBe(false);
    expect(r.commits).toEqual([]);
  });

  it("re-reads after a race, so a comment made in between is kept", async () => {
    const r = repo({ files: { "issue/1/issue.md": issue("one") } });
    r.raceOnce(() => r.put({ "issue/1/comments/x.md": "---\nauthor: a\n---\nhi\n" }));
    await setIssueState(r.deps, 1, "closed");
    expect(r.fileAt("issue/1/comments/x.md")).toContain("hi");
    expect(r.fileAt("issue/1/issue.md")).toContain("state: closed");
  });

  it("fails for a missing issue without creating the branch", async () => {
    const r = repo();
    await expect(setIssueState(r.deps, 1, "closed")).rejects.toThrow("Issue #1 does not exist");
    expect(r.tips.has("issues")).toBe(false);
  });
});
