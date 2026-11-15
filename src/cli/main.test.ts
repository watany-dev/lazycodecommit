import { describe, expect, it } from "vitest";
import { version } from "../../package.json" with { type: "json" };
import type { CodeCommitApi } from "../aws/codecommit.js";
import type { Git } from "../git/git.js";
import { GitError } from "../git/git.js";
import { type Config, ConfigError } from "../state/config.js";
import { fakeApi, fakeGit, pullRequest } from "../testing/fakes.js";
import type { ReviewRequest } from "../tui/index.js";
import { type Deps, run, USAGE } from "./main.js";

interface Setup {
  interactive?: boolean;
  git?: Partial<Git>;
  api?: CodeCommitApi;
  config?: Config | Error;
  env?: Record<string, string>;
}

async function cli(args: string[], setup: Setup = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const apiOptions: object[] = [];
  const reviews: ReviewRequest[] = [];
  const deps: Deps = {
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: setup.env ?? {},
      cwd: "/work",
      interactive: setup.interactive ?? false,
      confirm: async () => true,
      edit: async (t) => t,
      readFile: async () => null,
    },
    createGit: () => fakeGit(setup.git),
    createApi: async (o) => {
      apiOptions.push(o);
      return setup.api ?? fakeApi();
    },
    loadConfig: async () => {
      if (setup.config instanceof Error) throw setup.config;
      return setup.config ?? {};
    },
    openReview: async (request) => void reviews.push(request),
  };
  const code = await run(args, deps);
  return { code, out: out.join("\n"), err: err.join("\n"), apiOptions, reviews };
}

const json = (s: string) => JSON.parse(s);

describe("top level", () => {
  it.each([["--version"], ["-v"]])("prints the version for %s", async (flag) => {
    expect(await cli([flag])).toMatchObject({ code: 0, out: version });
  });

  it.each([
    [[]],
    [["--help"]],
    [["-h"]],
    [["help"]],
    [["pr", "--help"]],
    [["pr", "list", "--help"]],
  ])("prints usage for %j", async (args) => {
    expect(await cli(args)).toMatchObject({ code: 0, out: USAGE });
  });

  it("exits 2 for bare `pr`", async () => {
    expect(await cli(["pr"])).toMatchObject({ code: 2, out: USAGE });
  });

  it.each([
    [["nope"], "Unknown command: nope"],
    [["pr", "nope"], "Unknown command: pr nope"],
    [["pr", "list", "--bogus"], "Unknown option '--bogus'"],
    [["pr", "view", "1", "2"], "Unexpected argument: 2"],
    [["pr", "list", "--state", "merged"], "--state must be open or closed"],
    [["pr", "list", "-L", "0"], "--limit must be a positive integer: 0"],
  ])("exits 2 for %j", async (args, message) => {
    const r = await cli(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });
});

describe("context and errors", () => {
  it("passes region and profile from the remote and flags to the SDK", async () => {
    const r = await cli(["pr", "list", "--profile", "p"]);
    expect(r.apiOptions).toEqual([{ region: "ap-northeast-1", profile: "p" }]);
    expect((await cli(["pr", "list", "-R", "x", "--region", "us-west-2"])).apiOptions).toEqual([
      { region: "us-west-2" },
    ]);
  });

  it("uses the SDK's region for URLs when none was given", async () => {
    const api = fakeApi([pullRequest({ id: "4" })]);
    const r = await cli(["pr", "view", "4", "-R", "demo"], {
      api,
      git: { topLevel: async () => null },
    });
    expect(r.out).toContain("https://us-west-2.console.aws.amazon.com/");
  });

  it("exits 1 on a config error", async () => {
    const r = await cli(["pr", "list"], { config: new ConfigError("/c.json", "bad") });
    expect(r).toMatchObject({ code: 1, err: "lazycc: /c.json: bad" });
  });

  it("explains expired credentials with the profile", async () => {
    const api = fakeApi([], {
      listPullRequestIds: async () => {
        throw Object.assign(new Error("token expired"), { name: "ExpiredTokenException" });
      },
    });
    const r = await cli(["pr", "list"], { api, env: { AWS_PROFILE: "dev" } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("aws sso login --profile dev");
  });

  it("shows other errors by name, with a stack under LAZYCC_DEBUG", async () => {
    const api = fakeApi([], {
      listPullRequestIds: async () => {
        throw Object.assign(new Error("no such repo"), { name: "RepositoryDoesNotExistException" });
      },
    });
    expect(await cli(["pr", "list"], { api })).toMatchObject({
      code: 1,
      err: "lazycc: RepositoryDoesNotExistException: no such repo",
    });
    const debug = await cli(["pr", "list"], { api, env: { LAZYCC_DEBUG: "1" } });
    expect(debug.err).toContain("at ");
  });

  it("shows plain errors and non-errors", async () => {
    const plain = fakeApi([], {
      listPullRequestIds: async () => {
        throw new Error("boom");
      },
    });
    expect((await cli(["pr", "list"], { api: plain })).err).toBe("lazycc: boom");
    const weird = fakeApi([], {
      listPullRequestIds: async () => {
        throw "weird";
      },
    });
    expect((await cli(["pr", "list"], { api: weird })).err).toBe("lazycc: weird");
  });

  it("shows git errors as they are", async () => {
    const git = {
      commits: async () => {
        throw new GitError(["log"], "fatal: bad revision", 128);
      },
    };
    expect(await cli(["pr", "create", "--fill"], { git })).toMatchObject({
      code: 1,
      err: "lazycc: fatal: bad revision",
    });
  });
});

describe("pr create", () => {
  it("prints the new PR", async () => {
    const r = await cli(["pr", "create", "--fill"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      "Created pull request #42: Add thing\nhttps://ap-northeast-1.console.aws.amazon.com/codesuite/codecommit/repositories/demo/pull-requests/42/details?region=ap-northeast-1",
    );
  });

  it("prints JSON", async () => {
    const r = await cli([
      "pr",
      "create",
      "--fill",
      "--json",
      "-B",
      "main",
      "-H",
      "topic",
      "-t",
      "T",
      "-b",
      "B",
    ]);
    expect(json(r.out)).toMatchObject({
      id: "42",
      title: "T",
      description: "B",
      status: "OPEN",
      url: expect.any(String),
    });
  });

  it("exits 1 and points at an existing PR", async () => {
    const api = fakeApi([pullRequest({ id: "5", title: "Old" })]);
    const r = await cli(["pr", "create", "--fill"], { api });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("already open: #5 Old");
    expect(r.err).toContain("/pull-requests/5/details");
    const j = await cli(["pr", "create", "--fill", "--json"], { api });
    expect(j.code).toBe(1);
    expect(json(j.out)).toMatchObject({ existing: true, id: "5" });
  });

  it("prints a dry run", async () => {
    const git = { unpushedCount: async () => null };
    const r = await cli(["pr", "create", "--fill", "--dry-run"], { git });
    expect(r.out).toBe(
      "Would push and create a pull request in demo:\n  topic → main\n  title: Add thing\n  body:\n    Because.",
    );
    const blank = await cli(["pr", "create", "--fill", "--dry-run", "-b", "a\n\nb"]);
    expect(blank.out).toContain("    a\n\n    b");
    const empty = await cli(["pr", "create", "--fill", "--dry-run", "-b", ""]);
    expect(empty.out).toContain("body: (empty)");
    expect(empty.out).toMatch(/^Would create/);
    const j = await cli(["pr", "create", "--fill", "--dry-run", "--json"]);
    expect(json(j.out)).toEqual({
      dryRun: true,
      repository: "demo",
      head: "topic",
      base: "main",
      title: "Add thing",
      body: "Because.",
      wouldPush: false,
    });
  });

  it("passes every flag through", async () => {
    const api = fakeApi();
    const git = { unpushedCount: async () => 1 };
    expect((await cli(["pr", "create", "--fill", "--no-push"], { git, api })).err).toContain(
      "--no-push was given",
    );
    expect(
      (await cli(["pr", "create", "--fill", "--push", "-F", "x.md"], { git, api })).err,
    ).toContain("x.md does not exist");
  });
});

describe("pr list", () => {
  const prs = [
    pullRequest({ id: "1", title: "Short", lastActivityDate: new Date("2026-11-03T00:00:00Z") }),
    pullRequest({
      id: "12",
      title: "A longer title",
      sourceBranch: "feature/x",
      authorArn: "arn:aws:sts::1:assumed-role/Dev/bob",
      isMerged: true,
      status: "CLOSED",
    }),
  ];

  it("prints aligned rows", async () => {
    const r = await cli(["pr", "list", "--state", "closed"], { api: fakeApi(prs) });
    expect(r.out).toBe("#12  A longer title  feature/x → main  Dev/bob  2026-11-02T00:00:00Z");
    const open = await cli(["pr", "list", "-L", "5"], { api: fakeApi(prs) });
    expect(open.out).toBe("#1  Short  topic → main  alice  2026-11-03T00:00:00Z");
  });

  it("says when there are none", async () => {
    expect(await cli(["pr", "list"])).toMatchObject({
      code: 0,
      out: "",
      err: "No open pull requests in demo.",
    });
  });

  it("prints JSON, with MERGED for merged PRs", async () => {
    const r = await cli(["pr", "list", "--state", "CLOSED", "--json"], { api: fakeApi(prs) });
    expect(json(r.out)).toEqual([
      {
        id: "12",
        title: "A longer title",
        description: "",
        status: "MERGED",
        author: "arn:aws:sts::1:assumed-role/Dev/bob",
        repository: "demo",
        sourceBranch: "feature/x",
        destinationBranch: "main",
        sourceCommit: "s1",
        destinationCommit: "d1",
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-02T00:00:00Z",
        url: "https://ap-northeast-1.console.aws.amazon.com/codesuite/codecommit/repositories/demo/pull-requests/12/details?region=ap-northeast-1",
      },
    ]);
    expect(json((await cli(["pr", "list", "--json"])).out)).toEqual([]);
  });
});

describe("pr view", () => {
  it("prints the current branch's PR", async () => {
    const api = fakeApi([pullRequest({ id: "3", description: "Details here." })]);
    const r = await cli(["pr", "view"], { api });
    expect(r.out.split("\n")).toEqual([
      "A pull request #3",
      "OPEN · alice wants to merge topic into main",
      "created 2026-11-01T00:00:00Z · updated 2026-11-02T00:00:00Z",
      "",
      "Details here.",
      "",
      "https://ap-northeast-1.console.aws.amazon.com/codesuite/codecommit/repositories/demo/pull-requests/3/details?region=ap-northeast-1",
    ]);
  });

  it("prints a PR by id as JSON, and marks a missing description", async () => {
    const api = fakeApi([pullRequest({ id: "8", isMerged: true })]);
    expect(json((await cli(["pr", "view", "8", "--json"], { api })).out)).toMatchObject({
      id: "8",
      status: "MERGED",
    });
    expect((await cli(["pr", "view", "8"], { api })).out).toContain("(no description)");
    expect((await cli(["pr", "view", "8"], { api })).out).toContain("MERGED ·");
  });

  it("exits 1 when there is no PR", async () => {
    expect((await cli(["pr", "view"])).code).toBe(1);
  });

  it("shows an unparseable ARN as is", async () => {
    const api = fakeApi([pullRequest({ id: "3", authorArn: "someone" })]);
    expect((await cli(["pr", "view"], { api })).out).toContain("OPEN · someone wants");
    const root = fakeApi([pullRequest({ id: "3", authorArn: "arn:aws:iam::1:root" })]);
    expect((await cli(["pr", "view"], { api: root })).out).toContain("OPEN · root wants");
  });
});

describe("pr status", () => {
  it("prints approvals, rules and conflicts", async () => {
    const api = fakeApi([pullRequest({ id: "3" })]);
    const r = await cli(["pr", "status"], { api });
    expect(r.out.split("\n")).toEqual([
      "A pull request #3 (topic → main)",
      "  approval rules: ✓ one, ✗ two",
      "  approved by:    Dev/bob",
      "  conflicts:      none",
      "  https://ap-northeast-1.console.aws.amazon.com/codesuite/codecommit/repositories/demo/pull-requests/3/details?region=ap-northeast-1",
    ]);
  });

  it("covers no rules, overridden rules, no approvals and conflicts", async () => {
    const none = fakeApi([pullRequest({ id: "3" })], {
      evaluateApprovalRules: async () => ({
        approved: true,
        overridden: false,
        satisfied: [],
        notSatisfied: [],
      }),
      approvers: async () => [],
      mergeable: async () => false,
    });
    const r = await cli(["pr", "status"], { api: none });
    expect(r.out).toContain("approval rules: no approval rules");
    expect(r.out).toContain("approved by:    none");
    expect(r.out).toContain("conflicts:      yes, cannot merge cleanly");
    const overridden = fakeApi([pullRequest({ id: "3" })], {
      evaluateApprovalRules: async () => ({
        approved: true,
        overridden: true,
        satisfied: [],
        notSatisfied: ["x"],
      }),
    });
    expect((await cli(["pr", "status"], { api: overridden })).out).toContain(
      "approval rules: overridden",
    );
  });

  it("says when the branch has no PR, in text and JSON", async () => {
    expect(await cli(["pr", "status"])).toMatchObject({
      code: 0,
      out: "No open pull request from topic.",
    });
    expect(json((await cli(["pr", "status", "--json"])).out)).toEqual({
      branch: "topic",
      pullRequest: null,
    });
  });

  it("prints JSON", async () => {
    const api = fakeApi([pullRequest({ id: "3" })]);
    expect(json((await cli(["pr", "status", "--json"], { api })).out)).toMatchObject({
      branch: "topic",
      pullRequest: { id: "3" },
      approvedBy: ["arn:aws:sts::123456789012:assumed-role/Dev/bob"],
      approvalRules: { satisfied: ["one"], notSatisfied: ["two"] },
      mergeable: true,
    });
  });
});

describe("pr checkout", () => {
  it("switches to the PR's branch and says so on stderr", async () => {
    const api = fakeApi([pullRequest({ id: "6", sourceBranch: "feature/y" })]);
    const switched: string[] = [];
    const r = await cli(["pr", "checkout", "6"], {
      api,
      git: { resolveCommit: async () => null, switchBranch: async (b) => void switched.push(b) },
    });
    expect(r).toMatchObject({ code: 0, out: "" });
    expect(r.err).toBe("Switched to a new branch feature/y tracking origin/feature/y (#6).");
    expect(switched).toEqual(["feature/y"]);
  });

  it("prints JSON, and reports an updated existing branch", async () => {
    const api = fakeApi([pullRequest({ id: "6" })]);
    const r = await cli(["pr", "checkout", "6", "--json"], { api });
    expect(json(r.out)).toMatchObject({
      branch: "topic",
      created: false,
      pullRequest: { id: "6" },
    });
    expect((await cli(["pr", "checkout", "6"], { api })).err).toBe(
      "Switched to topic, up to date with origin/topic (#6).",
    );
  });

  it("needs an id", async () => {
    const r = await cli(["pr", "checkout"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("pr checkout needs a pull request id");
  });
});

describe("clone", () => {
  it("clones by repository name, passing a directory and git flags through", async () => {
    const cloned: unknown[] = [];
    const r = await cli(["clone", "other", "dir", "--", "--depth", "1"], {
      git: { clone: async (url, args) => void cloned.push([url, args]) },
    });
    expect(r.code).toBe(0);
    expect(cloned).toEqual([
      ["https://git-codecommit.us-west-2.amazonaws.com/v1/repos/other", ["dir", "--depth", "1"]],
    ]);
    expect(r.apiOptions).toEqual([{}]);
  });

  it("builds a git-remote-codecommit URL from the flags and prints JSON", async () => {
    const r = await cli([
      "clone",
      "other",
      "--protocol",
      "grc",
      "--profile",
      "dev",
      "--region",
      "eu-west-1",
      "--json",
    ]);
    expect(json(r.out)).toEqual({ repository: "other", url: "codecommit::eu-west-1://dev@other" });
  });

  it("needs a repository name and rejects --repo", async () => {
    expect((await cli(["clone"])).err).toContain("clone needs a repository name");
    expect((await cli(["clone", "a", "-R", "b"])).err).toContain("Unknown option '-R'");
  });

  it("reports a failed clone", async () => {
    const r = await cli(["clone", "other"], {
      git: {
        clone: async () => {
          throw new GitError(["clone"], "", 128);
        },
      },
    });
    expect(r).toMatchObject({ code: 1, err: "lazycc: git clone failed" });
  });
});

describe("the review screen on a terminal", () => {
  it("opens pr view on the PR, with git inside the clone", async () => {
    const api = fakeApi([pullRequest({ id: "3" })]);
    const r = await cli(["pr", "view"], { api, interactive: true });
    expect(r).toMatchObject({ code: 0, out: "" });
    expect(r.reviews).toEqual([
      {
        repository: "demo",
        start: { pullRequestId: "3" },
        region: "ap-northeast-1",
        git: expect.anything(),
      },
    ]);
  });

  it("opens the PR list for a bare pr list, without git outside a clone", async () => {
    const r = await cli(["pr", "list", "-R", "demo", "--profile", "p"], {
      interactive: true,
      git: { topLevel: async () => null },
    });
    expect(r.reviews).toEqual([
      { repository: "demo", start: null, region: "us-west-2", profile: "p" },
    ]);
  });

  it.each([
    [["pr", "view", "3", "--json"]],
    [["pr", "list", "--state", "open"]],
    [["pr", "list", "-L", "5"]],
    [["pr", "list", "--json"]],
  ])("prints text for %j", async (args) => {
    const api = fakeApi([pullRequest({ id: "3" })]);
    const r = await cli(args, { api, interactive: true });
    expect(r.reviews).toEqual([]);
    expect(r.out).not.toBe("");
  });
});
