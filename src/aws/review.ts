import {
  type Approval,
  CodeCommitClient,
  type Comment,
  DeleteCommentContentCommand,
  DescribePullRequestEventsCommand,
  type Difference,
  EvaluatePullRequestApprovalRulesCommand,
  type Evaluation,
  GetBlobCommand,
  GetCommentReactionsCommand,
  GetCommentsForPullRequestCommand,
  GetCommitCommand,
  GetDifferencesCommand,
  GetMergeConflictsCommand,
  GetPullRequestApprovalStatesCommand,
  GetPullRequestCommand,
  ListPullRequestsCommand,
  PostCommentForPullRequestCommand,
  type PostCommentForPullRequestCommandOutput,
  PostCommentReplyCommand,
  type PostCommentReplyCommandOutput,
  type PullRequest,
  type PullRequestEvent,
  type PullRequestTarget,
  PutCommentReactionCommand,
  UpdateCommentCommand,
  UpdatePullRequestApprovalStateCommand,
  UpdatePullRequestStatusCommand,
} from "@aws-sdk/client-codecommit";
import { MERGE_COMMANDS, type MergeStrategy } from "./codecommit.js";
import { markNotSent } from "./errors.js";
import { mapLimit } from "./mapLimit.js";

/** Foreground list fetch: 25 IDs at 10-wide is 3 waves instead of 5. */
const LIST_PULL_REQUEST_CONCURRENCY = 10;

/** Background reaction fetch: 100 comments at 15-wide is ~7 waves instead of 20. */
const REACTION_FETCH_CONCURRENCY = 15;

export type PullRequestDisplayStatus = "OPEN" | "CLOSED" | "MERGED";

export interface PullRequestSummary {
  pullRequestId: string;
  title: string;
  authorArn: string;
  creationDate: Date;
  status: PullRequestDisplayStatus;
}

export interface CommentThread {
  location: {
    filePath: string;
    filePosition: number;
    relativeFileVersion: "BEFORE" | "AFTER";
  } | null;
  /** Inline, and written on an earlier source tip: its line may be elsewhere now. */
  outdated?: boolean;
  comments: Comment[];
}

export interface PullRequestDetail {
  pullRequest: PullRequest;
  differences: Difference[];
  commentThreads: CommentThread[];
}

const byCreation = (a: Comment, b: Comment) =>
  (a.creationDate?.getTime() ?? 0) - (b.creationDate?.getTime() ?? 0);

/**
 * CodeCommit groups comments by location and commits, so one group can hold
 * several threads: each comment that answers nothing in the group starts one,
 * and a reply joins the thread of the comment it answers. Root first, then
 * the replies oldest first.
 */
function splitThreads(comments: Comment[]): Comment[][] {
  const byId = new Map(comments.map((c) => [c.commentId, c]));
  const rootOf = (c: Comment): Comment => {
    const seen = new Set<Comment>();
    let at = c;
    while (at.inReplyTo && !seen.has(at)) {
      seen.add(at);
      const parent = byId.get(at.inReplyTo);
      if (!parent) break;
      at = parent;
    }
    return at;
  };
  const threads = new Map<Comment, Comment[]>();
  for (const c of comments) {
    const root = rootOf(c);
    if (!threads.has(root)) threads.set(root, []);
    if (c !== root) threads.get(root)?.push(c);
  }
  return [...threads].map(([root, replies]) => [root, ...replies.toSorted(byCreation)]);
}

/**
 * Where a post is seen reaching the HTTP handler. An error raised before it
 * (no region, no credentials, a bad endpoint) is marked as not sent, so a
 * draft is not locked as possibly posted (core/commentDrafts.ts).
 */
const REACHED_HANDLER = {
  step: "deserialize",
  priority: "low",
  name: "lazyccReachedHandler",
} as const;

/** Sends a post; an error raised before it reached the handler is marked as not sent. */
async function sendMarked<Output extends object>(
  client: CodeCommitClient,
  command: PostCommentForPullRequestCommand | PostCommentReplyCommand,
): Promise<Output> {
  let reached = false;
  // Either command's stack takes the same middleware; it only notes the step.
  (command as PostCommentReplyCommand).middlewareStack.add(
    (next) => (args) => {
      reached = true;
      return next(args);
    },
    REACHED_HANDLER,
  );
  try {
    return (await client.send(command as PostCommentReplyCommand)) as Output;
  } catch (error) {
    if (!reached) markNotSent(error);
    throw error;
  }
}

const MERGE_OPTIONS = {
  "fast-forward": "FAST_FORWARD_MERGE",
  squash: "SQUASH_MERGE",
  "three-way": "THREE_WAY_MERGE",
} as const satisfies Record<MergeStrategy, string>;

export interface ConflictSummary {
  mergeable: boolean;
  conflictCount: number;
  conflictFiles: string[];
}

export interface CommitInfo {
  commitId: string;
  shortId: string;
  message: string;
  authorName: string;
  authorDate: Date;
  parentIds: string[];
}

/** CodeCommit's commit dates read like git's raw format: "1484167798 -0800". */
function commitDate(date: string | undefined): Date {
  const seconds = /^(\d+)(?: [+-]\d{4})?$/.exec(date ?? "")?.[1];
  return seconds ? new Date(Number(seconds) * 1000) : new Date();
}

/** The most commits the review screen lists for one PR. */
export const MAX_COMMITS = 100;

/** Aggregated reaction information for a single comment */
export interface ReactionSummary {
  emoji: string;
  shortCode: string;
  count: number;
  userArns: string[];
}

export type ReactionsByComment = Map<string, ReactionSummary[]>;

/** PR アクティビティイベントの表示用データ */
export interface PrActivityEvent {
  eventDate: Date;
  eventType: string;
  actorArn: string;
  description: string;
}

interface PullRequestActivityResult {
  events: PrActivityEvent[];
  nextToken?: string;
}

function mapPrEvent(event: PullRequestEvent): PrActivityEvent {
  const actorArn = event.actorArn ?? "";
  const eventDate = event.eventDate ?? new Date(0);
  const eventType = event.pullRequestEventType ?? "UNKNOWN";
  const description = buildEventDescription(event);

  return { eventDate, eventType, actorArn, description };
}

function buildEventDescription(event: PullRequestEvent): string {
  // Cast to string so the switch can handle future/undocumented event types safely
  const type = (event.pullRequestEventType ?? "") as string;

  switch (type) {
    case "PULL_REQUEST_CREATED":
      return "created this PR";

    case "PULL_REQUEST_STATUS_CHANGED": {
      const status = event.pullRequestStatusChangedEventMetadata?.pullRequestStatus;
      if (status === "CLOSED") return "closed this PR";
      if (status === "OPEN") return "reopened this PR";
      return "changed PR status";
    }

    case "PULL_REQUEST_SOURCE_REFERENCE_UPDATED":
      return "updated the source branch";

    case "PULL_REQUEST_MERGE_STATE_CHANGED": {
      const merged = event.pullRequestMergedStateChangedEventMetadata?.mergeMetadata?.isMerged;
      if (merged) return "merged this PR";
      return "merge state changed";
    }

    case "PULL_REQUEST_APPROVAL_RULE_CREATED": {
      const name = event.approvalRuleEventMetadata?.approvalRuleName ?? "";
      return `created approval rule "${name}"`;
    }

    case "PULL_REQUEST_APPROVAL_RULE_DELETED": {
      const name = event.approvalRuleEventMetadata?.approvalRuleName ?? "";
      return `deleted approval rule "${name}"`;
    }

    case "PULL_REQUEST_APPROVAL_RULE_UPDATED": {
      const name = event.approvalRuleEventMetadata?.approvalRuleName ?? "";
      return `updated approval rule "${name}"`;
    }

    case "PULL_REQUEST_APPROVAL_RULE_OVERRIDDEN": {
      const overrideStatus = event.approvalRuleOverriddenEventMetadata?.overrideStatus;
      if (overrideStatus === "OVERRIDE") return "overrode approval rules";
      if (overrideStatus === "REVOKE") return "revoked approval rule override";
      return "changed approval rule override";
    }

    case "PULL_REQUEST_APPROVALS_RESET":
      return "approvals reset (source branch updated)";

    case "PULL_REQUEST_APPROVAL_STATE_CHANGED": {
      const approvalStatus = event.approvalStateChangedEventMetadata?.approvalStatus;
      if (approvalStatus === "APPROVE") return "approved this PR";
      if (approvalStatus === "REVOKE") return "revoked approval";
      return "changed approval state";
    }

    default:
      return type;
  }
}

/** Every call the review screen makes, on one client. */
export function createReviewApi(client: CodeCommitClient) {
  async function listPullRequests(
    repositoryName: string,
    nextToken?: string,
    pullRequestStatus?: "OPEN" | "CLOSED",
  ): Promise<{ pullRequests: PullRequestSummary[]; nextToken?: string }> {
    const listResponse = await client.send(
      new ListPullRequestsCommand({
        repositoryName,
        pullRequestStatus: pullRequestStatus ?? "OPEN",
        maxResults: 25,
        nextToken,
      }),
    );
    const pullRequestIds = listResponse.pullRequestIds ?? [];

    const pullRequests: PullRequestSummary[] = (
      await mapLimit(pullRequestIds, LIST_PULL_REQUEST_CONCURRENCY, async (id) => {
        const { pullRequest: pr } = await client.send(
          new GetPullRequestCommand({ pullRequestId: id }),
        );
        if (!pr) return null;

        const apiStatus = pr.pullRequestStatus ?? "OPEN";
        const isMerged = pr.pullRequestTargets?.[0]?.mergeMetadata?.isMerged === true;
        const displayStatus: PullRequestDisplayStatus =
          apiStatus === "CLOSED" && isMerged ? "MERGED" : (apiStatus as PullRequestDisplayStatus);

        return {
          pullRequestId: pr.pullRequestId ?? id,
          title: pr.title ?? "(no title)",
          authorArn: pr.authorArn ?? "unknown",
          creationDate: pr.creationDate ?? new Date(),
          status: displayStatus,
        };
      })
    ).filter((pr): pr is PullRequestSummary => pr !== null);

    return listResponse.nextToken
      ? { pullRequests, nextToken: listResponse.nextToken }
      : { pullRequests };
  }

  async function getAllDifferences(
    repositoryName: string,
    beforeCommitSpecifier: string,
    afterCommitSpecifier: string,
  ): Promise<Difference[]> {
    const allDifferences: Difference[] = [];
    let nextToken: string | undefined;
    do {
      const response = await client.send(
        new GetDifferencesCommand({
          repositoryName,
          beforeCommitSpecifier,
          afterCommitSpecifier,
          NextToken: nextToken,
        }),
      );
      allDifferences.push(...(response.differences ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return allDifferences;
  }

  /**
   * `loadDifferences` replaces the GetDifferences call, so a clone can diff with git
   * (spec: clone 内の diff). It gets the PR's first target, which has both commits.
   */
  async function getPullRequestDetail(
    pullRequestId: string,
    repositoryName: string,
    loadDifferences?: (target: PullRequestTarget) => Promise<Difference[]>,
  ): Promise<PullRequestDetail> {
    const { pullRequest } = await client.send(new GetPullRequestCommand({ pullRequestId }));
    if (!pullRequest) {
      throw new Error(`Pull request ${pullRequestId} not found.`);
    }

    const target = pullRequest.pullRequestTargets?.[0];
    const hasCommits = !!(target?.sourceCommit && target?.destinationCommit);

    const [differences, commentThreads] = await Promise.all([
      !hasCommits
        ? Promise.resolve([])
        : loadDifferences
          ? loadDifferences(target!)
          : getAllDifferences(repositoryName, target!.destinationCommit!, target!.sourceCommit!),
      getComments(pullRequestId, target?.sourceCommit),
    ]);

    return { pullRequest, differences, commentThreads };
  }

  /**
   * Every revision's comments. Filtering by the current tips (afterCommitId,
   * beforeCommitId) drops those written before a push, as realcheck showed on
   * CodeCommit; repositoryName alone is refused. `sourceCommit` is the current
   * source tip, against which inline threads are marked outdated.
   */
  async function getComments(
    pullRequestId: string,
    sourceCommit?: string,
  ): Promise<CommentThread[]> {
    // By location and commits: a page ends after maxResults comments, so one
    // line's comments can go on over the next page.
    const groups = new Map<
      string,
      { location: CommentThread["location"]; outdated: boolean; comments: Comment[] }
    >();
    let nextToken: string | undefined;
    do {
      const commentsResponse = await client.send(
        new GetCommentsForPullRequestCommand({ pullRequestId, nextToken }),
      );
      for (const thread of commentsResponse.commentsForPullRequestData ?? []) {
        const location = thread.location?.filePath
          ? {
              filePath: thread.location.filePath,
              filePosition: thread.location.filePosition ?? 0,
              relativeFileVersion:
                (thread.location.relativeFileVersion as "BEFORE" | "AFTER") ?? "AFTER",
            }
          : null;
        const key = JSON.stringify([thread.beforeCommitId, thread.afterCommitId, location]);
        let group = groups.get(key);
        if (!group) {
          const outdated =
            location !== null && !!sourceCommit && thread.afterCommitId !== sourceCommit;
          groups.set(key, (group = { location, outdated, comments: [] }));
        }
        group.comments.push(...(thread.comments ?? []));
      }
      nextToken = commentsResponse.nextToken;
    } while (nextToken);
    return [...groups.values()].flatMap(({ location, outdated, comments }) =>
      splitThreads(comments).map((thread) => ({
        location,
        ...(outdated ? { outdated } : {}),
        comments: thread,
      })),
    );
  }

  async function postComment(params: {
    pullRequestId: string;
    repositoryName: string;
    beforeCommitId: string;
    afterCommitId: string;
    content: string;
    location?: {
      filePath: string;
      filePosition: number;
      relativeFileVersion: "BEFORE" | "AFTER";
    };
    /** The same token and parameters return the first post instead of posting again. */
    clientRequestToken?: string;
  }): Promise<Comment> {
    const response = await sendMarked<PostCommentForPullRequestCommandOutput>(
      client,
      new PostCommentForPullRequestCommand(params),
    );
    if (!response.comment) throw new Error("Empty comment response from CodeCommit API.");
    return response.comment;
  }

  async function postCommentReply(params: {
    inReplyTo: string;
    content: string;
    clientRequestToken?: string;
  }): Promise<Comment> {
    const response = await sendMarked<PostCommentReplyCommandOutput>(
      client,
      new PostCommentReplyCommand(params),
    );
    if (!response.comment) throw new Error("Empty reply response from CodeCommit API.");
    return response.comment;
  }

  async function updateApprovalState(params: {
    pullRequestId: string;
    revisionId: string;
    approvalState: "APPROVE" | "REVOKE";
  }): Promise<void> {
    await client.send(new UpdatePullRequestApprovalStateCommand(params));
  }

  async function getApprovalStates(params: {
    pullRequestId: string;
    revisionId: string;
  }): Promise<Approval[]> {
    const response = await client.send(new GetPullRequestApprovalStatesCommand(params));
    return response.approvals ?? [];
  }

  async function evaluateApprovalRules(params: {
    pullRequestId: string;
    revisionId: string;
  }): Promise<Evaluation | null> {
    const response = await client.send(new EvaluatePullRequestApprovalRulesCommand(params));
    return response.evaluation ?? null;
  }

  async function getBlobContent(repositoryName: string, blobId: string): Promise<Uint8Array> {
    const response = await client.send(new GetBlobCommand({ repositoryName, blobId }));
    return response.content ?? new Uint8Array();
  }

  async function mergePullRequest(params: {
    pullRequestId: string;
    repositoryName: string;
    sourceCommitId?: string | undefined;
    strategy: MergeStrategy;
  }): Promise<PullRequest> {
    const Command = MERGE_COMMANDS[params.strategy];
    const response = await client.send(
      new Command({
        pullRequestId: params.pullRequestId,
        repositoryName: params.repositoryName,
        sourceCommitId: params.sourceCommitId,
      }),
    );
    if (!response.pullRequest) throw new Error("Empty merge response from CodeCommit API.");
    return response.pullRequest;
  }

  async function getMergeConflicts(params: {
    repositoryName: string;
    sourceCommitId: string;
    destinationCommitId: string;
    strategy: MergeStrategy;
  }): Promise<ConflictSummary> {
    // A page holds at most 100 files; a large conflict goes on over nextToken.
    const conflicts: { filePath?: string | undefined }[] = [];
    let mergeable = false;
    let nextToken: string | undefined;
    do {
      const response = await client.send(
        new GetMergeConflictsCommand({
          repositoryName: params.repositoryName,
          sourceCommitSpecifier: params.sourceCommitId,
          destinationCommitSpecifier: params.destinationCommitId,
          mergeOption: MERGE_OPTIONS[params.strategy],
          ...(nextToken ? { nextToken } : {}),
        }),
      );
      mergeable = response.mergeable ?? false;
      conflicts.push(...(response.conflictMetadataList ?? []));
      nextToken = response.nextToken;
    } while (nextToken);

    return {
      mergeable,
      conflictCount: conflicts.length,
      conflictFiles: conflicts.map((c) => c.filePath ?? "(unknown)"),
    };
  }

  async function closePullRequest(params: { pullRequestId: string }): Promise<PullRequest> {
    const response = await client.send(
      new UpdatePullRequestStatusCommand({ ...params, pullRequestStatus: "CLOSED" }),
    );
    if (!response.pullRequest) throw new Error("Empty close response from CodeCommit API.");
    return response.pullRequest;
  }

  async function getCommit(repositoryName: string, commitId: string): Promise<CommitInfo> {
    const { commit } = await client.send(new GetCommitCommand({ repositoryName, commitId }));
    if (!commit) throw new Error(`Commit ${commitId} not found.`);

    return {
      commitId: commit.commitId ?? commitId,
      shortId: (commit.commitId ?? commitId).slice(0, 7),
      /* v8 ignore next -- split always returns at least one element */
      message: (commit.message ?? "").split("\n")[0] ?? "",
      authorName: commit.author?.name ?? "unknown",
      authorDate: commitDate(commit.author?.date),
      parentIds: commit.parents ?? [],
    };
  }

  async function getCommitsForPR(
    repositoryName: string,
    sourceCommit: string,
    mergeBase: string,
  ): Promise<CommitInfo[]> {
    const read = new Map<string, Promise<CommitInfo>>();
    const commitOf = (id: string) => {
      let commit = read.get(id);
      if (!commit) read.set(id, (commit = getCommit(repositoryName, id)));
      return commit;
    };
    // Like git log mergeBase..source: past a merge (the destination merged
    // into the source), the first-parent chain can reach the destination's
    // older commits without passing mergeBase. Its ancestors are read only
    // as far as a lookup needs, up to MAX_COMMITS of them.
    const inBase = new Set([mergeBase]);
    const frontier = [mergeBase];
    let budget = MAX_COMMITS;
    const isInBase = async (id: string) => {
      while (!inBase.has(id) && frontier.length > 0 && budget-- > 0) {
        for (const p of (await commitOf(frontier.shift() as string)).parentIds) {
          if (!inBase.has(p)) frontier.push(p);
          inBase.add(p);
        }
      }
      return inBase.has(id);
    };

    const commits: CommitInfo[] = [];
    let currentId = sourceCommit;
    let pastMerge = false;
    while (
      currentId !== mergeBase &&
      commits.length < MAX_COMMITS &&
      !(pastMerge && (await isInBase(currentId)))
    ) {
      const commit = await commitOf(currentId);
      commits.push(commit);
      if (commit.parentIds.length === 0) break;
      if (commit.parentIds.length > 1) pastMerge = true;
      currentId = commit.parentIds[0]!;
    }

    return commits.toReversed();
  }

  async function updateComment(params: { commentId: string; content: string }): Promise<Comment> {
    const response = await client.send(new UpdateCommentCommand(params));
    if (!response.comment) throw new Error("Empty update response from CodeCommit API.");
    return response.comment;
  }

  async function deleteComment(params: { commentId: string }): Promise<Comment> {
    const response = await client.send(new DeleteCommentContentCommand(params));
    if (!response.comment) throw new Error("Empty delete response from CodeCommit API.");
    return response.comment;
  }

  async function putReaction(params: { commentId: string; reactionValue: string }): Promise<void> {
    await client.send(new PutCommentReactionCommand(params));
  }

  async function getReactionsForComment(commentId: string): Promise<ReactionSummary[]> {
    const response = await client.send(new GetCommentReactionsCommand({ commentId }));
    return (response.reactionsForComment ?? []).map((r) => ({
      emoji: r.reaction?.emoji ?? "",
      shortCode: r.reaction?.shortCode ?? "",
      count: (r.reactionUsers?.length ?? 0) + (r.reactionsFromDeletedUsersCount ?? 0),
      userArns: r.reactionUsers ?? [],
    }));
  }

  async function getReactionsForComments(commentIds: string[]): Promise<ReactionsByComment> {
    const results: ReactionsByComment = new Map();
    const settled = await mapLimit(commentIds, REACTION_FETCH_CONCURRENCY, async (commentId) => {
      try {
        const reactions = await getReactionsForComment(commentId);
        return { commentId, reactions };
      } catch {
        return { commentId, reactions: [] as ReactionSummary[] };
      }
    });
    for (const { commentId, reactions } of settled) {
      if (reactions.length > 0) {
        results.set(commentId, reactions);
      }
    }
    return results;
  }

  async function getPullRequestActivity(params: {
    pullRequestId: string;
    nextToken?: string;
    maxResults?: number;
  }): Promise<PullRequestActivityResult> {
    const response = await client.send(
      new DescribePullRequestEventsCommand({ maxResults: 50, ...params }),
    );
    const events = (response.pullRequestEvents ?? []).map(mapPrEvent);
    return response.nextToken === undefined
      ? { events }
      : { events, nextToken: response.nextToken };
  }

  return {
    listPullRequests,
    getAllDifferences,
    getPullRequestDetail,
    getComments,
    postComment,
    postCommentReply,
    updateApprovalState,
    getApprovalStates,
    evaluateApprovalRules,
    getBlobContent,
    mergePullRequest,
    getMergeConflicts,
    closePullRequest,
    getCommitsForPR,
    updateComment,
    deleteComment,
    putReaction,
    getReactionsForComments,
    getPullRequestActivity,
  };
}

export type ReviewApi = ReturnType<typeof createReviewApi>;
