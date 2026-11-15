import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
} from "@aws-sdk/client-codebuild";
import { CodePipelineClient, ListPipelineExecutionsCommand } from "@aws-sdk/client-codepipeline";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { buildUrl, createCiApi, executionUrl } from "./ci.js";

const cb = mockClient(CodeBuildClient);
const cp = mockClient(CodePipelineClient);
afterEach(() => {
  cb.reset();
  cp.reset();
});

const api = () => createCiApi({ region: "ap-northeast-1" });
const arn = (id: string) => `arn:aws:codebuild:ap-northeast-1:123456789012:build/${id}`;

describe("recentBuilds", () => {
  it("reads the newest builds in list order, with the commit each built", async () => {
    cb.on(ListBuildsForProjectCommand, { projectName: "check", sortOrder: "DESCENDING" }).resolves({
      ids: ["check:3", "check:2", "check:1"],
    });
    // BatchGetBuilds answers in its own order and may leave one out.
    cb.on(BatchGetBuildsCommand, { ids: ["check:3", "check:2"] }).resolves({
      builds: [
        {
          id: "check:2",
          arn: arn("check:2"),
          buildStatus: "FAILED",
          resolvedSourceVersion: "c2",
          startTime: new Date("2026-11-15T10:00:00Z"),
          endTime: new Date("2026-11-15T10:04:00Z"),
        },
        { id: "check:9", arn: arn("check:9") },
      ],
    });
    const runs = await api().recentBuilds("check", 2);
    expect(runs).toEqual([
      {
        id: "check:2",
        status: "FAILED",
        commits: ["c2"],
        startedAt: new Date("2026-11-15T10:00:00Z"),
        endedAt: new Date("2026-11-15T10:04:00Z"),
        url: "https://ap-northeast-1.console.aws.amazon.com/codesuite/codebuild/123456789012/projects/check/build/check%3A2/?region=ap-northeast-1",
      },
    ]);
  });

  it("keeps a build with no status or source version, matching no commit", async () => {
    cb.on(ListBuildsForProjectCommand).resolves({ ids: ["p:1"] });
    cb.on(BatchGetBuildsCommand).resolves({ builds: [{ id: "p:1" }] });
    const [run] = await api().recentBuilds("p", 20);
    expect(run).toMatchObject({ status: "", commits: [], startedAt: undefined });
  });

  it("takes a commit ID it was started on while the source is not resolved yet", async () => {
    // A queued build has no resolvedSourceVersion until it downloads the source.
    const commit = "0123456789abcdef0123456789abcdef01234567";
    cb.on(ListBuildsForProjectCommand).resolves({ ids: ["p:2", "p:1"] });
    cb.on(BatchGetBuildsCommand).resolves({
      builds: [
        { id: "p:2", buildStatus: "IN_PROGRESS", sourceVersion: commit },
        { id: "p:1", buildStatus: "IN_PROGRESS", sourceVersion: "refs/heads/main" },
      ],
    });
    const runs = await api().recentBuilds("p", 20);
    expect(runs.map((r) => r.commits)).toEqual([[commit], []]);
  });

  it("does not call BatchGetBuilds for a project with no builds", async () => {
    cb.on(ListBuildsForProjectCommand).resolves({});
    expect(await api().recentBuilds("empty", 20)).toEqual([]);
    expect(cb.commandCalls(BatchGetBuildsCommand)).toHaveLength(0);
  });
});

describe("recentExecutions", () => {
  it("reads every source revision and leaves a running execution's end unset", async () => {
    cp.on(ListPipelineExecutionsCommand, { pipelineName: "release", maxResults: 20 }).resolves({
      pipelineExecutionSummaries: [
        {
          pipelineExecutionId: "e2",
          status: "InProgress",
          startTime: new Date("2026-11-15T10:00:00Z"),
          lastUpdateTime: new Date("2026-11-15T10:01:00Z"),
          sourceRevisions: [{ actionName: "Source", revisionId: "c2" }, { actionName: "Other" }],
        },
        {
          pipelineExecutionId: "e1",
          status: "Succeeded",
          startTime: new Date("2026-11-15T09:00:00Z"),
          lastUpdateTime: new Date("2026-11-15T09:10:00Z"),
        },
        { status: "Failed" },
      ],
    });
    expect(await api().recentExecutions("release", 20)).toEqual([
      {
        id: "e2",
        status: "InProgress",
        commits: ["c2"],
        startedAt: new Date("2026-11-15T10:00:00Z"),
        endedAt: undefined,
        url: "https://ap-northeast-1.console.aws.amazon.com/codesuite/codepipeline/pipelines/release/executions/e2/timeline?region=ap-northeast-1",
      },
      {
        id: "e1",
        status: "Succeeded",
        commits: [],
        startedAt: new Date("2026-11-15T09:00:00Z"),
        endedAt: new Date("2026-11-15T09:10:00Z"),
        url: executionUrl("ap-northeast-1", "release", "e1"),
      },
    ]);
  });

  it("returns nothing for a pipeline that never ran", async () => {
    cp.on(ListPipelineExecutionsCommand).resolves({});
    expect(await api().recentExecutions("idle", 20)).toEqual([]);
  });
});

describe("console URLs", () => {
  it("use the partition's console host (GovCloud, China)", () => {
    expect(executionUrl("us-gov-west-1", "p", "e")).toBe(
      "https://console.amazonaws-us-gov.com/codesuite/codepipeline/pipelines/p/executions/e/timeline?region=us-gov-west-1",
    );
    expect(buildUrl("cn-north-1", "arn:aws-cn:codebuild:cn-north-1:1:build/p:1", "p", "p:1")).toBe(
      "https://cn-north-1.console.amazonaws.cn/codesuite/codebuild/1/projects/p/build/p%3A1/?region=cn-north-1",
    );
  });

  it("escapes names and tolerates an ARN without an account", () => {
    expect(buildUrl("us-east-1", "", "a b", "a b:1")).toBe(
      "https://us-east-1.console.aws.amazon.com/codesuite/codebuild//projects/a%20b/build/a%20b%3A1/?region=us-east-1",
    );
  });
});
