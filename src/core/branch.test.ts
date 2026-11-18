import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodeCommitApi } from "../aws/codecommit.js";
import { createGit, type Git } from "../git/git.js";
import { fakeApi, fakeGit, pullRequest } from "../testing/fakes.js";
import {
  type BranchDeps,
  type BranchRow,
  branchActions,
  branchConsoleUrl,
  deleteRemoteBranch,
  loadBranchTable,
} from "./branch.js";
import type { RepoContext } from "./context.js";

const CLONE: RepoContext = { repository: "demo", clone: { root: "/work" } };
const OUTSIDE: RepoContext = { repository: "demo" };
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const day = (d: number) => new Date(Date.UTC(2026, 10, d));

function deps(over: { api?: CodeCommitApi; git?: Partial<Git>; ctx?: RepoContext } = {}) {
  const d: BranchDeps = {
    api: over.api ?? fakeApi(),
    git: fakeGit(over.git),
    ctx: over.ctx ?? CLONE,
    config: {},
  };
  return d;
}

const remote = (name: string, tip: string, date: number) => ({
  name,
  tip,
  date: day(date),
  author: "alice",
});

describe("loadBranchTable in a clone", () => {
  const prs = [
    pullRequest({ id: "1", sourceBranch: "feature", sourceCommit: "f1" }),
    pullRequest({
      id: "2",
      status: "CLOSED",
      isMerged: true,
      sourceBranch: "done",
      sourceCommit: "d1",
    }),
    pullRequest({
      id: "3",
      status: "CLOSED",
      isMerged: true,
      sourceBranch: "more",
      sourceCommit: "old",
    }),
    pullRequest({
      id: "4",
      status: "CLOSED",
      isMerged: false,
      sourceBranch: "dropped",
      sourceCommit: "x1",
    }),
  ];
  const git = {
    remoteBranches: async () => [
      remote("feature", "f1", 3),
      remote("main", "m1", 1),
      remote("done", "d1", 2),
      remote("more", "m2", 5),
      remote("dropped", "x1", 4),
    ],
    aheadBehind: vi.fn(async (_base: string, head: string) =>
      head.endsWith("/more") ? Promise.reject(new Error("no base")) : { ahead: 2, behind: 1 },
    ),
  };

  it("classifies branches by PR data and sorts the default first, then newest", async () => {
    const table = await loadBranchTable(deps({ api: fakeApi(prs), git }));
    expect(table.defaultBranch).toBe("main");
    expect(table.rows.map((r) => [r.name, r.state, r.pr?.id])).toEqual([
      ["main", "none", undefined],
      ["more", "none", undefined],
      ["dropped", "none", undefined],
      ["feature", "open", "1"],
      ["done", "merged", "2"],
    ]);
    const feature = table.rows.find((r) => r.name === "feature");
    expect(feature).toMatchObject({
      ahead: 2,
      behind: 1,
      rules: { notSatisfied: ["two"] },
      lastCommit: { date: day(3), author: "alice" },
    });
    expect(git.aheadBehind).toHaveBeenCalledWith(
      "refs/remotes/origin/main",
      "refs/remotes/origin/feature",
    );
    expect(table.rows[0]).not.toHaveProperty("ahead");
    expect(table.rows.find((r) => r.name === "more")).not.toHaveProperty("ahead");
  });

  it("scans the configured number of closed PRs", async () => {
    const listPullRequestIds = vi.fn(async () => [] as string[]);
    const d = {
      ...deps({ api: fakeApi([], { listPullRequestIds }), git }),
      config: { branch: { closedPrLookback: 5 } },
    };
    await loadBranchTable(d);
    expect(listPullRequestIds).toHaveBeenCalledWith("demo", "CLOSED", 5);
  });

  it("works without a default branch", async () => {
    const api = fakeApi([], { defaultBranch: async () => undefined });
    const table = await loadBranchTable(deps({ api, git }));
    expect(table).not.toHaveProperty("defaultBranch");
    expect(table.rows.every((r) => !r.isDefault && r.ahead === undefined)).toBe(true);
  });
});

describe("loadBranchTable outside a clone", () => {
  it("lists branches and tips through the API, dropping one deleted meanwhile", async () => {
    const api = fakeApi([pullRequest({ id: "1", sourceBranch: "topic" })], {
      listBranches: async () => ["topic", "main", "gone"],
      branchCommit: async (_r, b) => (b === "gone" ? undefined : `${b}-tip`),
    });
    const table = await loadBranchTable(deps({ api, ctx: OUTSIDE }));
    expect(table.rows).toStrictEqual([
      { name: "main", isDefault: true, tip: "main-tip", state: "none" },
      expect.objectContaining({ name: "topic", tip: "topic-tip", state: "open" }),
    ]);
  });
});

describe("deleteRemoteBranch", () => {
  const row: BranchRow = { name: "old", isDefault: false, tip: "r0ffee", state: "merged" };

  it("deletes on CodeCommit and drops origin/<branch> in a clone", async () => {
    const deleteBranch = vi.fn(async () => {});
    const dropRemoteBranch = vi.fn(async () => {});
    await deleteRemoteBranch(
      row,
      deps({ api: fakeApi([], { deleteBranch }), git: { dropRemoteBranch } }),
    );
    expect(deleteBranch).toHaveBeenCalledWith("demo", "old");
    expect(dropRemoteBranch).toHaveBeenCalledWith("old");
  });

  it("ignores a failed drop, and does not drop outside a clone", async () => {
    const dropRemoteBranch = vi.fn(async () => Promise.reject(new Error("locked")));
    await deleteRemoteBranch(row, deps({ git: { dropRemoteBranch } }));
    await deleteRemoteBranch(row, deps({ git: { dropRemoteBranch }, ctx: OUTSIDE }));
    expect(dropRemoteBranch).toHaveBeenCalledTimes(1);
  });

  it("refuses the default branch and a branch with an open PR", async () => {
    await expect(deleteRemoteBranch({ ...row, isDefault: true }, deps())).rejects.toThrow(
      "old is the default branch.",
    );
    await expect(
      deleteRemoteBranch({ ...row, state: "open", pr: { id: "4", title: "t" } }, deps()),
    ).rejects.toThrow("old has an open pull request (#4).");
  });

  // The row can be minutes old. Deleting on it would drop commits pushed since,
  // or the source of a PR opened since.
  it("refuses when the branch moved since the row was read", async () => {
    const deleteBranch = vi.fn(async () => {});
    const api = fakeApi([], { deleteBranch, branchCommit: async () => "newer" });
    await expect(deleteRemoteBranch(row, deps({ api }))).rejects.toThrow(
      "old has moved since it was listed (now newer). Refresh and try again.",
    );
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("names the new tip by its short id", async () => {
    const api = fakeApi([], {
      branchCommit: async () => "0123456789abcdef0123456789abcdef01234567",
    });
    await expect(deleteRemoteBranch(row, deps({ api }))).rejects.toThrow("(now 0123456).");
  });

  it("deletes a branch while other branches have open pull requests", async () => {
    const deleteBranch = vi.fn(async () => {});
    const api = fakeApi([pullRequest({ id: "9", sourceBranch: "other" })], { deleteBranch });
    await deleteRemoteBranch(row, deps({ api }));
    expect(deleteBranch).toHaveBeenCalledWith("demo", "old");
  });

  it("refuses when a pull request was opened from it since the row was read", async () => {
    const deleteBranch = vi.fn(async () => {});
    const api = fakeApi([pullRequest({ id: "9", sourceBranch: "old" })], { deleteBranch });
    await expect(deleteRemoteBranch(row, deps({ api }))).rejects.toThrow(
      "old has an open pull request (#9).",
    );
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("drops origin/<branch> from a single-branch clone, whose fetch never prunes it", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lazycc-branch-")));
    try {
      const bare = join(dir, "origin.git");
      sh(dir, "init", "-q", "--bare", "-b", "main", bare);
      const work = join(dir, "work");
      sh(dir, "init", "-q", "-b", "main", work);
      sh(
        work,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@e",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "i",
      );
      sh(work, "push", "-q", bare, "main", "main:old");
      sh(dir, "clone", "-q", "--depth", "1", `file://${bare}`, "shallow");
      const clone = join(dir, "shallow");
      // Fetched outside remote.origin.fetch, as pr checkout does.
      sh(clone, "fetch", "-q", "origin", "+refs/heads/old:refs/remotes/origin/old");
      const tip = sh(clone, "rev-parse", "refs/remotes/origin/old").trim();
      const git = createGit(clone);
      const api = fakeApi([], {
        branchCommit: async () => tip,
        deleteBranch: async () => void sh(bare, "update-ref", "-d", "refs/heads/old"),
      });
      await deleteRemoteBranch({ ...row, tip }, { api, git, ctx: CLONE, config: {} });
      expect((await git.remoteBranches()).map((b) => b.name)).toEqual(["main"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says so when the branch is already gone", async () => {
    const api = fakeApi([], { branchCommit: async () => undefined });
    await expect(deleteRemoteBranch(row, deps({ api }))).rejects.toThrow(
      "old no longer exists on CodeCommit.",
    );
  });
});

describe("branchActions", () => {
  it("fetches before loading in a clone, and switches quietly", async () => {
    const calls: string[] = [];
    const git = {
      fetch: async (r: readonly string[], o?: { quiet?: boolean }) =>
        void calls.push(`fetch ${r.join(" ")} ${o?.quiet}`),
      switchBranch: async (b: string, o?: { quiet?: boolean; track?: string }) =>
        void calls.push(`switch ${b} ${o?.quiet} ${o?.track}`),
      resolveCommit: async (ref: string) => (ref === "refs/heads/x" ? "t" : null),
    };
    const actions = branchActions(deps({ git }), "us-west-2");
    expect(actions.repository).toBe("demo");
    await actions.load({ fetch: false });
    await actions.load({ fetch: true });
    await actions.switchBranch?.({ name: "x", isDefault: false, tip: "t", state: "none" });
    await actions.switchBranch?.({ name: "y", isDefault: false, tip: "t", state: "none" });
    await actions.deleteBranch({ name: "x", isDefault: false, tip: "r0ffee", state: "none" });
    expect(calls).toEqual([
      "fetch --prune true",
      "switch x true undefined",
      "switch y true refs/remotes/origin/y",
    ]);
  });

  it("switches to origin's branch even when another remote has one of the same name", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lazycc-branch-")));
    const work = join(dir, "work");
    try {
      sh(dir, "init", "-q", "-b", "main", work);
      sh(work, "config", "user.name", "t");
      sh(work, "config", "user.email", "t@example.com");
      sh(work, "config", "commit.gpgsign", "false");
      sh(work, "commit", "-q", "--allow-empty", "-m", "initial");
      for (const name of ["origin", "mirror"]) {
        sh(work, "remote", "add", name, join(dir, `${name}.git`));
        sh(work, "update-ref", `refs/remotes/${name}/topic`, "HEAD");
      }
      const git = createGit(work);
      const actions = branchActions({ api: fakeApi(), git, ctx: CLONE, config: {} }, "us-west-2");
      await actions.switchBranch?.({ name: "topic", isDefault: false, tip: "t", state: "none" });
      expect(await git.currentBranch()).toBe("topic");
      expect(sh(work, "config", "branch.topic.remote").trim()).toBe("origin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("has no switch and no fetch outside a clone", async () => {
    const fetch = vi.fn(async () => {});
    const actions = branchActions(deps({ ctx: OUTSIDE, git: { fetch } }), "us-west-2");
    expect(actions.switchBranch).toBeUndefined();
    await actions.load({ fetch: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds console URLs", () => {
    expect(branchActions(deps(), "us-west-2").consoleUrl("feature/a b")).toBe(
      "https://us-west-2.console.aws.amazon.com/codesuite/codecommit/repositories/demo/browse/refs/heads/feature/a%20b?region=us-west-2",
    );
    expect(branchConsoleUrl("cn-north-1", "r", "m")).toContain("console.amazonaws.cn");
  });
});
