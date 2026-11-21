import {
  CodeCommitClient,
  CreateBranchCommand,
  CreateCommitCommand,
  CreatePullRequestCommand,
  DeleteBranchCommand,
  EvaluatePullRequestApprovalRulesCommand,
  GetBranchCommand,
  GetFileCommand,
  GetFolderCommand,
  GetMergeConflictsCommand,
  GetPullRequestApprovalStatesCommand,
  GetPullRequestCommand,
  GetRepositoryCommand,
  ListBranchesCommand,
  ListPullRequestsCommand,
  ListRepositoriesCommand,
  MergePullRequestByFastForwardCommand,
  MergePullRequestBySquashCommand,
  MergePullRequestByThreeWayCommand,
  PostCommentForPullRequestCommand,
  UpdatePullRequestApprovalStateCommand,
  UpdatePullRequestStatusCommand,
} from "@aws-sdk/client-codecommit";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientConfig,
  createCodeCommitApi,
  type PullRequest,
  toPullRequest,
} from "./codecommit.js";
import { mapLimit } from "./mapLimit.js";

const cc = mockClient(CodeCommitClient);
const sts = mockClient(STSClient);
afterEach(() => {
  cc.reset();
  sts.reset();
});

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

describe("clientConfig", () => {
  it("gives every client the same timeouts, with region and profile when set", () => {
    const timeouts = {
      requestHandler: {
        requestTimeout: 10_000,
        connectionTimeout: 5_000,
        throwOnRequestTimeout: true,
      },
    };
    expect(clientConfig({ region: "eu-west-1", profile: "dev" })).toEqual({
      region: "eu-west-1",
      profile: "dev",
      ...timeouts,
    });
    expect(clientConfig({})).toEqual(timeouts);
  });
});

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
      approvalRules: [],
    });
  });

  it("keeps the approval rules' names and content", () => {
    const withRules = toPullRequest(
      sdkPr("7", {
        approvalRules: [{ approvalRuleName: "two", approvalRuleContent: "{}" }, {}],
      }),
    );
    expect(withRules.approvalRules).toEqual([
      { name: "two", content: "{}" },
      { name: "", content: "" },
    ]);
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
      authorArn: "",
      repository: "",
      sourceCommit: "",
      destinationCommit: "",
      revisionId: "",
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
  const api = createCodeCommitApi({ region: "ap-northeast-1", profile: "dev", concurrency: 8 });

  it("passes region and profile to the client", async () => {
    cc.on(GetRepositoryCommand).resolves({ repositoryMetadata: { defaultBranch: "main" } });
    expect(await api.defaultBranch("demo")).toBe("main");
    expect(cc.commandCalls(GetRepositoryCommand)[0]?.args[0].input).toEqual({
      repositoryName: "demo",
    });
    expect(await createCodeCommitApi({ concurrency: 8 }).defaultBranch("demo")).toBe("main");
  });

  it("reports the region the client resolved", async () => {
    expect(await api.region()).toBe("ap-northeast-1");
  });

  it("asks STS who the caller is", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Arn: "arn:aws:iam::1:user/me" });
    expect(await api.callerArn()).toBe("arn:aws:iam::1:user/me");
    sts.on(GetCallerIdentityCommand).resolves({});
    await expect(api.callerArn()).rejects.toThrow("no ARN");
  });

  it("asks STS in the client's region", async () => {
    let region: string | undefined;
    sts.on(GetCallerIdentityCommand).callsFake(async (_input, getClient) => {
      region = await getClient().config.region();
      return { Arn: "arn:aws:iam::1:user/me" };
    });
    await createCodeCommitApi({ region: "eu-west-3", concurrency: 1 }).callerArn();
    expect(region).toBe("eu-west-3");
  });

  it("names the access key it signs with", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    try {
      const keyed = createCodeCommitApi({ region: "eu-west-3", concurrency: 1 });
      expect(await keyed.credentialId()).toBe("AKIDEXAMPLE");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lists every repository across pages", async () => {
    cc.on(ListRepositoriesCommand)
      .resolvesOnce({ repositories: [{ repositoryName: "a" }, {}], nextToken: "t" })
      .resolves({ repositories: [{ repositoryName: "b" }] });
    expect(await api.listRepositories()).toEqual(["a", "b"]);
    expect(cc.commandCalls(ListRepositoriesCommand).map((c) => c.args[0].input)).toStrictEqual([
      { sortBy: "repositoryName", order: "ascending" },
      { sortBy: "repositoryName", order: "ascending", nextToken: "t" },
    ]);
    cc.on(ListRepositoriesCommand).resolves({});
    expect(await api.listRepositories()).toEqual([]);
  });

  it("returns undefined for an empty repository", async () => {
    cc.on(GetRepositoryCommand).resolves({ repositoryMetadata: {} });
    expect(await api.defaultBranch("demo")).toBeUndefined();
  });

  it("lists every branch across pages", async () => {
    cc.on(ListBranchesCommand, { nextToken: undefined }).resolves({
      branches: ["a"],
      nextToken: "t",
    });
    cc.on(ListBranchesCommand, { nextToken: "t" }).resolves({ branches: ["b"] });
    expect(await api.listBranches("demo")).toEqual(["a", "b"]);
    expect(cc.commandCalls(ListBranchesCommand).map((c) => c.args[0].input)).toStrictEqual([
      { repositoryName: "demo" },
      { repositoryName: "demo", nextToken: "t" },
    ]);
    cc.on(ListBranchesCommand).resolves({});
    expect(await api.listBranches("demo")).toEqual([]);
  });

  it("deletes a branch", async () => {
    cc.on(DeleteBranchCommand).resolves({});
    await api.deleteBranch("demo", "old");
    expect(cc.commandCalls(DeleteBranchCommand)[0]?.args[0].input).toEqual({
      repositoryName: "demo",
      branchName: "old",
    });
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
    expect(calls).toStrictEqual([
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

  it("posts a comment on the whole PR, against its current commits", async () => {
    cc.on(PostCommentForPullRequestCommand).resolves({ comment: { commentId: "c9" } });
    expect(await api.postComment(pr, "LGTM")).toBe("c9");
    expect(cc.commandCalls(PostCommentForPullRequestCommand)[0]?.args[0].input).toEqual({
      pullRequestId: "7",
      repositoryName: "demo",
      beforeCommitId: "d1",
      afterCommitId: "s1",
      content: "LGTM",
    });
    cc.on(PostCommentForPullRequestCommand).resolves({});
    await expect(api.postComment(pr, "x")).rejects.toThrow("no comment");
  });

  it.each([
    [true, "APPROVE"],
    [false, "REVOKE"],
  ] as const)("sets the approval (approve=%s) on the current revision", async (approve, state) => {
    cc.on(UpdatePullRequestApprovalStateCommand).resolves({});
    await api.setApproval(pr, approve);
    expect(cc.commandCalls(UpdatePullRequestApprovalStateCommand)[0]?.args[0].input).toEqual({
      pullRequestId: "7",
      revisionId: "rev7",
      approvalState: state,
    });
  });

  it.each([
    ["fast-forward", MergePullRequestByFastForwardCommand],
    ["squash", MergePullRequestBySquashCommand],
    ["three-way", MergePullRequestByThreeWayCommand],
  ] as const)(
    "merges by %s, only if the source is still the commit we saw",
    async (strategy, command) => {
      cc.on(command).resolves({ pullRequest: sdkPr("7", { pullRequestStatus: "CLOSED" }) });
      expect((await api.merge(pr, strategy)).status).toBe("CLOSED");
      expect(cc.commandCalls(command)[0]?.args[0].input).toEqual({
        pullRequestId: "7",
        repositoryName: "demo",
        sourceCommitId: "s1",
      });
    },
  );

  it("closes a PR", async () => {
    cc.on(UpdatePullRequestStatusCommand).resolves({
      pullRequest: sdkPr("7", { pullRequestStatus: "CLOSED" }),
    });
    expect((await api.close(pr)).status).toBe("CLOSED");
    expect(cc.commandCalls(UpdatePullRequestStatusCommand)[0]?.args[0].input).toEqual({
      pullRequestId: "7",
      pullRequestStatus: "CLOSED",
    });
  });

  it("lists a folder's entries by kind, and says when it does not exist", async () => {
    cc.on(GetFolderCommand).resolves({
      subFolders: [{ absolutePath: "src/lib", relativePath: "lib" }],
      files: [{ absolutePath: "src/a.ts", relativePath: "a.ts" }, {}],
      symbolicLinks: [{ absolutePath: "src/l", relativePath: "l" }],
      subModules: [{ absolutePath: "src/vendor", relativePath: "vendor" }],
    });
    expect(await api.getFolder("demo", "main", "src")).toEqual([
      { name: "lib", path: "src/lib", type: "folder" },
      { name: "a.ts", path: "src/a.ts", type: "file" },
      { name: "", path: "", type: "file" },
      { name: "l", path: "src/l", type: "symlink" },
      { name: "vendor", path: "src/vendor", type: "submodule" },
    ]);
    expect(cc.commandCalls(GetFolderCommand)[0]?.args[0].input).toEqual({
      repositoryName: "demo",
      commitSpecifier: "main",
      folderPath: "src",
    });
    await api.getFolder("demo", "main", "");
    expect(cc.commandCalls(GetFolderCommand)[1]?.args[0].input.folderPath).toBe("/");
    cc.on(GetFolderCommand).resolves({});
    expect(await api.getFolder("demo", "main", "")).toEqual([]);
    cc.on(GetFolderCommand).rejects(
      Object.assign(new Error("no"), { name: "FolderDoesNotExistException" }),
    );
    expect(await api.getFolder("demo", "main", "x")).toBeUndefined();
    // What CodeCommit answers for a file's path (realcheck, 2026-11-18).
    cc.on(GetFolderCommand).rejects(
      Object.assign(new Error("not a folder"), { name: "InvalidPathException" }),
    );
    expect(await api.getFolder("demo", "main", "a.txt")).toBeUndefined();
    cc.on(GetFolderCommand).rejects(new Error("boom"));
    await expect(api.getFolder("demo", "main", "x")).rejects.toThrow("boom");
  });

  it("reads a file's bytes, and says when it does not exist", async () => {
    cc.on(GetFileCommand).resolves({ fileContent: new Uint8Array([104, 105]), fileSize: 2 });
    expect(await api.getFile("demo", "main", "a.txt")).toEqual(new Uint8Array([104, 105]));
    expect(cc.commandCalls(GetFileCommand)[0]?.args[0].input).toEqual({
      repositoryName: "demo",
      commitSpecifier: "main",
      filePath: "a.txt",
    });
    cc.on(GetFileCommand).resolves({});
    expect(await api.getFile("demo", "main", "a.txt")).toEqual(new Uint8Array());
    cc.on(GetFileCommand).rejects(
      Object.assign(new Error("no"), { name: "FileDoesNotExistException" }),
    );
    expect(await api.getFile("demo", "main", "a.txt")).toBeUndefined();
    cc.on(GetFileCommand).rejects(new Error("boom"));
    await expect(api.getFile("demo", "main", "a.txt")).rejects.toThrow("boom");
  });

  it("creates a branch at a commit", async () => {
    cc.on(CreateBranchCommand).resolves({});
    await api.createBranch("demo", "issues", "c0");
    expect(cc.commandCalls(CreateBranchCommand)[0]?.args[0].input).toEqual({
      repositoryName: "demo",
      branchName: "issues",
      commitId: "c0",
    });
  });

  it("commits files as UTF-8 on top of a parent, or as the first commit", async () => {
    cc.on(CreateCommitCommand).resolves({ commitId: "c1" });
    expect(
      await api.createCommit({
        repository: "demo",
        branch: "issues",
        parent: "c0",
        message: "issue #1: create",
        files: [{ path: "issue/1/issue.md", content: "é" }],
      }),
    ).toBe("c1");
    expect(cc.commandCalls(CreateCommitCommand)[0]?.args[0].input).toEqual({
      repositoryName: "demo",
      branchName: "issues",
      parentCommitId: "c0",
      commitMessage: "issue #1: create",
      putFiles: [{ filePath: "issue/1/issue.md", fileContent: new Uint8Array([0xc3, 0xa9]) }],
    });
    await api.createCommit({ repository: "demo", branch: "issues", message: "m", files: [] });
    expect(cc.commandCalls(CreateCommitCommand)[1]?.args[0].input).not.toHaveProperty(
      "parentCommitId",
    );
    cc.on(CreateCommitCommand).resolves({});
    await expect(
      api.createCommit({ repository: "demo", branch: "issues", message: "m", files: [] }),
    ).rejects.toThrow("CodeCommit returned no commit id");
  });
});
