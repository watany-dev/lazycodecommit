import {
  CodeCommitClient,
  CreatePullRequestCommand,
  EvaluatePullRequestApprovalRulesCommand,
  GetBranchCommand,
  GetMergeConflictsCommand,
  GetPullRequestApprovalStatesCommand,
  GetPullRequestCommand,
  GetRepositoryCommand,
  ListPullRequestsCommand,
} from "@aws-sdk/client-codecommit";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeCommitApi, mapLimit, type PullRequest, toPullRequest } from "./codecommit.js";

const cc = mockClient(CodeCommitClient);
afterEach(() => cc.reset());

const sdkPr = (id: string, extra: object = {}) => ({
  pullRequestId: id,
  title: `PR ${id}`,
  description: "body",
  pullRequestStatus: "OPEN" as const,
  authorArn: "arn:aws:iam::1:user/alice",
  revisionId: `rev${id}`,
  creationDate: new Date("2026-01-01T00:00:00Z"),
  lastActivityDate: new Date("2026-01-02T00:00:00Z"),
  pullRequestTargets: [
    {
      repositoryName: "demo",
      sourceReference: "refs/heads/topic",
      destinationReference: "refs/heads/main",
      sourceCommit: "s1",
      destinationCommit: "d1",
      mergeMetadata: { isMerged: false },
    },
  ],
  ...extra,
});

const pr: PullRequest = toPullRequest(sdkPr("7"));

describe("toPullRequest", () => {
  it("flattens the first target", () => {
    expect(pr).toEqual({
      id: "7",
      title: "PR 7",
      description: "body",
      status: "OPEN",
      authorArn: "arn:aws:iam::1:user/alice",
      repository: "demo",
      sourceBranch: "topic",
      destinationBranch: "main",
      sourceCommit: "s1",
      destinationCommit: "d1",
      isMerged: false,
      revisionId: "rev7",
      creationDate: new Date("2026-01-01T00:00:00Z"),
      lastActivityDate: new Date("2026-01-02T00:00:00Z"),
    });
  });

  it("fills defaults for missing fields", () => {
    const sparse = toPullRequest({
      pullRequestId: "1",
      pullRequestStatus: "CLOSED",
      pullRequestTargets: [{ sourceReference: "topic" }],
    });
    expect(sparse).toMatchObject({
      title: "",
      description: "",
      status: "CLOSED",
      sourceBranch: "topic",
      destinationBranch: "",
      isMerged: false,
      creationDate: new Date(0),
      lastActivityDate: new Date(0),
    });
  });

  it("rejects a PR without a target", () => {
    expect(() => toPullRequest({ pullRequestId: "1" })).toThrow(/without an id or target/);
    expect(() => toPullRequest(undefined)).toThrow();
  });
});

describe("mapLimit", () => {
  it("keeps order and caps concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 - n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 8, async () => 1)).toEqual([]);
  });
});

describe("createCodeCommitApi", () => {
  const api = createCodeCommitApi({ region: "ap-northeast-1", profile: "dev" });

  it("passes region and profile to the client", async () => {
    cc.on(GetRepositoryCommand).resolves({ repositoryMetadata: { defaultBranch: "main" } });
    expect(await api.defaultBranch("demo")).toBe("main");
    expect(cc.commandCalls(GetRepositoryCommand)[0]?.args[0].input).toEqual({
      repositoryName: "demo",
    });
    expect(await createCodeCommitApi({}).defaultBranch("demo")).toBe("main");
  });

  it("reports the region the client resolved", async () => {
    expect(await api.region()).toBe("ap-northeast-1");
  });

  it("returns undefined for an empty repository", async () => {
    cc.on(GetRepositoryCommand).resolves({ repositoryMetadata: {} });
    expect(await api.defaultBranch("demo")).toBeUndefined();
  });

  it("reads the clone URLs", async () => {
    cc.on(GetRepositoryCommand).resolves({
      repositoryMetadata: { cloneUrlHttp: "https://h/demo", cloneUrlSsh: "ssh://h/demo" },
    });
    expect(await api.cloneUrls("demo")).toEqual({ https: "https://h/demo", ssh: "ssh://h/demo" });
    cc.on(GetRepositoryCommand).resolves({
      repositoryMetadata: { cloneUrlHttp: "https://h/demo" },
    });
    await expect(api.cloneUrls("demo")).rejects.toThrow("no clone URL for demo");
  });

  it("reads a branch tip, or undefined when it does not exist", async () => {
    cc.on(GetBranchCommand, { branchName: "topic" }).resolves({ branch: { commitId: "c1" } });
    const missing = Object.assign(new Error("no"), { name: "BranchDoesNotExistException" });
    cc.on(GetBranchCommand, { branchName: "gone" }).rejects(missing);
    cc.on(GetBranchCommand, { branchName: "empty" }).resolves({});
    expect(await api.branchCommit("demo", "topic")).toBe("c1");
    expect(await api.branchCommit("demo", "gone")).toBeUndefined();
    expect(await api.branchCommit("demo", "empty")).toBeUndefined();
  });

  it("rethrows other GetBranch errors", async () => {
    cc.on(GetBranchCommand).rejects(
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
    );
    await expect(api.branchCommit("demo", "topic")).rejects.toThrow("denied");
  });

  it("pages through ListPullRequests up to the limit", async () => {
    cc.on(ListPullRequestsCommand)
      .resolvesOnce({ pullRequestIds: ["1", "2"], nextToken: "t" })
      .resolvesOnce({ pullRequestIds: ["3", "4"], nextToken: "u" })
      .resolves({ pullRequestIds: ["5"] });
    expect(await api.listPullRequestIds("demo", "OPEN", 3)).toEqual(["1", "2", "3"]);
    const calls = cc.commandCalls(ListPullRequestsCommand).map((c) => c.args[0].input);
    expect(calls).toEqual([
      { repositoryName: "demo", pullRequestStatus: "OPEN", maxResults: 3 },
      { repositoryName: "demo", pullRequestStatus: "OPEN", maxResults: 1, nextToken: "t" },
    ]);
  });

  it("stops when there are no more pages", async () => {
    cc.on(ListPullRequestsCommand).resolves({});
    expect(await api.listPullRequestIds("demo", "CLOSED", 100)).toEqual([]);
  });

  it("gets pull requests", async () => {
    cc.on(GetPullRequestCommand, { pullRequestId: "7" }).resolves({ pullRequest: sdkPr("7") });
    cc.on(GetPullRequestCommand, { pullRequestId: "8" }).resolves({ pullRequest: sdkPr("8") });
    expect((await api.getPullRequests(["8", "7"], 2)).map((p) => p.id)).toEqual(["8", "7"]);
  });

  it("creates a pull request with the token", async () => {
    cc.on(CreatePullRequestCommand).resolves({ pullRequest: sdkPr("9") });
    const created = await api.createPullRequest({
      repository: "demo",
      title: "t",
      description: "d",
      sourceBranch: "topic",
      destinationBranch: "main",
      clientRequestToken: "tok",
    });
    expect(created.id).toBe("9");
    expect(cc.commandCalls(CreatePullRequestCommand)[0]?.args[0].input).toEqual({
      title: "t",
      description: "d",
      clientRequestToken: "tok",
      targets: [{ repositoryName: "demo", sourceReference: "topic", destinationReference: "main" }],
    });
  });

  it("lists approvers who approved", async () => {
    cc.on(GetPullRequestApprovalStatesCommand).resolves({
      approvals: [
        { userArn: "arn:a", approvalState: "APPROVE" },
        { userArn: "arn:b", approvalState: "REVOKE" },
        { approvalState: "APPROVE" },
      ],
    });
    expect(await api.approvers(pr)).toEqual(["arn:a", ""]);
    expect(cc.commandCalls(GetPullRequestApprovalStatesCommand)[0]?.args[0].input).toEqual({
      pullRequestId: "7",
      revisionId: "rev7",
    });
    cc.on(GetPullRequestApprovalStatesCommand).resolves({});
    expect(await api.approvers(pr)).toEqual([]);
  });

  it("evaluates approval rules", async () => {
    cc.on(EvaluatePullRequestApprovalRulesCommand).resolves({
      evaluation: {
        approved: true,
        overridden: false,
        approvalRulesSatisfied: ["a"],
        approvalRulesNotSatisfied: [],
      },
    });
    expect(await api.evaluateApprovalRules(pr)).toEqual({
      approved: true,
      overridden: false,
      satisfied: ["a"],
      notSatisfied: [],
    });
    cc.on(EvaluatePullRequestApprovalRulesCommand).resolves({});
    expect(await api.evaluateApprovalRules(pr)).toEqual({
      approved: false,
      overridden: false,
      satisfied: [],
      notSatisfied: [],
    });
  });

  it("checks mergeability with a three-way merge", async () => {
    cc.on(GetMergeConflictsCommand).resolves({ mergeable: true });
    expect(await api.mergeable(pr)).toBe(true);
    expect(cc.commandCalls(GetMergeConflictsCommand)[0]?.args[0].input).toEqual({
      repositoryName: "demo",
      destinationCommitSpecifier: "d1",
      sourceCommitSpecifier: "s1",
      mergeOption: "THREE_WAY_MERGE",
      maxConflictFiles: 1,
    });
    cc.on(GetMergeConflictsCommand).resolves({});
    expect(await api.mergeable(pr)).toBe(false);
  });
});
