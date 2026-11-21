import { describe, expect, it } from "vitest";
import type { CodeCommitApi } from "../aws/codecommit.js";
import type { Config } from "../state/config.js";
import { fakeGit, fakeState } from "../testing/fakes.js";
import { issueRepo } from "../testing/issueRepo.js";
import { type Deps, run } from "./main.js";

interface Setup {
  api: CodeCommitApi;
  interactive?: boolean;
  edit?: (text: string) => Promise<string>;
  files?: Record<string, string>;
  stdin?: string;
  config?: Config;
}

async function cli(args: string[], setup: Setup) {
  const out: string[] = [];
  const err: string[] = [];
  const edits: string[] = [];
  const deps: Deps = {
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: {},
      cwd: "/work",
      interactive: setup.interactive ?? false,
      confirm: async () => true,
      edit: async (t) => {
        edits.push(t);
        return setup.edit ? setup.edit(t) : t;
      },
      readFile: async (path) => setup.files?.[path] ?? null,
      readStdin: async () => setup.stdin ?? "",
    },
    createGit: () => fakeGit(),
    createApi: async () => setup.api,
    createCiApi: async () => ({ recentBuilds: async () => [], recentExecutions: async () => [] }),
    loadConfig: async () => setup.config ?? {},
    createState: () => fakeState(),
    openReview: async () => {},
    openTop: async () => {},
  };
  const code = await run(args, deps);
  return { code, out: out.join("\n"), err: err.join("\n"), edits };
}

const issue = (title: string, state = "open", extra = "") =>
  `---\ntitle: ${title}\nstate: ${state}\nauthor: arn:aws:iam::1:user/alice\ncreated: 2026-11-01T00:00:00Z\n${extra}---\nBody of ${title}\n`;

const seeded = () =>
  issueRepo({
    files: {
      "issue/1/issue.md": issue("First", "open", "labels: bug, ui\n"),
      "issue/2/issue.md": issue("Second", "closed", "closed: 2026-11-02T00:00:00Z\n"),
      "issue/3/issue.md": "broken",
      "issue/1/comments/20261103T000000Z-aaaaaa.md":
        "---\nauthor: arn:aws:iam::1:user/bob\ncreated: 2026-11-03T00:00:00Z\n---\nSeen it too.\n",
    },
  });

describe("issue list", () => {
  it("prints open issues, newest first, and unreadable ones", async () => {
    const r = seeded();
    const { code, out } = await cli(["issue", "list"], { api: r.deps.api });
    expect(code).toBe(0);
    expect(out.split("\n")).toEqual([
      "#3  ?     (unreadable)           issue/3/issue.md: no front matter",
      "#1  open  First         bug, ui  alice",
    ]);
  });

  it("takes --state and --limit, and prints JSON", async () => {
    const r = seeded();
    const { out } = await cli(["issue", "list", "--state", "all", "-L", "2", "--json"], {
      api: r.deps.api,
    });
    expect(JSON.parse(out)).toEqual([
      { number: 3, unreadable: "no front matter", path: "issue/3/issue.md" },
      {
        number: 2,
        title: "Second",
        state: "closed",
        author: "arn:aws:iam::1:user/alice",
        createdAt: "2026-11-01T00:00:00Z",
        closedAt: "2026-11-02T00:00:00Z",
        labels: [],
        body: "Body of Second",
      },
    ]);
  });

  it("says so on stderr when there are none", async () => {
    const r = issueRepo();
    expect(await cli(["issue", "list"], { api: r.deps.api })).toMatchObject({
      code: 0,
      out: "",
      err: "No open issues in demo (branch issues).",
    });
    expect((await cli(["issue", "list", "-s", "all"], { api: r.deps.api })).err).toBe(
      "No issues in demo (branch issues).",
    );
  });

  it.each([
    [["--state", "merged"], "--state must be open, closed or all"],
    [["-L", "0"], "--limit must be a positive integer: 0"],
    [["-L", "1e1"], "--limit must be a positive integer: 1e1"],
  ])("refuses %j", async (flags, message) => {
    const r = issueRepo();
    const { code, err } = await cli(["issue", "list", ...flags], { api: r.deps.api });
    expect(code).toBe(2);
    expect(err).toContain(message);
  });
});

describe("issue view", () => {
  it("prints the issue and its comments", async () => {
    const r = seeded();
    const { code, out } = await cli(["issue", "view", "#1"], { api: r.deps.api });
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "#1 First",
        "open · alice opened 2026-11-01T00:00:00Z",
        "labels: bug, ui",
        "",
        "Body of First",
        "",
        "── bob 2026-11-03T00:00:00Z",
        "Seen it too.",
      ].join("\n"),
    );
  });

  it("shows when it was closed, and an empty body", async () => {
    const r = issueRepo({
      files: { "issue/2/issue.md": "---\ntitle: T\nstate: closed\nclosed: x\n---\n" },
    });
    const { out } = await cli(["issue", "view", "2"], { api: r.deps.api });
    expect(out).toBe(["#2 T", "closed ·  opened  · closed x", "", "(no description)"].join("\n"));
  });

  it("prints JSON with the comments", async () => {
    const r = seeded();
    const { out } = await cli(["issue", "view", "1", "--json"], { api: r.deps.api });
    expect(JSON.parse(out)).toMatchObject({
      number: 1,
      comments: [{ author: "arn:aws:iam::1:user/bob", body: "Seen it too." }],
    });
  });

  it("fails for a missing issue with exit code 1", async () => {
    const r = seeded();
    expect(await cli(["issue", "view", "9"], { api: r.deps.api })).toMatchObject({
      code: 1,
      err: "lazycc: Issue #9 does not exist",
    });
  });

  it.each([[[]], [["0"]], [["abc"]], [["1.5"]], [["99999999999999999999"]]])(
    "refuses the number %j",
    async (args) => {
      const r = seeded();
      expect((await cli(["issue", "view", ...args], { api: r.deps.api })).code).toBe(2);
    },
  );
});

describe("issue create", () => {
  it("creates from flags", async () => {
    const r = issueRepo();
    const { code, out } = await cli(
      ["issue", "create", "-t", "Crash", "-b", "  It crashes.  ", "-l", "bug,p1", "-l", "ui"],
      { api: r.deps.api },
    );
    expect(code).toBe(0);
    expect(out).toBe("Created issue #1: Crash");
    expect(r.fileAt("issue/1/issue.md")).toContain("labels: bug, p1, ui\n---\nIt crashes.\n");
  });

  it("reads the body from a file or stdin", async () => {
    const r = issueRepo();
    await cli(["issue", "create", "-t", "A", "-F", "body.md"], {
      api: r.deps.api,
      files: { "body.md": "from file" },
    });
    await cli(["issue", "create", "-t", "B", "-F", "-", "--json"], {
      api: r.deps.api,
      stdin: "from stdin",
    });
    expect(r.fileAt("issue/1/issue.md")).toContain("from file");
    expect(r.fileAt("issue/2/issue.md")).toContain("from stdin");
  });

  it("refuses a missing body file and both body flags", async () => {
    const r = issueRepo();
    expect(
      await cli(["issue", "create", "-t", "A", "-F", "nope"], { api: r.deps.api }),
    ).toMatchObject({ code: 1, err: "lazycc: --body-file: nope does not exist" });
    expect(
      (await cli(["issue", "create", "-t", "A", "-b", "x", "-F", "y"], { api: r.deps.api })).code,
    ).toBe(2);
  });

  it("needs a title and body without a terminal", async () => {
    const r = issueRepo();
    const { code, err } = await cli(["issue", "create", "-t", "A"], { api: r.deps.api });
    expect(code).toBe(2);
    expect(err).toContain("pass both --title and --body");
  });

  it("opens the editor for the title and body on a terminal", async () => {
    const r = issueRepo();
    const { out, edits } = await cli(["issue", "create", "-b", "draft"], {
      api: r.deps.api,
      interactive: true,
      edit: async () => "# comment\n Title here \n\nBody\nmore\n",
    });
    expect(edits[0]).toMatch(/^draft\n\n# The first line is the title/);
    expect(out).toBe("Created issue #1: Title here");
    expect(r.fileAt("issue/1/issue.md")).toContain("---\nBody\nmore\n");
  });

  it("opens the editor for the body when only the title is given", async () => {
    const r = issueRepo();
    await cli(["issue", "create", "-t", "T"], {
      api: r.deps.api,
      interactive: true,
      edit: async () => "edited body\n",
    });
    expect(r.fileAt("issue/1/issue.md")).toContain("---\nedited body\n");
  });

  it("aborts when the edited title is empty", async () => {
    const r = issueRepo();
    expect(
      await cli(["issue", "create"], {
        api: r.deps.api,
        interactive: true,
        edit: async () => "\n",
      }),
    ).toMatchObject({ code: 1, err: "lazycc: Aborted: the title is empty." });
    expect(r.commits).toEqual([]);
  });
});

describe("issue comment", () => {
  it("comments from a flag", async () => {
    const r = seeded();
    const { code, out } = await cli(["issue", "comment", "1", "-b", "Fixed?"], { api: r.deps.api });
    expect(code).toBe(0);
    expect(out).toBe("Commented on issue #1");
    expect(r.commits[0]?.message).toBe("issue #1: comment");
  });

  it("prints JSON", async () => {
    const r = seeded();
    const { out } = await cli(["issue", "comment", "1", "-b", "x", "--json"], { api: r.deps.api });
    expect(JSON.parse(out)).toMatchObject({ number: 1, comment: { body: "x" } });
  });

  it("opens the editor on a terminal and aborts on an empty comment", async () => {
    const r = seeded();
    await cli(["issue", "comment", "1"], {
      api: r.deps.api,
      interactive: true,
      edit: async () => "from editor\n",
    });
    expect(r.commits).toHaveLength(1);
    expect(
      await cli(["issue", "comment", "1"], {
        api: r.deps.api,
        interactive: true,
        edit: async () => " ",
      }),
    ).toMatchObject({ code: 1, err: "lazycc: Aborted: the comment is empty." });
  });

  it("needs a body without a terminal", async () => {
    const r = seeded();
    expect((await cli(["issue", "comment", "1"], { api: r.deps.api })).code).toBe(2);
  });
});

describe("issue close and reopen", () => {
  it("closes and reopens", async () => {
    const r = seeded();
    expect((await cli(["issue", "close", "1"], { api: r.deps.api })).out).toBe(
      "Closed issue #1: First",
    );
    expect((await cli(["issue", "reopen", "1"], { api: r.deps.api })).out).toBe(
      "Reopened issue #1: First",
    );
    expect(r.commits.map((c) => c.message)).toEqual(["issue #1: close", "issue #1: reopen"]);
  });

  it("says so when already in that state", async () => {
    const r = seeded();
    expect(await cli(["issue", "close", "2"], { api: r.deps.api })).toMatchObject({
      code: 0,
      err: "Issue #2 is already closed.",
    });
    const { out } = await cli(["issue", "reopen", "1", "--json"], { api: r.deps.api });
    expect(JSON.parse(out)).toMatchObject({ number: 1, state: "open", changed: false });
  });
});

describe("issue command line", () => {
  it("prints usage for a bare issue and for --help", async () => {
    const r = issueRepo();
    const bare = await cli(["issue"], { api: r.deps.api });
    expect(bare.code).toBe(2);
    expect(bare.out).toContain("lazycc issue list");
    const help = await cli(["issue", "close", "--help"], { api: r.deps.api });
    expect(help.out).toContain("lazycc issue close <number>");
    expect(help.out).not.toContain("lazycc issue list");
  });

  it("refuses an unknown verb", async () => {
    const r = issueRepo();
    expect(await cli(["issue", "edit"], { api: r.deps.api })).toMatchObject({ code: 2 });
  });

  it("uses the configured branch", async () => {
    const r = issueRepo();
    await cli(["issue", "create", "-t", "T", "-b", ""], {
      api: r.deps.api,
      config: { issues: { branch: "tracker" } },
    });
    expect(r.commits[0]?.branch).toBe("tracker");
  });
});
