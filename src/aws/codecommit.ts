import {
  CodeCommitClient,
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
  type PullRequest as SdkPullRequest,
  UpdatePullRequestApprovalStateCommand,
  UpdatePullRequestStatusCommand,
} from "@aws-sdk/client-codecommit";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { limiter, mapLimit } from "./mapLimit.js";

export type PullRequestStatus = "OPEN" | "CLOSED";

export interface PullRequest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: PullRequestStatus;
  readonly authorArn: string;
  readonly repository: string;
  readonly sourceBranch: string;
  readonly destinationBranch: string;
  readonly sourceCommit: string;
  readonly destinationCommit: string;
  readonly isMerged: boolean;
  readonly revisionId: string;
  readonly creationDate: Date;
  readonly lastActivityDate: Date;
  /** The rules on this PR; `content` is the rule's JSON as CodeCommit stores it. */
  readonly approvalRules: readonly ApprovalRule[];
}

export interface ApprovalRule {
  readonly name: string;
  readonly content: string;
}

export interface RuleEvaluation {
  readonly approved: boolean;
  readonly overridden: boolean;
  readonly satisfied: readonly string[];
  readonly notSatisfied: readonly string[];
}

export interface NewPullRequest {
  readonly repository: string;
  readonly title: string;
  readonly description: string;
  readonly sourceBranch: string;
  readonly destinationBranch: string;
  readonly clientRequestToken: string;
}

export type MergeStrategy = "fast-forward" | "squash" | "three-way";

export type EntryType = "folder" | "file" | "symlink" | "submodule";

export interface FolderEntry {
  readonly name: string;
  readonly path: string;
  readonly type: EntryType;
}

export interface CodeCommitApi {
  /** The region the client calls, after the SDK's own resolution (~/.aws/config). */
  region(): Promise<string>;
  /** The caller's ARN (sts:GetCallerIdentity): "me" for the inbox. */
  callerArn(): Promise<string>;
  /** The access key ID of the credentials in use, read locally: the identity cache's key. */
  credentialId(): Promise<string>;
  /** Every repository name in the region, sorted by name. */
  listRepositories(): Promise<string[]>;
  defaultBranch(repository: string): Promise<string | undefined>;
  cloneUrls(repository: string): Promise<{ https: string; ssh: string }>;
  listBranches(repository: string): Promise<string[]>;
  deleteBranch(repository: string, branch: string): Promise<void>;
  /** Tip commit of a remote branch, or undefined when the branch does not exist. */
  branchCommit(repository: string, branch: string): Promise<string | undefined>;
  listPullRequestIds(
    repository: string,
    status: PullRequestStatus,
    limit: number,
  ): Promise<string[]>;
  getPullRequests(ids: readonly string[], concurrency: number): Promise<PullRequest[]>;
  createPullRequest(input: NewPullRequest): Promise<PullRequest>;
  approvers(pr: PullRequest): Promise<string[]>;
  evaluateApprovalRules(pr: PullRequest): Promise<RuleEvaluation>;
  mergeable(pr: PullRequest): Promise<boolean>;
  /** Posts a comment on the whole PR and returns its id. */
  postComment(pr: PullRequest, content: string): Promise<string>;
  setApproval(pr: PullRequest, approve: boolean): Promise<void>;
  /** Refuses when the source branch has moved past `pr.sourceCommit`. */
  merge(pr: PullRequest, strategy: MergeStrategy): Promise<PullRequest>;
  close(pr: PullRequest): Promise<PullRequest>;
  /** One level of a folder at `ref` ("" is the root), or undefined when there is no such folder. */
  getFolder(repository: string, ref: string, path: string): Promise<FolderEntry[] | undefined>;
  /** A file's bytes at `ref`, or undefined when there is no such file. */
  getFile(repository: string, ref: string, path: string): Promise<Uint8Array | undefined>;
}

type SdkEntry = { absolutePath?: string | undefined; relativePath?: string | undefined };

function entries(type: EntryType, list: SdkEntry[] | undefined): FolderEntry[] {
  return (list ?? []).map((e) => ({
    name: e.relativePath ?? "",
    path: e.absolutePath ?? "",
    type,
  }));
}

async function unlessMissing<T>(
  names: string | readonly string[],
  call: Promise<T>,
): Promise<T | undefined> {
  try {
    return await call;
  } catch (error) {
    if ([names].flat().includes((error as Error).name)) return undefined;
    throw error;
  }
}

export const MERGE_COMMANDS = {
  "fast-forward": MergePullRequestByFastForwardCommand,
  squash: MergePullRequestBySquashCommand,
  "three-way": MergePullRequestByThreeWayCommand,
} as const;

const HEADS = "refs/heads/";

function branchName(ref: string | undefined): string {
  return ref?.startsWith(HEADS) ? ref.slice(HEADS.length) : (ref ?? "");
}

/** Flattens the SDK shape. A PR whose first target is missing is a malformed response. */
export function toPullRequest(pr: SdkPullRequest | undefined): PullRequest {
  const target = pr?.pullRequestTargets?.[0];
  if (!pr?.pullRequestId || !target)
    throw new Error("CodeCommit returned a pull request without an id or target");
  return {
    id: pr.pullRequestId,
    title: pr.title ?? "",
    description: pr.description ?? "",
    status: pr.pullRequestStatus === "CLOSED" ? "CLOSED" : "OPEN",
    authorArn: pr.authorArn ?? "",
    repository: target.repositoryName ?? "",
    sourceBranch: branchName(target.sourceReference),
    destinationBranch: branchName(target.destinationReference),
    sourceCommit: target.sourceCommit ?? "",
    destinationCommit: target.destinationCommit ?? "",
    isMerged: target.mergeMetadata?.isMerged ?? false,
    revisionId: pr.revisionId ?? "",
    creationDate: pr.creationDate ?? new Date(0),
    lastActivityDate: pr.lastActivityDate ?? pr.creationDate ?? new Date(0),
    approvalRules: (pr.approvalRules ?? []).map((r) => ({
      name: r.approvalRuleName ?? "",
      content: r.approvalRuleContent ?? "",
    })),
  };
}

/** Every client, CLI and TUI alike: an unreachable endpoint fails in seconds instead of hanging. */
export function clientConfig(options: {
  region?: string | undefined;
  profile?: string | undefined;
}) {
  return {
    ...(options.region ? { region: options.region } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    requestHandler: {
      requestTimeout: 10_000,
      connectionTimeout: 5_000,
      throwOnRequestTimeout: true,
    },
  };
}

/**
 * `concurrency` caps the calls this client has in flight, across every caller
 * at once: the config's `concurrency` is a promise about the wire, which
 * screens that fan out several lists in parallel would otherwise multiply. A
 * call holds its slot through the SDK's retries and their backoff.
 */
export function createCodeCommitApi(options: {
  region?: string;
  profile?: string;
  concurrency: number;
}): CodeCommitApi {
  const config = clientConfig(options);
  const client = new CodeCommitClient(config);
  const run = limiter(options.concurrency);
  client.middlewareStack.add((next) => (args) => run(() => next(args)), {
    step: "initialize",
    name: "lazyccConcurrency",
  });

  return {
    region: () => client.config.region(),

    async callerArn() {
      const sts = new STSClient({ ...config, region: await client.config.region() });
      const out = await sts.send(new GetCallerIdentityCommand({}));
      if (!out.Arn) throw new Error("sts:GetCallerIdentity returned no ARN");
      return out.Arn;
    },

    async credentialId() {
      return (await client.config.credentials()).accessKeyId;
    },

    async listRepositories() {
      const names: string[] = [];
      let nextToken: string | undefined;
      do {
        const out = await client.send(
          new ListRepositoriesCommand({
            sortBy: "repositoryName",
            order: "ascending",
            ...(nextToken ? { nextToken } : {}),
          }),
        );
        for (const r of out.repositories ?? []) if (r.repositoryName) names.push(r.repositoryName);
        nextToken = out.nextToken;
      } while (nextToken);
      return names;
    },

    async defaultBranch(repository) {
      const out = await client.send(new GetRepositoryCommand({ repositoryName: repository }));
      return out.repositoryMetadata?.defaultBranch || undefined;
    },

    async cloneUrls(repository) {
      const out = await client.send(new GetRepositoryCommand({ repositoryName: repository }));
      const m = out.repositoryMetadata;
      if (!m?.cloneUrlHttp || !m.cloneUrlSsh)
        throw new Error(`CodeCommit returned no clone URL for ${repository}`);
      return { https: m.cloneUrlHttp, ssh: m.cloneUrlSsh };
    },

    async listBranches(repository) {
      const branches: string[] = [];
      let nextToken: string | undefined;
      do {
        const out = await client.send(
          new ListBranchesCommand({
            repositoryName: repository,
            ...(nextToken ? { nextToken } : {}),
          }),
        );
        branches.push(...(out.branches ?? []));
        nextToken = out.nextToken;
      } while (nextToken);
      return branches;
    },

    async deleteBranch(repository, branch) {
      await client.send(
        new DeleteBranchCommand({ repositoryName: repository, branchName: branch }),
      );
    },

    async branchCommit(repository, branch) {
      try {
        const out = await client.send(
          new GetBranchCommand({ repositoryName: repository, branchName: branch }),
        );
        return out.branch?.commitId || undefined;
      } catch (error) {
        if ((error as Error).name === "BranchDoesNotExistException") return undefined;
        throw error;
      }
    },

    async listPullRequestIds(repository, status, limit) {
      const ids: string[] = [];
      let nextToken: string | undefined;
      do {
        const out = await client.send(
          new ListPullRequestsCommand({
            repositoryName: repository,
            pullRequestStatus: status,
            maxResults: Math.min(100, limit - ids.length),
            ...(nextToken ? { nextToken } : {}),
          }),
        );
        ids.push(...(out.pullRequestIds ?? []));
        nextToken = out.nextToken;
      } while (nextToken && ids.length < limit);
      return ids.slice(0, limit);
    },

    getPullRequests(ids, concurrency) {
      return mapLimit(ids, concurrency, async (id) => {
        const out = await client.send(new GetPullRequestCommand({ pullRequestId: id }));
        return toPullRequest(out.pullRequest);
      });
    },

    async createPullRequest(input) {
      const out = await client.send(
        new CreatePullRequestCommand({
          title: input.title,
          description: input.description,
          clientRequestToken: input.clientRequestToken,
          targets: [
            {
              repositoryName: input.repository,
              sourceReference: input.sourceBranch,
              destinationReference: input.destinationBranch,
            },
          ],
        }),
      );
      return toPullRequest(out.pullRequest);
    },

    async approvers(pr) {
      const out = await client.send(
        new GetPullRequestApprovalStatesCommand({
          pullRequestId: pr.id,
          revisionId: pr.revisionId,
        }),
      );
      return (out.approvals ?? [])
        .filter((a) => a.approvalState === "APPROVE")
        .map((a) => a.userArn ?? "");
    },

    async evaluateApprovalRules(pr) {
      const out = await client.send(
        new EvaluatePullRequestApprovalRulesCommand({
          pullRequestId: pr.id,
          revisionId: pr.revisionId,
        }),
      );
      const e = out.evaluation;
      return {
        approved: e?.approved ?? false,
        overridden: e?.overridden ?? false,
        satisfied: e?.approvalRulesSatisfied ?? [],
        notSatisfied: e?.approvalRulesNotSatisfied ?? [],
      };
    },

    async mergeable(pr) {
      const out = await client.send(
        new GetMergeConflictsCommand({
          repositoryName: pr.repository,
          destinationCommitSpecifier: pr.destinationCommit,
          sourceCommitSpecifier: pr.sourceCommit,
          mergeOption: "THREE_WAY_MERGE",
          maxConflictFiles: 1,
        }),
      );
      return out.mergeable ?? false;
    },

    async postComment(pr, content) {
      const out = await client.send(
        new PostCommentForPullRequestCommand({
          pullRequestId: pr.id,
          repositoryName: pr.repository,
          beforeCommitId: pr.destinationCommit,
          afterCommitId: pr.sourceCommit,
          content,
        }),
      );
      if (!out.comment?.commentId) throw new Error("CodeCommit returned no comment");
      return out.comment.commentId;
    },

    async setApproval(pr, approve) {
      await client.send(
        new UpdatePullRequestApprovalStateCommand({
          pullRequestId: pr.id,
          revisionId: pr.revisionId,
          approvalState: approve ? "APPROVE" : "REVOKE",
        }),
      );
    },

    async merge(pr, strategy) {
      const Command = MERGE_COMMANDS[strategy];
      const out = await client.send(
        new Command({
          pullRequestId: pr.id,
          repositoryName: pr.repository,
          sourceCommitId: pr.sourceCommit,
        }),
      );
      return toPullRequest(out.pullRequest);
    },

    async close(pr) {
      const out = await client.send(
        new UpdatePullRequestStatusCommand({ pullRequestId: pr.id, pullRequestStatus: "CLOSED" }),
      );
      return toPullRequest(out.pullRequest);
    },

    async getFolder(repository, ref, path) {
      const out = await unlessMissing(
        // CodeCommit answers InvalidPathException for a file's path (realcheck).
        ["FolderDoesNotExistException", "InvalidPathException"],
        client.send(
          new GetFolderCommand({
            repositoryName: repository,
            commitSpecifier: ref,
            folderPath: path || "/",
          }),
        ),
      );
      if (!out) return undefined;
      return [
        ...entries("folder", out.subFolders),
        ...entries("file", out.files),
        ...entries("symlink", out.symbolicLinks),
        ...entries("submodule", out.subModules),
      ];
    },

    async getFile(repository, ref, path) {
      const out = await unlessMissing(
        "FileDoesNotExistException",
        client.send(
          new GetFileCommand({ repositoryName: repository, commitSpecifier: ref, filePath: path }),
        ),
      );
      return out && (out.fileContent ?? new Uint8Array());
    },
  };
}
