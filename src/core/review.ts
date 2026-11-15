import type { CodeCommitClient, Difference, PullRequestTarget } from "@aws-sdk/client-codecommit";
import type { MergeStrategy } from "../aws/codecommit.js";
import * as aws from "../aws/review.js";
import type { Git, TreeChange } from "../git/git.js";
import type { SeenPr } from "../state/local.js";
import type { DraftStorage } from "./commentDrafts.js";
import { printable } from "./text.js";

export type { SeenPr };

type WithoutClient<F> = F extends (client: CodeCommitClient, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;

type Operation =
  | "listPullRequests"
  | "getPullRequestDetail"
  | "getComments"
  | "postComment"
  | "postCommentReply"
  | "updateApprovalState"
  | "getApprovalStates"
  | "evaluateApprovalRules"
  | "getBlobContent"
  | "mergePullRequest"
  | "getMergeConflicts"
  | "closePullRequest"
  | "getCommitsForPR"
  | "getAllDifferences"
  | "updateComment"
  | "deleteComment"
  | "putReaction"
  | "getReactionsForComments"
  | "getPullRequestActivity";

/** What the review screen calls: the aws/review.ts functions with the client bound. */
export type ReviewService = { readonly [K in Operation]: WithoutClient<(typeof aws)[K]> } & {
  /** Records that the user opened a PR, for the home screen's unread marks. */
  readonly markSeen?: (pr: SeenPr) => void;
  /** The config's pr.mergeOption: the merge dialog starts on it. */
  readonly mergeStrategy?: MergeStrategy;
  /** Where unposted comments are kept; without it they last as long as the screen. */
  readonly drafts?: DraftStorage;
};

/** The service for the TUI, with its own client: the review screen needs more calls than CodeCommitApi has. */
export function openReviewService(
  options: { readonly region?: string; readonly profile?: string },
  git?: Git,
): ReviewService {
  return createReviewService(aws.createClient(options), git);
}

/**
 * Inside a clone, diffs, blobs and commits come from git (spec: clone 内の diff);
 * each falls back to the API when git cannot answer, for example when the
 * commits cannot be fetched.
 */
export function createReviewService(client: CodeCommitClient, git?: Git): ReviewService {
  return displaySafe(createRawService(client, git));
}

function createRawService(client: CodeCommitClient, git?: Git): ReviewService {
  const api: ReviewService = {
    listPullRequests: (...a) => aws.listPullRequests(client, ...a),
    getPullRequestDetail: (...a) => aws.getPullRequestDetail(client, ...a),
    getComments: (...a) => aws.getComments(client, ...a),
    postComment: (...a) => aws.postComment(client, ...a),
    postCommentReply: (...a) => aws.postCommentReply(client, ...a),
    updateApprovalState: (...a) => aws.updateApprovalState(client, ...a),
    getApprovalStates: (...a) => aws.getApprovalStates(client, ...a),
    evaluateApprovalRules: (...a) => aws.evaluateApprovalRules(client, ...a),
    getBlobContent: (...a) => aws.getBlobContent(client, ...a),
    mergePullRequest: (...a) => aws.mergePullRequest(client, ...a),
    getMergeConflicts: (...a) => aws.getMergeConflicts(client, ...a),
    closePullRequest: (...a) => aws.closePullRequest(client, ...a),
    getCommitsForPR: (...a) => aws.getCommitsForPR(client, ...a),
    getAllDifferences: (...a) => aws.getAllDifferences(client, ...a),
    updateComment: (...a) => aws.updateComment(client, ...a),
    deleteComment: (...a) => aws.deleteComment(client, ...a),
    putReaction: (...a) => aws.putReaction(client, ...a),
    getReactionsForComments: (...a) => aws.getReactionsForComments(client, ...a),
    getPullRequestActivity: (...a) => aws.getPullRequestActivity(client, ...a),
  };
  if (!git) return api;

  async function ensureCommits(target: PullRequestTarget): Promise<void> {
    const commits = [target.sourceCommit, target.destinationCommit] as string[];
    const present = await Promise.all(commits.map((c) => git!.resolveCommit(c)));
    if (present.every((c) => c !== null)) return;
    const refspecs = [target.sourceReference, target.destinationReference].map(
      (ref) => `+${ref}:${(ref as string).replace(/^refs\/heads\//, "refs/remotes/origin/")}`,
    );
    await git!.fetch(refspecs, { quiet: true });
  }

  return {
    ...api,
    getPullRequestDetail: (pullRequestId, repositoryName) =>
      aws.getPullRequestDetail(client, pullRequestId, repositoryName, (target) => {
        const source = target.sourceCommit as string;
        const destination = target.destinationCommit as string;
        return orApi(
          async () => {
            await ensureCommits(target);
            const base =
              target.mergeBase ?? (await git.mergeBase(destination, source)) ?? destination;
            return toDifferences(await git.diffTree(base, source));
          },
          () => aws.getAllDifferences(client, repositoryName, destination, source),
        );
      }),
    getAllDifferences: (repositoryName, before, after) =>
      orApi(
        async () => toDifferences(await git.diffTree(before, after)),
        () => aws.getAllDifferences(client, repositoryName, before, after),
      ),
    getBlobContent: (repositoryName, blobId) =>
      orApi(
        async () => aws.blobText(await git.blob(blobId)),
        () => aws.getBlobContent(client, repositoryName, blobId),
      ),
    getCommitsForPR: (repositoryName, sourceCommit, mergeBase) =>
      orApi(
        async () =>
          (await git.firstParentLog(mergeBase, sourceCommit, aws.MAX_COMMITS)).map((c) => ({
            commitId: c.id,
            shortId: c.id.slice(0, 7),
            message: c.subject,
            authorName: c.author,
            authorDate: c.date,
            parentIds: [...c.parents],
          })),
        () => aws.getCommitsForPR(client, repositoryName, sourceCommit, mergeBase),
      ),
  };
}

function threads(list: aws.CommentThread[]): aws.CommentThread[] {
  return list.map((t) => ({
    ...t,
    comments: t.comments.map((c) =>
      c.content === undefined ? c : { ...c, content: printable(c.content, true) },
    ),
  }));
}

/**
 * Free text that other people wrote (titles, descriptions, comments, commit
 * messages, file contents) with control characters made visible: Ink passes
 * escape sequences through to the terminal. Identifiers such as file paths are
 * left alone, because they are sent back to the API.
 */
function displaySafe(service: ReviewService): ReviewService {
  return {
    ...service,
    listPullRequests: async (...a) => {
      const r = await service.listPullRequests(...a);
      return {
        ...r,
        pullRequests: r.pullRequests.map((p) => ({ ...p, title: printable(p.title) })),
      };
    },
    getPullRequestDetail: async (...a) => {
      const r = await service.getPullRequestDetail(...a);
      const { title, description } = r.pullRequest;
      return {
        ...r,
        pullRequest: {
          ...r.pullRequest,
          ...(title === undefined ? {} : { title: printable(title) }),
          ...(description === undefined ? {} : { description: printable(description, true) }),
        },
        commentThreads: threads(r.commentThreads),
      };
    },
    getComments: async (...a) => threads(await service.getComments(...a)),
    getBlobContent: async (...a) => printable(await service.getBlobContent(...a), true),
    getCommitsForPR: async (...a) =>
      (await service.getCommitsForPR(...a)).map((c) => ({
        ...c,
        message: printable(c.message),
        authorName: printable(c.authorName),
      })),
    getPullRequestActivity: async (...a) => {
      const r = await service.getPullRequestActivity(...a);
      return {
        ...r,
        events: r.events.map((e) => ({ ...e, description: printable(e.description) })),
      };
    },
  };
}

/** Any git failure means "not available locally": the API then answers, or reports its own error. */
async function orApi<T>(local: () => Promise<T>, remote: () => Promise<T>): Promise<T> {
  try {
    return await local();
  } catch {
    return remote();
  }
}

function toDifferences(changes: readonly TreeChange[]): Difference[] {
  return changes.map((c) => ({
    changeType: c.status as Difference["changeType"],
    ...(c.before ? { beforeBlob: { blobId: c.before, path: c.path } } : {}),
    ...(c.after ? { afterBlob: { blobId: c.after, path: c.path } } : {}),
  }));
}

export type { MergeStrategy } from "../aws/codecommit.js";
export type {
  CommentThread,
  CommitInfo,
  ConflictSummary,
  PrActivityEvent,
  PullRequestDisplayStatus,
  PullRequestSummary,
  ReactionSummary,
  ReactionsByComment,
} from "../aws/review.js";
