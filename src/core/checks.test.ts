import { describe, expect, it, vi } from "vitest";
import type { CiApi, CiRun } from "../aws/ci.js";
import {
  type CheckState,
  checksFor,
  ciTargets,
  lazyCiClient,
  loadTargetRuns,
  overallState,
  pullRequestChecks,
  RECENT_RUNS,
  repositoryRuns,
  stateOf,
} from "./checks.js";

const run = (id: string, status: string, commits: string[]): CiRun => ({
  id,
  status,
  commits,
  startedAt: new Date("2026-11-15T10:00:00Z"),
  endedAt: undefined,
  url: `https://console/${id}`,
});

describe("ciTargets", () => {
  it("lists the repository's projects, then its pipelines", () => {
    const config = { ci: { svc: { codepipeline: ["rel"], codebuild: ["a", "b"] } } };
    expect(ciTargets(config, "svc")).toEqual([
      { provider: "codebuild", name: "a" },
      { provider: "codebuild", name: "b" },
      { provider: "codepipeline", name: "rel" },
    ]);
  });

  it("is undefined for a repository without ci, or with nothing listed", () => {
    expect(ciTargets({}, "svc")).toBeUndefined();
    expect(ciTargets({ ci: { other: { codebuild: ["a"] } } }, "svc")).toBeUndefined();
    expect(ciTargets({ ci: { svc: { codebuild: [] } } }, "svc")).toBeUndefined();
  });
});

describe("loadTargetRuns", () => {
  it("asks each target for its recent runs and keeps a failure with its target", async () => {
    const denied = Object.assign(new Error("not authorized to perform: codebuild:BatchGetBuilds"), {
      name: "AccessDeniedException",
    });
    const api: CiApi = {
      recentBuilds: vi.fn(async (name: string) => {
        if (name === "locked") throw denied;
        return [run("b1", "SUCCEEDED", ["c1"])];
      }),
      recentExecutions: vi.fn(async () => {
        throw "boom";
      }),
    };
    const result = await loadTargetRuns(api, [
      { provider: "codebuild", name: "ok" },
      { provider: "codebuild", name: "locked" },
      { provider: "codepipeline", name: "rel" },
    ]);
    expect(api.recentBuilds).toHaveBeenCalledWith("ok", RECENT_RUNS);
    expect(api.recentExecutions).toHaveBeenCalledWith("rel", RECENT_RUNS);
    expect(result).toEqual([
      { provider: "codebuild", name: "ok", runs: [run("b1", "SUCCEEDED", ["c1"])] },
      {
        provider: "codebuild",
        name: "locked",
        error: "Access denied: not authorized to perform: codebuild:BatchGetBuilds",
      },
      { provider: "codepipeline", name: "rel", error: "boom" },
    ]);
  });
});

describe("stateOf", () => {
  it.each([
    ["codebuild", "SUCCEEDED", "pass"],
    ["codebuild", "FAILED", "fail"],
    ["codebuild", "FAULT", "fail"],
    ["codebuild", "TIMED_OUT", "fail"],
    ["codebuild", "IN_PROGRESS", "pending"],
    ["codebuild", "STOPPED", "cancel"],
    ["codebuild", "Succeeded", "pending"],
    ["codepipeline", "Succeeded", "pass"],
    ["codepipeline", "Failed", "fail"],
    ["codepipeline", "InProgress", "pending"],
    ["codepipeline", "Stopping", "pending"],
    ["codepipeline", "Stopped", "cancel"],
    ["codepipeline", "Cancelled", "cancel"],
    ["codepipeline", "Superseded", "cancel"],
    ["codepipeline", "SomethingNew", "pending"],
  ] as const)("%s %s is %s", (provider, status, state) => {
    expect(stateOf(provider, status)).toBe(state);
  });
});

describe("overallState", () => {
  it.each([
    [["pass", "fail", "pending"], "fail"],
    [["pass", "error", "pending"], "error"],
    [["pass", "pending", "cancel"], "pending"],
    [["pass", "cancel"], "cancel"],
    [["none", "pass"], "pass"],
    [["none"], "none"],
    [[], "none"],
  ] as [CheckState[], CheckState][])("%j is %s", (states, want) => {
    expect(overallState(states)).toBe(want);
  });
});

describe("checksFor", () => {
  const targets = [
    {
      provider: "codebuild" as const,
      name: "check",
      runs: [
        run("check:3", "IN_PROGRESS", ["c-new"]),
        run("check:2", "FAILED", ["c1"]),
        run("check:1", "SUCCEEDED", ["c1"]),
      ],
    },
    { provider: "codepipeline" as const, name: "rel", runs: [run("e1", "Succeeded", ["c0"])] },
    { provider: "codepipeline" as const, name: "locked", error: "Access denied: x" },
  ];

  it("takes each target's newest run on the commit", () => {
    expect(checksFor("c1", targets)).toEqual({
      state: "fail",
      commit: "c1",
      runs: [
        {
          provider: "codebuild",
          name: "check",
          state: "fail",
          status: "FAILED",
          id: "check:2",
          startedAt: new Date("2026-11-15T10:00:00Z"),
          endedAt: null,
          url: "https://console/check:2",
        },
        {
          provider: "codepipeline",
          name: "rel",
          state: "none",
          status: null,
          id: null,
          startedAt: null,
          endedAt: null,
          url: null,
        },
        {
          provider: "codepipeline",
          name: "locked",
          state: "error",
          status: null,
          id: null,
          startedAt: null,
          endedAt: null,
          url: null,
          message: "Access denied: x",
        },
      ],
    });
  });

  it("matches nothing for a PR without a source commit", () => {
    const checks = checksFor("", [
      { provider: "codebuild", name: "p", runs: [run("p:1", "SUCCEEDED", [])] },
    ]);
    expect(checks.state).toBe("none");
  });
});

describe("lazyCiClient", () => {
  it("creates the client once, and again after a failed creation", async () => {
    const api: CiApi = { recentBuilds: async () => [], recentExecutions: async () => [] };
    const create = vi.fn().mockRejectedValueOnce(new Error("chunk")).mockResolvedValue(api);
    const client = lazyCiClient(create);
    await expect(client()).rejects.toThrow("chunk");
    expect(await client()).toBe(api);
    expect(await client()).toBe(api);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

const succeededApi = (): CiApi => ({
  recentBuilds: vi.fn(async () => [run("p:1", "SUCCEEDED", ["c1"])]),
  recentExecutions: async () => [],
});

describe("pullRequestChecks and repositoryRuns", () => {
  const config = { ci: { svc: { codebuild: ["p"] } } };

  it("is null for a repository ci does not list, without creating the client", async () => {
    const create = vi.fn(async () => succeededApi());
    expect(
      await pullRequestChecks(config, create, { repository: "other", sourceCommit: "c1" }),
    ).toBeNull();
    expect(await repositoryRuns(config, create)("other")).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it("matches the PR's source commit", async () => {
    const checks = await pullRequestChecks(config, async () => succeededApi(), {
      repository: "svc",
      sourceCommit: "c1",
    });
    expect(checks?.state).toBe("pass");
  });

  it("reads a repository's runs once", async () => {
    const ci = succeededApi();
    const runs = repositoryRuns(config, async () => ci);
    await Promise.all([runs("svc"), runs("svc")]);
    expect(await runs("svc")).toHaveLength(1);
    expect(ci.recentBuilds).toHaveBeenCalledTimes(1);
  });
});
