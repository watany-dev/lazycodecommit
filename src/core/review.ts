import {
  CodeCommitClient,
  type Difference,
  type PullRequestTarget,
} from "@aws-sdk/client-codecommit";
import {
  type CodeCommitApi,
  clientConfig,
  createCodeCommitApi,
  type MergeStrategy,
} from "../aws/codecommit.js";
import * as aws from "../aws/review.js";
import type { Git, TreeChange } from "../git/git.js";
import type { SeenPr } from "../state/local.js";
import { isBinary } from "./browse.js";
import type { Checks } from "./checks.js";
import type { DraftStorage } from "./commentDrafts.js";
import { UserError } from "./errors.js";
import { alreadyOpen, concurrency, reopenPullRequest } from "./pr.js";
import { printable } from "./text.js";

export type { SeenPr };

type LineEndings = "LF" | "CRLF" | "mixed";

/**
 * A blob as the diff shows it: its text, display-safe with CRLF made LF, and
 * the line endings it had (none for text with no line break); or only the size
 * of a binary file.
 */
export type BlobContent =
  | { readonly text: string; readonly lineEndings?: LineEndings }
  | { readonly binarySize: number };

const MAX_BLOB_SIZE = 1024 * 1024; // 1MB limit for TUI display
const textDecoder = new TextDecoder();

function lineEndings(text: string): LineEndings | undefined {
  let lf = 0;
  let crlf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    lf++;
    if (text[i - 1] === "\r") crlf++;
  }
  if (lf === 0) return undefined;
  return crlf === 0 ? "LF" : crlf === lf ? "CRLF" : "mixed";
}

function blobContent(bytes: Uint8Array): BlobContent {
  if (isBinary(bytes)) return { binarySize: bytes.byteLength };
  if (bytes.byteLength > MAX_BLOB_SIZE) return { text: "[File too large to display]" };
  const text = textDecoder.decode(bytes);
  const endings = lineEndings(text);
  return { text: printable(text, true), ...(endings ? { lineEndings: endings } : {}) };
}

/** What the review screen calls: aws/review.ts's calls, and what the screen is given besides. */
export type ReviewService = Omit<aws.ReviewApi, "getBlobContent"> & {
  readonly getBlobContent: (repositoryName: string, blobId: string) => Promise<BlobContent>;

  /** Records that the user opened a PR, for the home screen's unread marks. */
  readonly markSeen?: (pr: SeenPr) => void;
  /** The config's pr.mergeOption: the merge dialog starts on it. */
  readonly mergeStrategy?: MergeStrategy;
  /** Where unposted comments are kept; without it they last as long as the screen. */
  readonly drafts?: DraftStorage;
  /** CI on the PR's source commit; null when the config's ci lists nothing for the repository (ADR 0010). */
  readonly checks?: (pr: { repository: string; sourceCommit: string }) => Promise<Checks | null>;
  /**
   * spec: PR の再オープン. Opens a new PR from a closed one's branches and
   * answers its id; rejects when one from the same branches is already open.
   */
  readonly reopenPullRequest?: (pullRequestId: string, repositoryName: string) => Promise<string>;
};

/** The service for the TUI, with its own client: the review screen needs more calls than CodeCommitApi has. */
export function openReviewService(
  options: { readonly region?: string; readonly profile?: string },
  git?: Git,
): ReviewService {
  return {
    ...createReviewService(aws.createReviewApi(new CodeCommitClient(clientConfig(options))), git),
    reopenPullRequest: (id, repository) =>
      reopenById(id, repository, createCodeCommitApi({ ...options, concurrency: concurrency({}) })),
  };
}

/** The TUI's reopen, the same as `pr reopen`'s. */
export async function reopenById(
  id: string,
  repository: string,
  api: CodeCommitApi,
): Promise<string> {
  const { kind, pr } = await reopenPullRequest(id, { api, ctx: { repository }, config: {} });
  if (kind === "exists") throw new UserError(alreadyOpen(pr));
  return pr.id;
}

/**
 * Inside a clone, diffs, blobs and commits come from git (spec: clone 内の diff);
 * each falls back to the API when git cannot answer, for example when the
 * commits cannot be fetched.
 */
export function createReviewService(api: aws.ReviewApi, git?: Git): ReviewService {
  return displaySafe(withGit(api, git));
}

function withGit(api: aws.ReviewApi, git?: Git): aws.ReviewApi {
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
      api.getPullRequestDetail(pullRequestId, repositoryName, (target) => {
        const source = target.sourceCommit as string;
        const destination = target.destinationCommit as string;
        return orApi(
          async () => {
            await ensureCommits(target);
            const base =
              target.mergeBase ?? (await git.mergeBase(destination, source)) ?? destination;
            return toDifferences(await git.diffTree(base, source));
          },
          // The same diff from the API: from the merge base, not the destination's tip.
          () => api.getAllDifferences(repositoryName, target.mergeBase ?? destination, source),
        );
      }),
    getAllDifferences: (repositoryName, before, after) =>
      orApi(
        async () => toDifferences(await git.diffTree(before, after)),
        () => api.getAllDifferences(repositoryName, before, after),
      ),
    getBlobContent: (repositoryName, blobId) =>
      orApi(
        () => git.blob(blobId),
        () => api.getBlobContent(repositoryName, blobId),
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
        () => api.getCommitsForPR(repositoryName, sourceCommit, mergeBase),
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
function displaySafe(service: aws.ReviewApi): ReviewService {
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
    getBlobContent: async (...a) => blobContent(await service.getBlobContent(...a)),
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
