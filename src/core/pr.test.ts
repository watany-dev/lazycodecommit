import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodeCommitApi } from "../aws/codecommit.js";
import { createGit, type Git } from "../git/git.js";
import { fakeApi, fakeGit, pullRequest } from "../testing/fakes.js";
import type { RepoContext } from "./context.js";
import { UsageError, UserError } from "./errors.js";
import {
  type CreateOptions,
  checkoutPullRequest,
  consoleUrl,
  createPullRequest,
  listPullRequests,
  type PrDeps,
  pullRequestStatus,
  reopenPullRequest,
  resolvePullRequest,
} from "./pr.js";

const CLONE: RepoContext = {
  repository: "demo",
  region: "ap-northeast-1",
  clone: { root: "/work" },
};
const OUTSIDE: RepoContext = { repository: "demo", region: "ap-northeast-1" };

function deps(
  over: {
    git?: Partial<Git>;
    api?: CodeCommitApi;
    ctx?: RepoContext;
    files?: Record<string, string>;
    interactive?: boolean;
    confirm?: boolean;
    edited?: string;
    stdin?: string;
    template?: string;
  } = {},
) {
  const notes: string[] = [];
  const edits: string[] = [];
  const reads: { path: string; within: string | undefined }[] = [];
  const git = fakeGit(over.git);
  const d: PrDeps = {
    git,
    api: over.api ?? fakeApi(),
    ctx: over.ctx ?? CLONE,
    config: over.template ? { pr: { template: over.template } } : {},
    interactive: over.interactive ?? false,
    confirm: vi.fn(async () => over.confirm ?? true),
    edit: async (text) => {
      edits.push(text);
      return over.edited ?? text;
    },
    readFile: async (path, within) => {
      reads.push({ path, within });
      return over.files?.[path] ?? null;
    },
    readStdin: async () => over.stdin ?? "",
    note: (line) => notes.push(line),
  };
  return { d, notes, edits, reads };
}

const FILL: CreateOptions = { fill: true, push: false, noPush: false, dryRun: false };

describe("consoleUrl", () => {
  it("builds the spec's URL", () => {
    expect(consoleUrl("ap-northeast-1", "my repo", "12")).toBe(
      "https://ap-northeast-1.console.aws.amazon.com/codesuite/codecommit/repositories/my%20repo/pull-requests/12/details?region=ap-northeast-1",
    );
    expect(consoleUrl("cn-north-1", "r", "1")).toMatch(
      /^https:\/\/cn-north-1\.console\.amazonaws\.cn\//,
    );
  });

  it("uses the GovCloud console, which has no regional host names", () => {
    expect(consoleUrl("us-gov-west-1", "r", "1")).toBe(
      "https://console.amazonaws-us-gov.com/codesuite/codecommit/repositories/r/pull-requests/1/details?region=us-gov-west-1",
    );
  });
});

describe("createPullRequest in a clone", () => {
  it("creates from the single commit with --fill", async () => {
    const api = fakeApi();
    const { d } = deps({ api });
    const result = await createPullRequest(FILL, d);
    expect(result).toMatchObject({ kind: "created", pr: { id: "42", title: "Add thing" } });
    expect(api.created).toEqual([
      {
        repository: "demo",
        title: "Add thing",
        description: "Because.",
        sourceBranch: "topic",
        destinationBranch: "main",
        clientRequestToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
  });

  it("uses a fresh token per run, so a PR closed since is not returned", async () => {
    const api = fakeApi();
    await createPullRequest(FILL, deps({ api }).d);
    await createPullRequest(FILL, deps({ api }).d);
    expect(api.created[0]?.clientRequestToken).not.toBe(api.created[1]?.clientRequestToken);
  });

  it("does not push when the editor is abandoned", async () => {
    const push = vi.fn(async () => {});
    const { d } = deps({
      git: { unpushedCount: async () => null, push },
      interactive: true,
      edited: "",
    });
    await expect(createPullRequest({ ...FILL, fill: false, push: true }, d)).rejects.toThrow(
      "the title is empty",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("appends the default template and honours a configured one", async () => {
    const api = fakeApi();
    const files = {
      "/work/.codecommit/pull_request_template.md": "## Checklist",
      "/abs/t.md": "ABS",
    };
    await createPullRequest(FILL, deps({ api, files }).d);
    expect(api.created[0]?.description).toBe("Because.\n\n## Checklist");
    await createPullRequest(FILL, deps({ api, files, template: "/abs/t.md" }).d);
    expect(api.created[1]?.description).toBe("Because.\n\nABS");
    await createPullRequest(FILL, deps({ api, files, template: "missing.md" }).d);
    expect(api.created[2]?.description).toBe("Because.");
  });

  it("reads a repository-relative template only from inside the clone", async () => {
    const relative = deps();
    await createPullRequest(FILL, relative.d);
    expect(relative.reads).toEqual([
      { path: "/work/.codecommit/pull_request_template.md", within: "/work" },
    ]);
    const absolute = deps({ template: "/abs/t.md" });
    await createPullRequest(FILL, absolute.d);
    expect(absolute.reads).toEqual([{ path: "/abs/t.md", within: undefined }]);
  });

  it("lets --title, --body and --body-file override the draft", async () => {
    const api = fakeApi();
    await createPullRequest({ ...FILL, fill: false, title: "T", body: "B" }, deps({ api }).d);
    expect(api.created[0]).toMatchObject({ title: "T", description: "B" });
    await createPullRequest(
      { ...FILL, title: "T2", bodyFile: "b.md" },
      deps({ api, files: { "b.md": "  file body\n" } }).d,
    );
    expect(api.created[1]).toMatchObject({ title: "T2", description: "file body" });
  });

  it("opens the editor with the draft and uses what comes back", async () => {
    const api = fakeApi();
    const { d, edits } = deps({ api, interactive: true, edited: "Edited title\n\nEdited body\n" });
    await createPullRequest({ ...FILL, fill: false }, d);
    expect(edits).toEqual(["Add thing\n\nBecause.\n"]);
    expect(api.created[0]).toMatchObject({ title: "Edited title", description: "Edited body" });
  });

  it("aborts on an empty title", async () => {
    const { d } = deps({ interactive: true, edited: "\n\nbody" });
    await expect(createPullRequest({ ...FILL, fill: false }, d)).rejects.toThrow(
      "the title is empty",
    );
  });

  it("refuses a title or body longer than CodeCommit takes before pushing", async () => {
    const push = vi.fn(async () => {});
    const long = (subject: string, body = "") =>
      deps({
        git: {
          unpushedCount: async () => null,
          push,
          commits: async () => [{ subject, body }],
        },
      }).d;
    await expect(createPullRequest({ ...FILL, push: true }, long("x".repeat(151)))).rejects.toThrow(
      "The title is 151 characters; CodeCommit takes up to 150. Pass a shorter --title.",
    );
    await expect(
      createPullRequest({ ...FILL, push: true }, long("ok", "y".repeat(10_241))),
    ).rejects.toThrow("The body is 10241 characters; CodeCommit takes up to 10240.");
    await expect(
      createPullRequest({ ...FILL, dryRun: true }, long("x".repeat(151))),
    ).rejects.toThrow("The title is 151 characters");
    expect(push).not.toHaveBeenCalled();
    const api = fakeApi();
    await createPullRequest(
      FILL,
      deps({ api, git: { commits: async () => [{ subject: "x".repeat(150), body: "" }] } }).d,
    );
    expect(api.created[0]?.title).toHaveLength(150);
  });

  it("refuses to open an editor without a terminal", async () => {
    await expect(
      createPullRequest({ ...FILL, fill: false, title: "only" }, deps().d),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses to open an editor without a terminal when only the body is given", async () => {
    await expect(
      createPullRequest({ ...FILL, fill: false, body: "only" }, deps().d),
    ).rejects.toThrow(
      "Not a terminal: pass --fill, or both --title and --body, to create without an editor",
    );
  });

  it("takes a body of exactly CodeCommit's limit", async () => {
    const api = fakeApi();
    await createPullRequest(
      FILL,
      deps({ api, git: { commits: async () => [{ subject: "t", body: "y".repeat(10_240) }] } }).d,
    );
    expect(api.created[0]?.description).toHaveLength(10_240);
  });

  it.each([
    [{ push: true, noPush: true }, "--push and --no-push"],
    [{ body: "a", bodyFile: "b" }, "--body and --body-file"],
  ])("rejects conflicting flags %j", async (flags, message) => {
    await expect(createPullRequest({ ...FILL, ...flags }, deps().d)).rejects.toThrow(message);
  });

  it("reads --body-file - from stdin, like gh", async () => {
    const api = fakeApi();
    const { d, reads } = deps({ api, stdin: "from stdin\n" });
    await createPullRequest({ ...FILL, title: "T", bodyFile: "-" }, d);
    expect(api.created[0]).toMatchObject({ title: "T", description: "from stdin" });
    expect(reads.filter((r) => r.path === "-")).toEqual([]);
  });

  it("reports a missing --body-file", async () => {
    await expect(createPullRequest({ ...FILL, bodyFile: "nope.md" }, deps().d)).rejects.toThrow(
      "nope.md does not exist",
    );
  });

  it("errors on a detached HEAD", async () => {
    await expect(
      createPullRequest(FILL, deps({ git: { currentBranch: async () => null } }).d),
    ).rejects.toThrow("HEAD is detached");
  });

  it("errors when the repository has no default branch", async () => {
    const api = fakeApi([], { defaultBranch: async () => undefined });
    await expect(createPullRequest(FILL, deps({ api }).d)).rejects.toThrow("has no default branch");
  });

  it("errors when head is the base", async () => {
    await expect(
      createPullRequest(FILL, deps({ git: { currentBranch: async () => "main" } }).d),
    ).rejects.toThrow("is the base branch (main)");
  });

  it("returns an open PR for the same branches instead of creating", async () => {
    const open = pullRequest({ id: "5" });
    const other = pullRequest({ id: "6", destinationBranch: "develop" });
    const api = fakeApi([other, open, pullRequest({ id: "7", status: "CLOSED" })]);
    expect(await createPullRequest(FILL, deps({ api }).d)).toEqual({ kind: "exists", pr: open });
    expect(api.created).toEqual([]);
  });

  it("errors when the local head branch is missing", async () => {
    await expect(createPullRequest({ ...FILL, head: "missing" }, deps().d)).rejects.toThrow(
      "No local branch named missing, and demo has none either.",
    );
  });

  it("creates from a branch that exists only on origin, without pushing", async () => {
    const api = fakeApi();
    const push = vi.fn();
    const git = {
      resolveCommit: async (r: string) => (r === "refs/heads/theirs" ? null : "c"),
      push,
    };
    await createPullRequest({ ...FILL, head: "theirs" }, deps({ api, git }).d);
    expect(api.created[0]).toMatchObject({ title: "theirs", sourceBranch: "theirs" });
    expect(push).not.toHaveBeenCalled();
  });

  it("prefers origin/<base> and falls back to the local base", async () => {
    const commits = vi.fn(async () => [{ subject: "x", body: "" }]);
    await createPullRequest(FILL, deps({ git: { commits } }).d);
    expect(commits).toHaveBeenLastCalledWith("refs/remotes/origin/main", "refs/heads/topic");
    await createPullRequest(
      FILL,
      deps({
        git: { commits, resolveCommit: async (r) => (r.startsWith("refs/remotes") ? null : "c") },
      }).d,
    );
    expect(commits).toHaveBeenLastCalledWith("refs/heads/main", "refs/heads/topic");
  });

  it("errors when the base is not in the clone", async () => {
    const git = { resolveCommit: async (r: string) => (r.endsWith("/main") ? null : "c") };
    await expect(createPullRequest(FILL, deps({ git }).d)).rejects.toThrow("git fetch origin main");
  });

  it("errors when there are no commits to propose", async () => {
    await expect(
      createPullRequest(FILL, deps({ git: { commits: async () => [] } }).d),
    ).rejects.toThrow("has no commits that origin/main does not have");
  });

  describe("pushing", () => {
    it("pushes with --push", async () => {
      const push = vi.fn(async () => {});
      const { d, notes } = deps({ git: { unpushedCount: async () => null, push } });
      await createPullRequest({ ...FILL, push: true }, d);
      expect(push).toHaveBeenCalledWith("topic");
      expect(notes).toEqual(["Pushing topic to origin..."]);
    });

    it("asks on a terminal and pushes on yes", async () => {
      const push = vi.fn(async () => {});
      const { d } = deps({ git: { unpushedCount: async () => 2, push }, interactive: true });
      await createPullRequest(FILL, d);
      expect(d.confirm).toHaveBeenCalledWith(
        "topic has 2 commit(s) not on origin. Push it to origin?",
      );
      expect(push).toHaveBeenCalled();
    });

    it("aborts on no", async () => {
      const { d } = deps({
        git: { unpushedCount: async () => 2 },
        interactive: true,
        confirm: false,
      });
      await expect(createPullRequest(FILL, d)).rejects.toThrow("the branch was not pushed");
    });

    it("errors without a terminal and without --push", async () => {
      const { d } = deps({ git: { unpushedCount: async () => null } });
      await expect(createPullRequest(FILL, d)).rejects.toThrow(
        "topic is not on origin. Pass --push",
      );
    });

    it("errors with --no-push", async () => {
      const { d } = deps({ git: { unpushedCount: async () => 1 } });
      await expect(createPullRequest({ ...FILL, noPush: true }, d)).rejects.toThrow(
        "--no-push was given",
      );
    });

    it("stops when git push fails", async () => {
      const api = fakeApi();
      const push = vi.fn(async () => {
        throw new Error("git push -u origin topic failed");
      });
      const { d } = deps({ api, git: { unpushedCount: async () => null, push } });
      await expect(createPullRequest({ ...FILL, push: true }, d)).rejects.toThrow(UserError);
      await expect(createPullRequest({ ...FILL, push: true }, d)).rejects.toThrow(
        "git push failed: git push -u origin topic failed",
      );
      expect(api.created).toEqual([]);
    });

    it("does not push when already up to date", async () => {
      const push = vi.fn(async () => {});
      await createPullRequest({ ...FILL, push: true }, deps({ git: { push } }).d);
      expect(push).not.toHaveBeenCalled();
    });
  });

  it("plans without pushing or creating on --dry-run", async () => {
    const api = fakeApi();
    const push = vi.fn(async () => {});
    const { d } = deps({ api, git: { unpushedCount: async () => null, push } });
    expect(await createPullRequest({ ...FILL, dryRun: true }, d)).toEqual({
      kind: "dry-run",
      repository: "demo",
      head: "topic",
      base: "main",
      title: "Add thing",
      body: "Because.",
      wouldPush: true,
    });
    expect(push).not.toHaveBeenCalled();
    expect(api.created).toEqual([]);
  });

  it("fails a --dry-run with --no-push when a push is needed, as the real run does", async () => {
    const { d } = deps({ git: { unpushedCount: async () => 2 } });
    await expect(createPullRequest({ ...FILL, dryRun: true, noPush: true }, d)).rejects.toThrow(
      "topic has 2 commit(s) not on origin, and --no-push was given.",
    );
  });
});

describe("createPullRequest outside a clone", () => {
  it("requires --head", async () => {
    await expect(createPullRequest(FILL, deps({ ctx: OUTSIDE }).d)).rejects.toThrow(
      "--head is required",
    );
  });

  it("uses the branch name as the title and never touches git", async () => {
    const api = fakeApi();
    const commits = vi.fn();
    const { d } = deps({ api, ctx: OUTSIDE, git: { commits } });
    await createPullRequest({ ...FILL, head: "feature/x", base: "develop" }, d);
    expect(api.created[0]).toMatchObject({
      title: "feature/x",
      description: "",
      sourceBranch: "feature/x",
      destinationBranch: "develop",
      clientRequestToken: expect.any(String),
    });
    expect(commits).not.toHaveBeenCalled();
  });

  it("errors when the head branch does not exist remotely", async () => {
    await expect(
      createPullRequest({ ...FILL, head: "missing" }, deps({ ctx: OUTSIDE }).d),
    ).rejects.toThrow("demo has no branch named missing");
  });
});

describe("listPullRequests", () => {
  it("returns the newest activity first", async () => {
    const older = pullRequest({ id: "1", lastActivityDate: new Date("2026-01-01") });
    const newer = pullRequest({ id: "2", lastActivityDate: new Date("2026-02-01") });
    const closed = pullRequest({ id: "3", status: "CLOSED" });
    const { d } = deps({ api: fakeApi([older, newer, closed]) });
    expect((await listPullRequests({ state: "OPEN", limit: 30 }, d)).map((p) => p.id)).toEqual([
      "2",
      "1",
    ]);
    expect((await listPullRequests({ state: "CLOSED", limit: 30 }, d)).map((p) => p.id)).toEqual([
      "3",
    ]);
  });
});

describe("resolvePullRequest", () => {
  const prs = [pullRequest({ id: "9", sourceBranch: "other" }), pullRequest({ id: "3" })];

  it("gets by id", async () => {
    expect((await resolvePullRequest("9", deps({ api: fakeApi(prs) }).d)).id).toBe("9");
  });

  it("refuses a PR from another repository", async () => {
    const api = fakeApi([pullRequest({ id: "4", repository: "other" })]);
    await expect(resolvePullRequest("4", deps({ api }).d)).rejects.toThrow(
      "#4 belongs to other, not demo. Pass --repo other.",
    );
  });

  it("rejects a non-numeric id", async () => {
    await expect(resolvePullRequest("abc", deps().d)).rejects.toBeInstanceOf(UsageError);
    for (const id of ["9a", "a9", "9\n"]) {
      await expect(resolvePullRequest(id, deps().d)).rejects.toThrow(
        `Not a pull request id: ${id}`,
      );
    }
  });

  it("gets an id of several digits", async () => {
    const api = fakeApi([pullRequest({ id: "12" })]);
    expect((await resolvePullRequest("12", deps({ api }).d)).id).toBe("12");
  });

  it("finds the current branch's PR", async () => {
    expect((await resolvePullRequest(undefined, deps({ api: fakeApi(prs) }).d)).id).toBe("3");
  });

  it("errors when the branch has none", async () => {
    await expect(resolvePullRequest(undefined, deps().d)).rejects.toThrow(
      "No open pull request from topic in demo",
    );
  });

  it("needs an id outside a clone", async () => {
    await expect(resolvePullRequest(undefined, deps({ ctx: OUTSIDE }).d)).rejects.toHaveProperty(
      "message",
      "Not in a clone of the repository: pass a pull request id",
    );
  });

  it("says why the clone was not used when a flag ruled it out", async () => {
    const ctx = { ...OUTSIDE, otherClone: "this clone is of demo in us-east-1" };
    await expect(resolvePullRequest(undefined, deps({ ctx }).d)).rejects.toThrow(
      "pass a pull request id (this clone is of demo in us-east-1)",
    );
  });

  it("needs a branch", async () => {
    await expect(
      resolvePullRequest(undefined, deps({ git: { currentBranch: async () => null } }).d),
    ).rejects.toThrow("HEAD is detached");
  });
});

describe("pullRequestStatus", () => {
  it("collects approvals, rules and conflicts", async () => {
    const pr = pullRequest({ id: "3" });
    expect(await pullRequestStatus(deps({ api: fakeApi([pr]) }).d)).toEqual({
      branch: "topic",
      pr,
      approvers: ["arn:aws:sts::123456789012:assumed-role/Dev/bob"],
      rules: { approved: false, overridden: false, satisfied: ["one"], notSatisfied: ["two"] },
      mergeable: true,
    });
  });

  it("reports no PR", async () => {
    expect(await pullRequestStatus(deps().d)).toEqual({ branch: "topic" });
  });

  it("needs a clone", async () => {
    await expect(pullRequestStatus(deps({ ctx: OUTSIDE }).d)).rejects.toThrow("inside a clone");
  });
});

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const checkoutApi = () => fakeApi([pullRequest({ id: "9", sourceBranch: "feature/x" })]);

describe("checkoutPullRequest", () => {
  it("creates a tracking branch when there is no local one", async () => {
    const calls: string[] = [];
    const { d } = deps({
      api: checkoutApi(),
      git: {
        resolveCommit: async () => null,
        fetch: async (refspecs) => void calls.push(`fetch ${refspecs.join(" ")}`),
        switchBranch: async (b, o) => void calls.push(`switch ${b} ${o?.track ?? ""}`),
      },
    });
    expect(await checkoutPullRequest("9", d)).toMatchObject({
      branch: "feature/x",
      created: true,
      ahead: false,
    });
    expect(calls).toEqual([
      "fetch +refs/heads/feature/x:refs/remotes/origin/feature/x",
      "switch feature/x refs/remotes/origin/feature/x",
    ]);
  });

  it("switches to an existing branch and fast-forwards it", async () => {
    const calls: string[] = [];
    const { d } = deps({
      api: checkoutApi(),
      git: {
        switchBranch: async (b) => void calls.push(`switch ${b}`),
        fastForward: async (ref) => void calls.push(`ff ${ref}`),
        resolveCommit: async (ref) =>
          ref.startsWith("refs/heads/") || ref === "HEAD" ? "c" : null,
      },
    });
    expect(await checkoutPullRequest("9", d)).toMatchObject({ created: false });
    expect(calls).toEqual(["switch feature/x", "ff refs/remotes/origin/feature/x"]);
  });

  it("says the local branch is ahead when origin has none of its newer commits", async () => {
    const { d } = deps({
      api: checkoutApi(),
      git: { resolveCommit: async (ref) => (ref === "HEAD" ? "local" : "remote") },
    });
    expect(await checkoutPullRequest("9", d)).toMatchObject({ created: false, ahead: true });
  });

  it("does not switch when already on the branch", async () => {
    const calls: string[] = [];
    const { d } = deps({
      api: checkoutApi(),
      git: {
        currentBranch: async () => "feature/x",
        switchBranch: async (b) => void calls.push(`switch ${b}`),
      },
    });
    await checkoutPullRequest("9", d);
    expect(calls).toEqual([]);
  });

  it("explains a failed fetch, hinting at a deleted branch for a closed PR", async () => {
    const fail = { fetch: async () => Promise.reject(new Error("couldn't find remote ref")) };
    const open = deps({ api: checkoutApi(), git: fail }).d;
    await expect(checkoutPullRequest("9", open)).rejects.toThrow(
      new UserError("git fetch origin feature/x failed: couldn't find remote ref"),
    );
    const closed = deps({
      api: fakeApi([pullRequest({ id: "9", status: "CLOSED", sourceBranch: "gone" })]),
      git: fail,
    }).d;
    await expect(checkoutPullRequest("9", closed)).rejects.toThrow(/may have been deleted/);
  });

  it("tracks origin's branch even when a local branch is named origin/<branch>", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lazycc-checkout-")));
    const work = join(dir, "work");
    try {
      sh(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
      sh(dir, "init", "-q", "-b", "main", work);
      sh(work, "config", "user.name", "t");
      sh(work, "config", "user.email", "t@example.com");
      sh(work, "config", "commit.gpgsign", "false");
      sh(work, "remote", "add", "origin", join(dir, "origin.git"));
      sh(work, "commit", "-q", "--allow-empty", "-m", "initial");
      sh(work, "push", "-q", "origin", "main");
      sh(work, "switch", "-q", "-c", "feature/x");
      sh(work, "commit", "-q", "--allow-empty", "-m", "theirs");
      const tip = sh(work, "rev-parse", "HEAD");
      sh(work, "push", "-q", "origin", "feature/x");
      sh(work, "switch", "-q", "main");
      sh(work, "branch", "-q", "-D", "feature/x");
      sh(work, "update-ref", "-d", "refs/remotes/origin/feature/x");
      // A common slip: a local branch called origin/<name>, here at an older commit.
      sh(work, "branch", "-q", "origin/feature/x", "main");
      const { d } = deps({ api: checkoutApi() });
      const result = await checkoutPullRequest("9", { ...d, git: createGit(work) });
      expect(result).toMatchObject({ branch: "feature/x", created: true });
      expect(sh(work, "rev-parse", "HEAD")).toBe(tip);
      expect(sh(work, "config", "branch.feature/x.remote")).toBe("origin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("works only inside a clone", async () => {
    await expect(checkoutPullRequest("9", deps({ ctx: OUTSIDE }).d)).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(checkoutPullRequest("9", deps({ ctx: OUTSIDE }).d)).rejects.toHaveProperty(
      "message",
      "pr checkout works inside a clone of the repository",
    );
  });
});

const closedPr = (over: Parameters<typeof pullRequest>[0] = {}) =>
  pullRequest({ id: "6", status: "CLOSED", title: "Fix it", description: "Why.", ...over });

describe("reopenPullRequest", () => {
  it("opens a new PR from the closed one's branches, title and description", async () => {
    const api = fakeApi([closedPr()]);
    const r = await reopenPullRequest("6", deps({ api, ctx: OUTSIDE }).d);
    expect(r).toMatchObject({ kind: "reopened", pr: { id: "42" } });
    expect(api.created).toEqual([
      {
        repository: "demo",
        title: "Fix it",
        description: "Why.\n\nReopened from #6.",
        sourceBranch: "topic",
        destinationBranch: "main",
        clientRequestToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
  });

  it("notes the old PR alone when it had no description", async () => {
    const api = fakeApi([closedPr({ description: "" })]);
    await reopenPullRequest("6", deps({ api }).d);
    expect(api.created[0]?.description).toBe("Reopened from #6.");
  });

  it("keeps a description too long for the note as it was", async () => {
    const description = "x".repeat(10_235);
    const api = fakeApi([closedPr({ description })]);
    await reopenPullRequest("6", deps({ api }).d);
    expect(api.created[0]?.description).toBe(description);
  });

  it("answers the open PR from the same branches instead of opening another", async () => {
    const open = pullRequest({ id: "7" });
    const api = fakeApi([closedPr(), open]);
    const r = await reopenPullRequest("6", deps({ api }).d);
    expect(r).toMatchObject({ kind: "exists", pr: { id: "7" } });
    expect(api.created).toEqual([]);
  });

  it("opens one when the open PR from the branch goes into another branch", async () => {
    const api = fakeApi([closedPr(), pullRequest({ id: "7", destinationBranch: "release" })]);
    expect((await reopenPullRequest("6", deps({ api }).d)).kind).toBe("reopened");
  });

  it.each([
    [{ status: "OPEN" as const }, "#6 is already open."],
    [{ isMerged: true }, "#6 is merged, and a merged pull request cannot be reopened."],
  ])("refuses %j without opening a PR", async (over, message) => {
    const api = fakeApi([closedPr(over)]);
    const err = await reopenPullRequest("6", deps({ api }).d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err).toHaveProperty("message", message);
    expect(api.created).toEqual([]);
  });

  it.each([
    [{ sourceBranch: "missing" }, "source branch missing"],
    [{ destinationBranch: "missing" }, "destination branch missing"],
  ])("refuses when a branch is gone: %j", async (over, what) => {
    const api = fakeApi([closedPr(over)]);
    await expect(reopenPullRequest("6", deps({ api }).d)).rejects.toThrow(
      `#6's ${what} no longer exists in demo. Push it again, then retry.`,
    );
    expect(api.created).toEqual([]);
  });

  it("refuses a PR from another repository", async () => {
    const api = fakeApi([closedPr({ repository: "other" })]);
    await expect(reopenPullRequest("6", deps({ api }).d)).rejects.toThrow(
      "#6 belongs to other, not demo. Pass --repo other.",
    );
  });
});
