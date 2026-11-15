import { describe, expect, it } from "vitest";
import { version } from "../../package.json" with { type: "json" };
import type { CiApi, CiRun } from "../aws/ci.js";
import type { CodeCommitApi } from "../aws/codecommit.js";
import type { Git } from "../git/git.js";
import { GitError } from "../git/git.js";
import { type Config, ConfigError } from "../state/config.js";
import { type FakeState, fakeApi, fakeGit, fakeState, pullRequest } from "../testing/fakes.js";
import type { ReviewRequest, TopRequest } from "../tui/index.js";
import { type Deps, run, USAGE } from "./main.js";

interface Setup {
  interactive?: boolean;
  onTop?: (request: TopRequest) => Promise<void>;
  git?: Partial<Git>;
  api?: CodeCommitApi;
  ci?: CiApi;
  config?: Config | Error;
  env?: Record<string, string>;
  state?: FakeState;
  edit?: (text: string) => Promise<string>;
  files?: Record<string, string>;
  stdin?: string;
}

async function cli(args: string[], setup: Setup = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const confirms: string[] = [];
  const apiOptions: object[] = [];
  const ciOptions: object[] = [];
  const reviews: ReviewRequest[] = [];
  const tops: TopRequest[] = [];
  const deps: Deps = {
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: setup.env ?? {},
      cwd: "/work",
      interactive: setup.interactive ?? false,
      confirm: async (question) => {
        confirms.push(question);
        return true;
      },
      edit: setup.edit ?? (async (t) => t),
      readFile: async (path) => setup.files?.[path] ?? null,
      readStdin: async () => setup.stdin ?? "",
    },
    createGit: () => fakeGit(setup.git),
    createApi: async (o) => {
      apiOptions.push(o);
      return setup.api ?? fakeApi();
    },
    createCiApi: async (o) => {
      ciOptions.push(o);
      return setup.ci ?? { recentBuilds: async () => [], recentExecutions: async () => [] };
    },
    loadConfig: async () => {
      if (setup.config instanceof Error) throw setup.config;
      return setup.config ?? {};
    },
    createState: () => setup.state ?? fakeState(),
    openReview: async (request) => void reviews.push(request),
    openTop: async (request) => {
      tops.push(request);
      await setup.onTop?.(request);
    },
  };
  const code = await run(args, deps);
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    confirms,
    apiOptions,
    ciOptions,
    reviews,
    tops,
  };
}

const json = (s: string) => JSON.parse(s);

describe("top level", () => {
  it.each([["--version"], ["-v"]])("prints the version for %s", async (flag) => {
    expect(await cli([flag])).toMatchObject({ code: 0, out: version });
  });

  it.each([[["--help"]], [["-h"]], [["help"]], [["pr", "--help"]]])(
    "prints usage for %j",
    async (args) => {
      expect(await cli(args)).toMatchObject({ code: 0, out: USAGE });
    },
  );

  it.each([
    [["pr", "list", "--help"], "lazycc pr list [--state open|closed] [-L limit]"],
    [["pr", "create", "-h"], "lazycc pr create [-B base]"],
    [["branch", "--help"], "lazycc branch"],
    [["clone", "--help"], "lazycc clone <repo>"],
    [["completion", "--help"], "lazycc completion bash|zsh|fish"],
  ])("prints only the command's usage for %j", async (args, line) => {
    const r = await cli(args);
    expect(r.code).toBe(0);
    expect(r.out).toContain(line);
    expect(r.out).toContain("--profile <name>");
    expect(r.out).not.toContain("lazycc pr view");
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
        throw Object.assign(new Error("no such repo"), { name: "InvalidRepositoryNameException" });
      },
    });
    expect(await cli(["pr", "list"], { api })).toMatchObject({
      code: 1,
      err: "lazycc: InvalidRepositoryNameException: no such repo",
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

const build = (id: string, status: string, commit: string): CiRun => ({
  id,
  status,
  commits: [commit],
  startedAt: new Date("2026-11-15T10:00:00Z"),
  endedAt: status === "IN_PROGRESS" ? undefined : new Date("2026-11-15T10:04:00Z"),
  url: `https://console/${id}`,
});
const ciPrApi = () => fakeApi([pullRequest({ id: "3", sourceCommit: "s1" })]);

describe("CI results in pr view and pr status (ADR 0010)", () => {
  const ci: CiApi = {
    recentBuilds: async () => [
      build("check:2", "FAILED", "s1"),
      build("check:1", "SUCCEEDED", "s0"),
    ],
    recentExecutions: async () => {
      throw Object.assign(
        new Error("not authorized to perform: codepipeline:ListPipelineExecutions"),
        {
          name: "AccessDeniedException",
        },
      );
    },
  };
  const config = { ci: { demo: { codebuild: ["check"], codepipeline: ["release"] } } };

  it("leaves CodeBuild and CodePipeline alone for a repository the config does not list", async () => {
    const r = await cli(["pr", "view", "--json"], {
      api: ciPrApi(),
      config: { ci: { other: { codebuild: ["x"] } } },
    });
    expect(json(r.out).checks).toBeNull();
    expect(r.ciOptions).toEqual([]);
    expect((await cli(["pr", "view"], { api: ciPrApi() })).out).not.toContain("CI:");
  });

  it("prints each run on the PR's source commit in pr view", async () => {
    const r = await cli(["pr", "view"], { api: ciPrApi(), config, ci });
    expect(r.ciOptions).toEqual([{ region: "ap-northeast-1" }]);
    expect(r.out.split("\n").slice(3, 6)).toEqual([
      "CI: ✗ fail",
      "  ✗  codebuild check       FAILED 2026-11-15T10:00:00Z  https://console/check:2",
      "  !  codepipeline release                               Access denied: not authorized to perform: codepipeline:ListPipelineExecutions",
    ]);
  });

  it("puts checks in pr view JSON", async () => {
    const r = await cli(["pr", "view", "--json"], { api: ciPrApi(), config, ci });
    expect(json(r.out).checks).toEqual({
      state: "fail",
      commit: "s1",
      runs: [
        {
          provider: "codebuild",
          name: "check",
          state: "fail",
          status: "FAILED",
          id: "check:2",
          startedAt: "2026-11-15T10:00:00Z",
          endedAt: "2026-11-15T10:04:00Z",
          url: "https://console/check:2",
        },
        {
          provider: "codepipeline",
          name: "release",
          state: "error",
          status: null,
          id: null,
          startedAt: null,
          endedAt: null,
          url: null,
          message: "Access denied: not authorized to perform: codepipeline:ListPipelineExecutions",
        },
      ],
    });
  });

  it("adds a CI line to pr status, and says when no run matched", async () => {
    const quiet = { ci: { demo: { codebuild: ["check"] } } };
    const none: CiApi = {
      recentBuilds: async () => [build("check:1", "SUCCEEDED", "other")],
      recentExecutions: async () => [],
    };
    const r = await cli(["pr", "status"], { api: ciPrApi(), config: quiet, ci: none });
    expect(r.out).toContain("  CI:             · none\n    ·  codebuild check    no run on s1");
    const j = json(
      (await cli(["pr", "status", "--json"], { api: ciPrApi(), config: quiet, ci: none })).out,
    );
    expect(j.checks).toMatchObject({ state: "none", runs: [{ state: "none", startedAt: null }] });
  });

  it("does not look for CI when the branch has no PR", async () => {
    const r = await cli(["pr", "status", "--json"], { config, ci });
    expect(json(r.out)).toEqual({ branch: "topic", pullRequest: null });
    expect(r.ciOptions).toEqual([]);
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

const commentApi = () => fakeApi([pullRequest({ id: "6", title: "Add \x1b[2Jthing" })]);

describe("pr comment", () => {
  it("posts --body and prints where", async () => {
    const a = commentApi();
    const r = await cli(["pr", "comment", "6", "-b", "LGTM"], { api: a });
    expect(r.code).toBe(0);
    expect(a.writes).toEqual(["comment 6 LGTM"]);
    expect(r.out.split("\n")).toEqual([
      "Commented on #6 Add ^[[2Jthing",
      "https://ap-northeast-1.console.aws.amazon.com/codesuite/codecommit/repositories/demo/pull-requests/6/details?region=ap-northeast-1",
    ]);
  });

  it("reads --body-file, and prints JSON", async () => {
    const a = commentApi();
    const r = await cli(["pr", "comment", "6", "-F", "note.md", "--json"], {
      api: a,
      files: { "note.md": "\nLooks good.\n" },
    });
    expect(a.writes).toEqual(["comment 6 Looks good."]);
    expect(json(r.out)).toMatchObject({ commentId: "c1", pullRequest: { id: "6" } });
  });

  it("reads -F - from stdin, like gh", async () => {
    const a = commentApi();
    const r = await cli(["pr", "comment", "6", "-F", "-"], { api: a, stdin: "Piped.\n" });
    expect(r.code).toBe(0);
    expect(a.writes).toEqual(["comment 6 Piped."]);
  });

  it("opens the editor on a terminal, and gives up on an empty comment", async () => {
    const a = commentApi();
    await cli(["pr", "comment", "6"], { api: a, interactive: true, edit: async () => "Hi\n" });
    expect(a.writes).toEqual(["comment 6 Hi"]);
    const r = await cli(["pr", "comment", "6"], { api: a, interactive: true });
    expect(r).toMatchObject({ code: 1, err: "lazycc: Aborted: the comment is empty." });
    expect(a.writes).toHaveLength(1);
  });

  it("defaults to the current branch's PR inside a clone", async () => {
    const a = fakeApi([pullRequest({ id: "3" })]);
    await cli(["pr", "comment", "-b", "x"], { api: a });
    expect(a.writes).toEqual(["comment 3 x"]);
  });

  it.each([
    [["pr", "comment", "6"], "Not a terminal: pass --body or --body-file"],
    [
      ["pr", "comment", "6", "-b", "a", "-F", "f"],
      "--body and --body-file cannot be used together",
    ],
    [["pr", "comment", "x", "-b", "a"], "Not a pull request id: x"],
  ])("exits 2 for %j", async (args, message) => {
    const r = await cli(args, { api: commentApi() });
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });

  it("exits 1 for a missing body file", async () => {
    const r = await cli(["pr", "comment", "6", "-F", "nope.md"], { api: commentApi() });
    expect(r).toMatchObject({ code: 1, err: "lazycc: --body-file: nope.md does not exist" });
  });
});

describe("pr approve", () => {
  it("approves, and revokes with --revoke", async () => {
    const a = fakeApi([pullRequest({ id: "6" })]);
    const r = await cli(["pr", "approve", "6"], { api: a });
    expect(r).toMatchObject({ code: 0 });
    expect(r.out.split("\n")[0]).toBe("Approved #6 A pull request");
    const v = await cli(["pr", "approve", "6", "--revoke", "--json"], { api: a });
    expect(json(v.out)).toMatchObject({ approved: false, pullRequest: { id: "6" } });
    expect(a.writes).toEqual(["approve 6", "revoke 6"]);
  });

  it("says so when you approve your own PR", async () => {
    const a = fakeApi([pullRequest({ id: "6" })], {
      setApproval: async () => {
        throw Object.assign(new Error("author"), {
          name: "PullRequestCannotBeApprovedByAuthorException",
        });
      },
    });
    const r = await cli(["pr", "approve", "6"], { api: a });
    expect(r).toMatchObject({ code: 1 });
    expect(r.err).toContain("You cannot approve your own pull request");
  });
});

describe("pr merge", () => {
  it.each([
    ["--ff", "fast-forward"],
    ["--squash", "squash"],
    ["--three-way", "three-way"],
  ])("merges with %s", async (flag, strategy) => {
    const a = fakeApi([pullRequest({ id: "6" })]);
    const r = await cli(["pr", "merge", "6", flag], { api: a });
    expect(r.code).toBe(0);
    expect(a.writes).toEqual([`merge 6 ${strategy}`]);
    expect(r.out.split("\n")[0]).toBe(`Merged #6 A pull request into main (${strategy})`);
  });

  it("prints the merged PR as JSON", async () => {
    const r = await cli(["pr", "merge", "6", "--squash", "--json"], {
      api: fakeApi([pullRequest({ id: "6" })]),
    });
    expect(json(r.out)).toMatchObject({ id: "6", status: "MERGED" });
  });

  it.each([
    [[], "Pick a merge strategy: --ff, --squash or --three-way, or set pr.mergeOption"],
    [["--ff", "--squash"], "Pick one merge strategy: --ff, --squash or --three-way"],
  ])("exits 2 for %j", async (flags, message) => {
    const a = fakeApi([pullRequest({ id: "6" })]);
    const r = await cli(["pr", "merge", "6", ...flags], { api: a });
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
    expect(a.writes).toEqual([]);
  });

  it("accepts exactly one strategy flag, over every combination", async () => {
    const flags = ["--ff", "--squash", "--three-way"];
    for (let mask = 0; mask < 8; mask++) {
      const picked = flags.filter((_, i) => mask & (1 << i));
      const r = await cli(["pr", "merge", "6", ...picked], {
        api: fakeApi([pullRequest({ id: "6" })]),
      });
      expect(r.code).toBe(picked.length === 1 ? 0 : 2);
    }
  });

  it.each([
    ["ff", "fast-forward"],
    ["squash", "squash"],
    ["three-way", "three-way"],
  ] as const)("uses pr.mergeOption %s when no flag is given", async (option, strategy) => {
    const a = fakeApi([pullRequest({ id: "6" })]);
    const r = await cli(["pr", "merge", "6"], { api: a, config: { pr: { mergeOption: option } } });
    expect(r.code).toBe(0);
    expect(a.writes).toEqual([`merge 6 ${strategy}`]);
  });

  it("prefers the flag over pr.mergeOption", async () => {
    const a = fakeApi([pullRequest({ id: "6" })]);
    const r = await cli(["pr", "merge", "6", "--ff"], {
      api: a,
      config: { pr: { mergeOption: "squash" } },
    });
    expect(r.code).toBe(0);
    expect(a.writes).toEqual(["merge 6 fast-forward"]);
  });

  it("refuses two flags even with pr.mergeOption", async () => {
    const a = fakeApi([pullRequest({ id: "6" })]);
    const r = await cli(["pr", "merge", "6", "--ff", "--squash"], {
      api: a,
      config: { pr: { mergeOption: "squash" } },
    });
    expect(r.code).toBe(2);
    expect(a.writes).toEqual([]);
  });

  it("explains a merge that needs a person", async () => {
    const a = fakeApi([pullRequest({ id: "6" })], {
      merge: async () => {
        throw Object.assign(new Error("conflicts"), { name: "ManualMergeRequiredException" });
      },
    });
    const r = await cli(["pr", "merge", "6", "--ff"], { api: a });
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot be merged automatically");
  });
});

describe("pr close", () => {
  it("closes without merging", async () => {
    const a = fakeApi([pullRequest({ id: "6" })]);
    const r = await cli(["pr", "close", "6"], { api: a });
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("Closed #6 A pull request");
    expect(a.writes).toEqual(["close 6"]);
    const j = await cli(["pr", "close", "6", "--json"], { api: a });
    expect(json(j.out)).toMatchObject({ id: "6", status: "CLOSED" });
  });
});

describe("writes to a PR that is no longer open", () => {
  it.each([[["pr", "approve", "6"]], [["pr", "merge", "6", "--ff"]], [["pr", "close", "6"]]])(
    "%j refuses a merged PR without calling AWS",
    async (args) => {
      const a = fakeApi([pullRequest({ id: "6", status: "CLOSED", isMerged: true })]);
      const r = await cli(args, { api: a });
      expect(r).toMatchObject({ code: 1, err: "lazycc: #6 is already merged." });
      expect(a.writes).toEqual([]);
    },
  );

  it("names a closed PR as closed", async () => {
    const a = fakeApi([pullRequest({ id: "6", status: "CLOSED" })]);
    const r = await cli(["pr", "close", "6"], { api: a });
    expect(r.err).toBe("lazycc: #6 is already closed.");
  });

  it("still takes a comment, as the console does", async () => {
    const a = fakeApi([pullRequest({ id: "6", status: "CLOSED", isMerged: true })]);
    expect((await cli(["pr", "comment", "6", "-b", "x"], { api: a })).code).toBe(0);
    expect(a.writes).toEqual(["comment 6 x"]);
  });
});

describe("completion", () => {
  it("prints a script for each shell without touching config or AWS", async () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      const r = await cli(["completion", shell], { config: new Error("not read") });
      expect(r.code).toBe(0);
      expect(r.out).toContain("lazycc");
      expect(r.apiOptions).toEqual([]);
    }
    const bash = (await cli(["completion", "bash"])).out;
    expect(bash).toContain('"pr merge") flags="');
    expect(bash).toContain("status");
    expect(bash).not.toMatch(/\bhome\b/);
  });

  it.each([[["completion"]], [["completion", "tcsh"]]])("exits 2 for %j", async (args) => {
    const r = await cli(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain("completion needs a shell: bash, zsh, fish");
  });
});

const browseApi = () =>
  fakeApi([], {
    getFolder: async (_repo, _ref, path) =>
      path === ""
        ? [
            { name: "src", path: "src", type: "folder" },
            { name: "README.md", path: "README.md", type: "file" },
            { name: "link", path: "link", type: "symlink" },
            { name: "vendor", path: "vendor", type: "submodule" },
          ]
        : undefined,
    getFile: async (repo, ref, path) =>
      path === "README.md"
        ? Buffer.from(`# ${repo}@${ref}\n`)
        : path === "logo.png"
          ? Buffer.from([0])
          : undefined,
  });

describe("browse", () => {
  it("lists the root of the default branch, like ls -F", async () => {
    const r = await cli(["browse"], { api: browseApi() });
    expect(r).toMatchObject({ code: 0, out: "src/\nREADME.md\nlink@\nvendor (submodule)" });
  });

  it("prints a file as it is, from another repository and ref", async () => {
    const r = await cli(["browse", "other", "--ref", "dev", "--path", "README.md"], {
      api: browseApi(),
    });
    expect(r).toMatchObject({ code: 0, out: "# other@dev" });
  });

  it("prints JSON for a folder and a file", async () => {
    const f = json((await cli(["browse", "--json"], { api: browseApi() })).out);
    expect(f).toMatchObject({ repository: "demo", ref: "main", path: "", type: "folder" });
    expect(f.entries[0]).toEqual({ name: "src", path: "src", type: "folder" });
    expect(f.url).toContain("/browse/refs/heads/main/--/?region=ap-northeast-1");
    const r = await cli(["browse", "--path", "README.md", "--json"], { api: browseApi() });
    expect(json(r.out)).toMatchObject({
      type: "file",
      path: "README.md",
      size: 12,
      binary: false,
      content: "# demo@main\n",
    });
  });

  it("refuses to print a binary file, except as JSON metadata", async () => {
    const r = await cli(["browse", "--path", "logo.png"], { api: browseApi() });
    expect(r.code).toBe(1);
    expect(r.err).toContain("logo.png is a binary file (1 bytes), not shown.");
    const j = await cli(["browse", "--path", "logo.png", "--json"], { api: browseApi() });
    expect(json(j.out)).toMatchObject({ binary: true, content: null });
  });

  it("points at clone for a file over the API's limit", async () => {
    const api = fakeApi([], {
      getFile: async () => {
        throw Object.assign(new Error("big"), { name: "FileTooLargeException" });
      },
    });
    const r = await cli(["browse", "--path", "big.bin"], { api });
    expect(r.code).toBe(1);
    expect(r.err).toContain("big.bin is too large for the CodeCommit API. Run `lazycc clone demo`");
    const j = await cli(["browse", "--path", "big.bin", "--json"], { api });
    expect(json(j.out)).toMatchObject({ tooLarge: true, content: null });
  });

  it("opens the browse screen on a terminal at the asked place", async () => {
    const r = await cli(["browse", "--ref", "dev", "--path", "src/"], {
      api: browseApi(),
      interactive: true,
    });
    expect(r).toMatchObject({ code: 0, out: "" });
    const [top] = r.tops;
    expect(top).toMatchObject({ start: "browse", repository: "demo", browsePath: "src/" });
    expect((await top?.views.browse("demo"))?.startRef).toBe("dev");
    // --ref only applies to the repository browse starts on.
    expect((await top?.views.browse("other"))?.startRef).not.toBe("dev");
  });

  it("opens the repository picker for browse outside a clone", async () => {
    const r = await cli(["browse"], {
      api: browseApi(),
      interactive: true,
      git: { topLevel: async () => null },
    });
    expect(r.code).toBe(0);
    expect(r.tops[0]?.start).toBe("browse");
    expect(r.tops[0]).not.toHaveProperty("repository");
    expect(r.tops[0]).not.toHaveProperty("cloneRepository");
  });

  it("rejects --repo next to a repository argument", async () => {
    const r = await cli(["browse", "a", "-R", "b"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Pass the repository once");
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
        markSeen: expect.any(Function),
        drafts: { load: expect.any(Function), save: expect.any(Function) },
        git: expect.anything(),
      },
    ]);
  });

  it("keeps the review screen's comment drafts in the state, per region and PR", async () => {
    const state = fakeState();
    const r = await cli(["pr", "view", "3"], {
      interactive: true,
      state,
      api: fakeApi([pullRequest({ id: "3" })]),
    });
    await r.reviews[0]?.drafts?.save("3", []);
    expect(await r.reviews[0]?.drafts?.load("3")).toEqual([]);
    const b = await cli(["branch"], { interactive: true, state });
    expect(b.tops[0]?.drafts).toBeDefined();
  });

  it("opens the PR list for a bare pr list, without git outside a clone", async () => {
    const r = await cli(["pr", "list", "-R", "demo", "--profile", "p"], {
      interactive: true,
      git: { topLevel: async () => null },
    });
    expect(r.reviews).toEqual([
      {
        repository: "demo",
        start: null,
        region: "us-west-2",
        profile: "p",
        markSeen: expect.any(Function),
        drafts: { load: expect.any(Function), save: expect.any(Function) },
      },
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

const branchApi = () => fakeApi([pullRequest({ id: "3", title: "Topic \x1b[31mwork" })]);

describe("branch", () => {
  const git = {
    remoteBranches: async () => [
      { name: "main", tip: "m1", date: new Date("2026-11-01T00:00:00Z"), author: "alice" },
      { name: "topic", tip: "s1", date: new Date("2026-11-03T00:00:00Z"), author: "bob" },
    ],
    aheadBehind: async () => ({ ahead: 2, behind: 0 }),
  };

  it("prints the table", async () => {
    const r = await cli(["branch"], { api: branchApi(), git });
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "* main   -          2026-11-01T00:00:00Z alice",
      "  topic  PR  ↑2 ↓0  2026-11-03T00:00:00Z bob    #3 Topic ^[[31mwork  ✗ 1/2 rules",
    ]);
  });

  it("prints JSON", async () => {
    const r = await cli(["branch", "--json"], { api: branchApi(), git });
    expect(json(r.out)).toMatchObject({
      repository: "demo",
      defaultBranch: "main",
      branches: [
        { name: "main", default: true, state: "none", pullRequest: null, ahead: null },
        {
          name: "topic",
          state: "open",
          pullRequest: { id: "3" },
          ahead: 2,
          behind: 0,
          lastCommit: { date: "2026-11-03T00:00:00Z", author: "bob" },
        },
      ],
    });
  });

  it("opens the branch screen on a terminal, creating PRs through pr create", async () => {
    const outcomes: unknown[] = [];
    const r = await cli(["branch"], {
      api: branchApi(),
      git,
      interactive: true,
      onTop: async (request) => {
        const view = request.views.branches("demo");
        outcomes.push(await view.createPullRequest("feature"));
        outcomes.push(await view.createPullRequest("topic"));
        outcomes.push(await view.createPullRequest("main"));
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.tops[0]).toMatchObject({
      start: "branches",
      repository: "demo",
      region: "ap-northeast-1",
      git: expect.anything(),
    });
    expect(r.tops[0]?.views.branches("demo").actions.repository).toBe("demo");
    expect(outcomes).toEqual([
      { pullRequestId: "42" },
      { pullRequestId: "3" },
      { message: expect.stringContaining("is the base branch") },
    ]);
  });

  it("explains AWS errors from a create", async () => {
    const failing = fakeApi([], {
      createPullRequest: async () => {
        throw Object.assign(new Error("expired"), { name: "ExpiredTokenException" });
      },
    });
    let outcome: unknown;
    await cli(["branch", "-R", "demo", "--profile", "dev"], {
      api: failing,
      interactive: true,
      git: { topLevel: async () => null },
      onTop: async (request) => {
        outcome = await request.views.branches("demo").createPullRequest("feature");
      },
    });
    expect(outcome).toEqual({ message: expect.stringContaining("aws sso login --profile dev") });
  });
});

describe("branch rules column", () => {
  it.each([
    [{ approved: true, overridden: true, satisfied: [], notSatisfied: [] }, "rules overridden"],
    [{ approved: true, overridden: false, satisfied: ["a"], notSatisfied: [] }, "✓ 1/1 rules"],
  ])("summarizes %j", async (rules, text) => {
    const api = fakeApi([pullRequest({ id: "3" })], { evaluateApprovalRules: async () => rules });
    const r = await cli(["branch", "-R", "demo"], { api, git: { topLevel: async () => null } });
    expect(r.out).toContain(text);
  });

  it("leaves it empty without rules", async () => {
    const api = fakeApi([pullRequest({ id: "3" })], {
      evaluateApprovalRules: async () => ({
        approved: true,
        overridden: false,
        satisfied: [],
        notSatisfied: [],
      }),
    });
    const r = await cli(["branch", "-R", "demo"], { api, git: { topLevel: async () => null } });
    expect(r.out).not.toContain("rules");
  });
});

describe("status", () => {
  const ME = "arn:aws:iam::123456789012:user/me";
  const prs = [
    pullRequest({ id: "1", repository: "demo", title: "Review me" }),
    pullRequest({ id: "2", repository: "demo", title: "Mine", authorArn: ME }),
    pullRequest({ id: "3", repository: "infra", title: "Elsewhere" }),
    pullRequest({ id: "4", repository: "demo", title: "Approved" }),
  ];
  const api = () =>
    fakeApi(prs, {
      approvers: async (pr) => (pr.id === "4" ? [ME] : []),
    });

  it("lists the clone's repository by default, without the PRs I approved", async () => {
    const state = fakeState();
    const r = await cli(["status"], { api: api(), state });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Awaiting your approval (1)");
    expect(r.out).toMatch(/● {2}demo {2}#1 {2}Review me {2}alice/);
    expect(r.out).toContain("Your pull requests (1)");
    expect(r.out).toMatch(/#2 {2}Mine {2}✗ 1\/2 rules {2}no conflicts/);
    expect(r.out).not.toContain("Approved");
    expect(r.out).not.toContain("Elsewhere");
    expect([...state.identities.values()]).toEqual([ME]);
    expect([...state.identities.keys()][0]).toMatch(/^cred:/);
    expect(state.sections.get("home")).toMatchObject({ items: expect.any(Array) });
  });

  it("uses the config's repos outside a clone and prints JSON", async () => {
    const r = await cli(["status", "--json"], {
      api: api(),
      config: { repos: ["demo", "infra"] },
      git: { topLevel: async () => null },
    });
    expect(r.code).toBe(0);
    const out = json(r.out);
    expect(out.me).toBe(ME);
    expect(out.repositories).toEqual(["demo", "infra"]);
    expect(out.awaiting.map((p: { id: string }) => p.id).toSorted()).toEqual(["1", "3"]);
    expect(out.awaiting[0]).toMatchObject({ unread: true, approvedBy: [] });
    expect(out.mine).toEqual([
      expect.objectContaining({
        id: "2",
        unread: true,
        mergeable: true,
        approvalRules: expect.objectContaining({ notSatisfied: ["two"] }),
      }),
    ]);
    expect(out.errors).toEqual([]);
  });

  it("asks for repositories outside a clone without config", async () => {
    const r = await cli(["status"], {
      git: { topLevel: async () => null },
      env: { XDG_CONFIG_HOME: "/cfg" },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Add "repos" to /cfg/lazycc/config.json');
  });

  it("reports a repository it cannot read and exits 1, keeping the rest", async () => {
    const failing = fakeApi(prs, {
      listPullRequestIds: async (repo) => {
        if (repo === "gone")
          throw Object.assign(new Error("denied for codecommit:ListPullRequests"), {
            name: "AccessDeniedException",
          });
        return ["1"];
      },
    });
    const r = await cli(["status"], { api: failing, config: { repos: ["demo", "gone"] } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("#1");
    expect(r.err).toContain("lazycc: gone: Access denied: denied for codecommit:ListPullRequests");
  });

  it("looks up the config's repos in the config's region even inside a clone", async () => {
    const r = await cli(["status"], {
      api: api(),
      config: { repos: ["infra"], region: "eu-west-1" },
    });
    expect(r.apiOptions).toEqual([{ region: "eu-west-1" }]);
    expect(r.out).toContain("Elsewhere");
  });

  it("prints none for empty sections and reports missing details", async () => {
    const r = await cli(["status", "-R", "demo"], {
      api: fakeApi([prs[1] as never], {
        evaluateApprovalRules: async () => {
          throw new Error("x");
        },
      }),
    });
    expect(r.out).toContain("Awaiting your approval (0)\n  none");
    expect(r.out).toMatch(/rules \? {2}conflicts \?/);
    expect(r.err).toContain("lazycc: demo #2: could not load approvals or rules: x");
    expect(r.code).toBe(1);
  });

  it("keeps going when the cache cannot be written", async () => {
    const state = fakeState();
    const broken = {
      ...state,
      cache: {
        ...state.cache,
        set: async () => {
          throw new Error("EROFS");
        },
      },
    };
    expect((await cli(["status"], { api: api(), state: broken })).code).toBe(0);
  });
});

describe("terminal safety", () => {
  // Any C0 or C1 control but \n and \t: what a terminal would act on.
  // oxlint-disable-next-line no-control-regex -- finding them is the point
  const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
  const hostile = "x\x1b]52;c;aGk=\x07\u009b2Jy";

  it("keeps other people's text from reaching the terminal as escape sequences", async () => {
    const api = fakeApi([
      pullRequest({ id: "3", title: hostile, sourceBranch: hostile, destinationBranch: hostile }),
    ]);
    for (const args of [
      ["pr", "view"],
      ["pr", "view", "3"],
      ["pr", "list"],
      ["pr", "status"],
    ]) {
      const r = await cli(args, { api });
      expect(r.out + r.err, args.join(" ")).not.toMatch(CONTROL);
    }
    const git = { commits: async () => [{ subject: hostile, body: hostile }] };
    const plan = await cli(["pr", "create", "--fill", "--dry-run"], { git });
    expect(plan.out + plan.err).not.toMatch(CONTROL);
    // Git forbids C0 in ref names but not C1, so a local branch can hold CSI.
    const push = await cli(["pr", "create", "--fill"], {
      interactive: true,
      git: { currentBranch: async () => "a\u009b2Jb", unpushedCount: async () => null },
    });
    expect(push.confirms).toEqual(["a^[[2Jb is not on origin. Push it to origin?"]);
  });

  it("makes error messages printable too", async () => {
    const git = {
      commits: async () => {
        throw new GitError(["log"], `fatal: bad revision '${hostile}'`, 128);
      },
    };
    const r = await cli(["pr", "create", "--fill"], { git });
    expect(r.code).toBe(1);
    expect(r.err).not.toMatch(CONTROL);
    expect(r.err).toContain("x^[]52;c;aGk=^G^[[2Jy");
  });

  it("escapes C1 controls in JSON, which JSON.stringify leaves raw, without changing the data", async () => {
    const api = fakeApi([pullRequest({ id: "3", title: hostile })]);
    const r = await cli(["pr", "view", "3", "--json"], { api });
    expect(r.out).not.toMatch(CONTROL);
    expect(json(r.out).title).toBe(hostile);
  });
});

describe("home", () => {
  const ME = "arn:aws:iam::123456789012:user/me";

  it("opens on the clone's repository on a terminal", async () => {
    const state = fakeState();
    const r = await cli([], { interactive: true, state });
    expect(r.code).toBe(0);
    const [top] = r.tops;
    expect(top).toMatchObject({ start: "home", region: "ap-northeast-1", cloneRepository: "demo" });
    expect(top?.git).toBeDefined();
    const home = await top?.views.home();
    expect(home).toMatchObject({ me: ME, region: "ap-northeast-1", initial: ["demo"] });
    // One STS call however often the home is opened.
    expect(await top?.views.home()).toBe(home);
  });

  it("opens on the picker outside a clone with nothing watched, and takes flags", async () => {
    const r = await cli(["--profile", "p"], {
      interactive: true,
      git: { topLevel: async () => null },
    });
    expect(r.apiOptions).toEqual([{ profile: "p" }]);
    expect((await r.tops[0]?.views.home())?.initial).toBeUndefined();
    expect(r.tops[0]).not.toHaveProperty("cloneRepository");
  });

  it("uses the config's repos and -R", async () => {
    const config = { repos: ["a", "b"] };
    const initial = async (args: string[]) =>
      (await (await cli(args, { interactive: true, config })).tops[0]?.views.home())?.initial;
    expect(await initial([])).toEqual(["a", "b"]);
    expect(await initial(["-R", "x"])).toEqual(["x"]);
  });

  it.each([["branch"], ["browse"]])(
    "reads the config's repos in the config's region from lazycc %s in a clone",
    async (command) => {
      const config = { repos: ["a"], region: "us-west-2", profile: "cfg" };
      const r = await cli([command], { interactive: true, config });
      const top = r.tops[0];
      // The branch table and browse stay on the clone's region...
      expect(top).toMatchObject({ region: "ap-northeast-1", cloneRepository: "demo" });
      // ...while home, as from bare lazycc, uses the config's.
      const home = await top?.views.home();
      expect(home).toMatchObject({ region: "us-west-2", initial: ["a"] });
      expect(r.apiOptions).toContainEqual({ region: "us-west-2", profile: "cfg" });
      expect(top?.home).toMatchObject({ region: "us-west-2", profile: "cfg" });
    },
  );

  it("shares the clone's account with home when the config names the same", async () => {
    const config = { repos: ["a"], region: "ap-northeast-1" };
    const r = await cli(["branch"], { interactive: true, config, env: {} });
    expect(r.tops[0]).not.toHaveProperty("home");
    expect((await r.tops[0]?.views.home())?.region).toBe("ap-northeast-1");
  });

  it("rejects an unknown flag, and home as a command", async () => {
    expect((await cli(["--nope"], { interactive: true })).code).toBe(2);
    expect((await cli(["--nope"])).code).toBe(2);
    expect((await cli(["home"], { interactive: true })).err).toContain("Unknown command: home");
  });

  it("prints the status text for bare lazycc without a terminal (spec: 出力と終了コード)", async () => {
    const r = await cli([], {
      api: fakeApi([pullRequest({ id: "1", repository: "demo", title: "Review me" })]),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Awaiting your approval (1)");
    expect(r.tops).toEqual([]);
  });

  it("prints the whole usage for --help after a bare lazycc's flags", async () => {
    expect(await cli(["-R", "x", "--help"], { interactive: true })).toMatchObject({
      code: 0,
      out: USAGE,
    });
  });

  it("prints the status JSON for bare lazycc --json", async () => {
    const r = await cli(["--json"], { api: fakeApi([]) });
    expect(r.code).toBe(0);
    expect(json(r.out)).toMatchObject({ awaiting: [], mine: [] });
  });

  it("hands pr.mergeOption to every review screen as the preselected strategy", async () => {
    const config = { pr: { mergeOption: "ff" as const } };
    const api = fakeApi([pullRequest({ id: "3" })]);
    const view = await cli(["pr", "view", "3"], { interactive: true, api, config });
    expect(view.reviews[0]?.mergeStrategy).toBe("fast-forward");
    const branch = await cli(["branch"], { interactive: true, config });
    expect(branch.tops[0]?.mergeStrategy).toBe("fast-forward");
    const home = await cli([], { interactive: true, config: { ...config, repos: ["demo"] } });
    expect(home.tops[0]?.mergeStrategy).toBe("fast-forward");
    const none = await cli(["pr", "view", "3"], { interactive: true, api });
    expect(none.reviews[0]).not.toHaveProperty("mergeStrategy");
  });

  it("marks PRs read from pr view and the branch table", async () => {
    const state = fakeState();
    const r = await cli(["pr", "view", "3"], {
      interactive: true,
      state,
      api: fakeApi([pullRequest({ id: "3" })]),
    });
    r.reviews[0]?.markSeen?.({ id: "3", authorArn: "arn:aws:iam::111122223333:user/a" });
    await state.flush();
    expect([...state.seenAt.keys()]).toEqual(["ap-northeast-1/111122223333/3"]);
    const b = await cli(["branch"], { interactive: true });
    expect(b.tops[0]?.markSeen).toBeTypeOf("function");
  });

  it("keeps quiet when a read mark cannot be saved", async () => {
    const state = fakeState();
    const broken = {
      ...state,
      seen: {
        ...state.seen,
        mark: async () => {
          throw new Error("EROFS");
        },
      },
    };
    const r = await cli(["pr", "view", "3"], {
      interactive: true,
      state: broken,
      api: fakeApi([pullRequest({ id: "3" })]),
    });
    expect(() => r.reviews[0]?.markSeen?.({ id: "3" })).not.toThrow();
  });
});
