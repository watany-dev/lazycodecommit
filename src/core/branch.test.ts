import { describe, expect, it, vi } from "vitest";
import type { CodeCommitApi } from "../aws/codecommit.js";
import type { Git } from "../git/git.js";
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
    expect(table.rows).toEqual([
      { name: "main", isDefault: true, tip: "main-tip", state: "none" },
      expect.objectContaining({ name: "topic", tip: "topic-tip", state: "open" }),
    ]);
  });
});

describe("deleteRemoteBranch", () => {
  const row: BranchRow = { name: "old", isDefault: false, tip: "r0ffee", state: "merged" };

  it("deletes on CodeCommit and prunes origin in a clone", async () => {
    const deleteBranch = vi.fn(async () => {});
    const fetch = vi.fn(async () => {});
    await deleteRemoteBranch(row, deps({ api: fakeApi([], { deleteBranch }), git: { fetch } }));
    expect(deleteBranch).toHaveBeenCalledWith("demo", "old");
    expect(fetch).toHaveBeenCalledWith(["--prune"], { quiet: true });
  });

  it("ignores a failed prune, and does not prune outside a clone", async () => {
    const fetch = vi.fn(async () => Promise.reject(new Error("offline")));
    await deleteRemoteBranch(row, deps({ git: { fetch } }));
    await deleteRemoteBranch(row, deps({ git: { fetch }, ctx: OUTSIDE }));
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("refuses when a pull request was opened from it since the row was read", async () => {
    const deleteBranch = vi.fn(async () => {});
    const api = fakeApi([pullRequest({ id: "9", sourceBranch: "old" })], { deleteBranch });
    await expect(deleteRemoteBranch(row, deps({ api }))).rejects.toThrow(
      "old has an open pull request (#9).",
    );
    expect(deleteBranch).not.toHaveBeenCalled();
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
      fetch: async (r: readonly string[]) => void calls.push(`fetch ${r.join(" ")}`),
      switchBranch: async (b: string, o?: { quiet?: boolean }) =>
        void calls.push(`switch ${b} ${o?.quiet}`),
    };
    const actions = branchActions(deps({ git }), "us-west-2");
    expect(actions.repository).toBe("demo");
    await actions.load({ fetch: false });
    await actions.load({ fetch: true });
    await actions.switchBranch?.({ name: "x", isDefault: false, tip: "t", state: "none" });
    await actions.deleteBranch({ name: "x", isDefault: false, tip: "r0ffee", state: "none" });
    expect(calls).toEqual(["fetch --prune", "switch x true", "fetch --prune"]);
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
