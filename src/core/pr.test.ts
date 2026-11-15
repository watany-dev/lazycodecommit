import { describe, expect, it, vi } from "vitest";
import type { CodeCommitApi } from "../aws/codecommit.js";
import type { Git } from "../git/git.js";
import { fakeApi, fakeGit, pullRequest } from "../testing/fakes.js";
import type { RepoContext } from "./context.js";
import { UsageError, UserError } from "./errors.js";
import {
  type CreateOptions,
  consoleUrl,
  createPullRequest,
  listPullRequests,
  type PrDeps,
  pullRequestStatus,
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
    template?: string;
  } = {},
) {
  const notes: string[] = [];
  const edits: string[] = [];
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
    readFile: async (path) => over.files?.[path] ?? null,
    note: (line) => notes.push(line),
  };
  return { d, notes, edits };
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

  it("refuses to open an editor without a terminal", async () => {
    await expect(
      createPullRequest({ ...FILL, fill: false, title: "only" }, deps().d),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it.each([
    [{ push: true, noPush: true }, "--push and --no-push"],
    [{ body: "a", bodyFile: "b" }, "--body and --body-file"],
  ])("rejects conflicting flags %j", async (flags, message) => {
    await expect(createPullRequest({ ...FILL, ...flags }, deps().d)).rejects.toThrow(message);
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
      "No local branch named missing",
    );
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
    await expect(resolvePullRequest(undefined, deps({ ctx: OUTSIDE }).d)).rejects.toThrow(
      "pass a pull request id",
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
