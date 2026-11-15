import type { Approval, Difference, Evaluation, PullRequest } from "@aws-sdk/client-codecommit";
import { Box, Text, useApp, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { blobKey, fetchBlobTexts, streamBlobTexts } from "../core/blobTexts.js";
import {
  type CommentDraft,
  type DraftTarget,
  draftKey,
  editDraft,
  lineReader,
  newDraft,
  postAnyway,
  reanchor,
  submitDrafts,
} from "../core/commentDrafts.js";
import {
  type CommentThread,
  type CommitInfo,
  type ConflictSummary,
  type MergeStrategy,
  type PrActivityEvent,
  type PullRequestDisplayStatus,
  type PullRequestSummary,
  type ReactionsByComment,
  type ReviewService,
} from "../core/review.js";
import { ActivityTimeline } from "./components/ActivityTimeline.js";
import { Help } from "./components/Help.js";
import { PullRequestDetail } from "./components/PullRequestDetail.js";
import { PullRequestList } from "./components/PullRequestList.js";
import { useAsyncAction } from "./hooks/useAsyncAction.js";
import { createBatcher } from "./utils/batchUpdates.js";
import { formatErrorMessage } from "./utils/formatError.js";

const BLOB_TEXT_BATCH_DELAY_MS = 16;

type Screen = "prs" | "detail" | "activity";

interface PaginationState {
  currentPage: number;
  currentCursor: PaginationCursor;
  nextCursor: PaginationCursor;
  previousCursors: PaginationCursor[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

interface PaginationCursor {
  apiToken: string | undefined;
  pending: PullRequestSummary[];
}

const PAGE_SIZE = 25;
const EMPTY_CURSOR: PaginationCursor = { apiToken: undefined, pending: [] };

function createInitialPagination(): PaginationState {
  return {
    currentPage: 1,
    currentCursor: EMPTY_CURSOR,
    nextCursor: EMPTY_CURSOR,
    previousCursors: [],
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function filterPullRequestsByStatus(
  pullRequests: PullRequestSummary[],
  status: PullRequestDisplayStatus,
): PullRequestSummary[] {
  return pullRequests.filter((pr) => pr.status === status);
}

/** Where the review screen starts: the PR list (`pr list`) or one PR (`pr view`). */
export type ReviewStart = { readonly pullRequestId: string } | null;

interface AppProps {
  service: ReviewService;
  repository: string;
  start: ReviewStart;
  /** Called instead of exiting the app when the screen is left, for a parent screen. */
  onExit?: () => void;
}

export function App({ service, repository, start, onExit }: AppProps) {
  const { exit } = useApp();
  const leave = onExit ?? exit;
  const [screen, setScreen] = useState<Screen>(start ? "detail" : "prs");
  // Started on one PR: q leaves the app until the list has been shown.
  const [hasList, setHasList] = useState(!start);
  const [showHelp, setShowHelp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedRepo = repository;
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);

  const [prDetail, setPrDetail] = useState<PullRequest | null>(null);
  const [prDifferences, setPrDifferences] = useState<Difference[]>([]);
  const [commentThreads, setCommentThreads] = useState<CommentThread[]>([]);
  const [diffTexts, setDiffTexts] = useState<Map<string, { before: string; after: string }>>(
    new Map(),
  );
  const [diffTextStatus, setDiffTextStatus] = useState<Map<string, "loading" | "loaded" | "error">>(
    new Map(),
  );

  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalEvaluation, setApprovalEvaluation] = useState<Evaluation | null>(null);

  const approvalAction = useAsyncAction(
    async (state: "APPROVE" | "REVOKE") => {
      if (!prDetail?.pullRequestId || !prDetail?.revisionId) return;
      await service.updateApprovalState({
        pullRequestId: prDetail.pullRequestId,
        revisionId: prDetail.revisionId,
        approvalState: state,
      });
      await reloadApprovals(prDetail.pullRequestId, prDetail.revisionId);
    },
    (err, state?: "APPROVE" | "REVOKE") =>
      formatErrorMessage(err, "approval", state === "APPROVE" ? "approve" : "revoke"),
  );

  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [commitDifferences, setCommitDifferences] = useState<Difference[]>([]);
  const [commitDiffTexts, setCommitDiffTexts] = useState<
    Map<string, { before: string; after: string }>
  >(new Map());
  const [isLoadingCommitDiff, setIsLoadingCommitDiff] = useState(false);

  const detailLoadRef = useRef(0);
  const commitLoadRef = useRef(0);
  const commitsPromiseRef = useRef<Promise<CommitInfo[]>>(Promise.resolve([]));

  const [reactionsByComment, setReactionsByComment] = useState<ReactionsByComment>(new Map());

  // spec: コメントの下書き. The ref is what async work reads and writes; the
  // state is what renders.
  const [drafts, setDrafts] = useState<readonly CommentDraft[]>([]);
  const draftsRef = useRef<readonly CommentDraft[]>([]);
  const draftsForRef = useRef<string | null>(null);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const [isPostingDrafts, setIsPostingDrafts] = useState(false);
  const [draftProgress, setDraftProgress] = useState<{ done: number; total: number } | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  /**
   * Shows `next` and writes it to drafts.json, then shows what was saved, which
   * holds another lazycc's changes to this PR's drafts. Rejects when the write fails.
   */
  async function storeDrafts(
    key: string,
    next: readonly CommentDraft[],
  ): Promise<readonly CommentDraft[]> {
    draftsRef.current = next;
    setDrafts(next);
    try {
      const saved = (await service.drafts?.save(key, next)) ?? next;
      setDraftSaveError(null);
      if (draftsForRef.current === key) {
        draftsRef.current = saved;
        setDrafts(saved);
      }
      return saved;
    } catch (err) {
      setDraftSaveError(formatErrorMessage(err));
      throw err;
    }
  }

  /** Edits from the screen: a failed write shows in the header, the drafts stay in memory. */
  function changeDrafts(change: (list: readonly CommentDraft[]) => readonly CommentDraft[]) {
    if (!prDetail?.pullRequestId) return;
    storeDrafts(draftKey(prDetail), change(draftsRef.current)).catch(() => {});
  }

  function addDraft(content: string, target: DraftTarget) {
    const t = prDetail?.pullRequestTargets?.[0];
    if (!t?.destinationCommit || !t.sourceCommit) return;
    const tip = { beforeCommitId: t.destinationCommit, afterCommitId: t.sourceCommit };
    changeDrafts((list) => [...list, newDraft(content, target, tip)]);
  }

  async function loadDrafts(key: string) {
    if (draftsForRef.current === key) return;
    draftsForRef.current = key;
    draftsRef.current = [];
    setDrafts([]);
    setDraftError(null);
    if (!service.drafts) return;
    try {
      const list = await service.drafts.load(key);
      if (draftsForRef.current !== key) return;
      draftsRef.current = list;
      setDrafts(list);
    } catch (err) {
      setDraftSaveError(formatErrorMessage(err));
    }
  }

  async function handleSubmitDrafts() {
    const pullRequestId = prDetail?.pullRequestId;
    if (!pullRequestId || isPostingDrafts) return;
    const key = draftKey(prDetail);
    setIsPostingDrafts(true);
    setDraftError(null);
    let moved = false;
    try {
      // CodeCommit posts against the current tip only, so read it first.
      const detail = await service.getPullRequestDetail(pullRequestId, selectedRepo);
      const t = detail.pullRequest.pullRequestTargets?.[0];
      if (!t?.destinationCommit || !t.sourceCommit) {
        throw new Error("The pull request has no commits to comment on.");
      }
      const tip = { beforeCommitId: t.destinationCommit, afterCommitId: t.sourceCommit };
      const old = prDetail?.pullRequestTargets?.[0];
      moved =
        old?.sourceCommit !== tip.afterCommitId || old?.destinationCommit !== tip.beforeCommitId;
      const lineAt = await lineReader(draftsRef.current, tip, detail.differences, (blobId) =>
        service.getBlobContent(selectedRepo, blobId),
      );
      const anchored = await storeDrafts(key, reanchor(draftsRef.current, tip, lineAt));
      const result = await submitDrafts(anchored, {
        save: (list) => storeDrafts(key, list),
        progress: (done, total) => setDraftProgress({ done, total }),
        post: async (draft, on, token) => {
          const { target, content } = draft;
          if (target.kind === "reply") {
            await service.postCommentReply({
              inReplyTo: target.inReplyTo,
              content,
              clientRequestToken: token,
            });
            return;
          }
          await service.postComment({
            pullRequestId,
            repositoryName: selectedRepo,
            ...on,
            content,
            clientRequestToken: token,
            ...(target.kind === "inline"
              ? {
                  location: {
                    filePath: target.location.filePath,
                    filePosition: target.location.filePosition,
                    relativeFileVersion: target.location.relativeFileVersion,
                  },
                }
              : {}),
          });
        },
      });
      const movedLeft = result.remaining.filter((d) => d.problem?.kind === "moved").length;
      if (result.stopped?.problem) {
        setDraftError(
          `Posted ${result.posted}. Stopped at a draft: ${result.stopped.problem.message}`,
        );
      } else if (movedLeft > 0) {
        setDraftError(
          `Posted ${result.posted}. ${movedLeft} draft${movedLeft === 1 ? " points" : "s point"} at a line that changed in new commits: check it (p posts anyway).`,
        );
      }
    } catch (err) {
      setDraftError(formatErrorMessage(err, "comment"));
    } finally {
      setIsPostingDrafts(false);
      setDraftProgress(null);
    }
    // New commits: show them, so moved drafts can be checked against the new diff.
    if (moved) await loadPullRequestDetail(pullRequestId);
    else await reloadComments(pullRequestId).catch(() => {});
  }

  // Read when opened, and again when left, so the user's own comments or
  // approval made here do not mark the PR unread.
  // While a detail loads, prDetail still holds the PR opened before.
  const openId = screen === "prs" || loading ? undefined : prDetail?.pullRequestId;
  // With the author: PR ids repeat across accounts, and the ARN names the account.
  const openAuthor = prDetail?.authorArn;
  useEffect(() => {
    const markSeen = service.markSeen;
    if (!openId || !markSeen) return;
    const pr = { id: openId, authorArn: openAuthor };
    markSeen(pr);
    return () => markSeen(pr);
  }, [openId, openAuthor, service]);

  const postCommentAction = useAsyncAction(
    async (content: string) => {
      if (!prDetail) return;
      const target = prDetail.pullRequestTargets?.[0];
      if (!target?.destinationCommit || !target?.sourceCommit) return;
      await service.postComment({
        pullRequestId: prDetail.pullRequestId!,
        repositoryName: selectedRepo,
        beforeCommitId: target.destinationCommit,
        afterCommitId: target.sourceCommit,
        content,
      });
      await reloadComments(prDetail.pullRequestId!);
    },
    (err) => formatErrorMessage(err, "comment"),
  );

  const postInlineCommentAction = useAsyncAction(
    async (
      content: string,
      location: { filePath: string; filePosition: number; relativeFileVersion: "BEFORE" | "AFTER" },
    ) => {
      if (!prDetail) return;
      const target = prDetail.pullRequestTargets?.[0];
      if (!target?.destinationCommit || !target?.sourceCommit) return;
      await service.postComment({
        pullRequestId: prDetail.pullRequestId!,
        repositoryName: selectedRepo,
        beforeCommitId: target.destinationCommit,
        afterCommitId: target.sourceCommit,
        content,
        location,
      });
      await reloadComments(prDetail.pullRequestId!);
    },
    (err) => formatErrorMessage(err, "comment"),
  );

  const postReplyAction = useAsyncAction(
    async (inReplyTo: string, content: string) => {
      if (!prDetail?.pullRequestId) return;
      await service.postCommentReply({ inReplyTo, content });
      await reloadComments(prDetail.pullRequestId);
    },
    (err) => formatErrorMessage(err, "reply"),
  );

  const mergeAction = useAsyncAction(
    async (strategy: MergeStrategy) => {
      if (!prDetail?.pullRequestId) return;
      const target = prDetail.pullRequestTargets?.[0];
      await service.mergePullRequest({
        pullRequestId: prDetail.pullRequestId,
        repositoryName: selectedRepo,
        sourceCommitId: target?.sourceCommit,
        strategy,
      });
      leaveClosedPullRequest(prDetail.pullRequestId);
    },
    (err) => formatErrorMessage(err, "merge"),
  );

  const closePRAction = useAsyncAction(
    async () => {
      if (!prDetail?.pullRequestId) return;
      await service.closePullRequest({ pullRequestId: prDetail.pullRequestId });
      leaveClosedPullRequest(prDetail.pullRequestId);
    },
    (err) => formatErrorMessage(err, "close"),
  );

  const updateCommentAction = useAsyncAction(
    async (commentId: string, content: string) => {
      if (!prDetail?.pullRequestId) return;
      await service.updateComment({ commentId, content });
      await reloadComments(prDetail.pullRequestId);
    },
    (err) => formatErrorMessage(err, "edit"),
  );

  const deleteCommentAction = useAsyncAction(
    async (commentId: string) => {
      if (!prDetail?.pullRequestId) return;
      await service.deleteComment({ commentId });
      await reloadComments(prDetail.pullRequestId);
    },
    (err) => formatErrorMessage(err, "delete"),
  );

  const reactAction = useAsyncAction(
    async (commentId: string, reactionValue: string) => {
      await service.putReaction({ commentId, reactionValue });
      await reloadReactions(commentThreads);
    },
    (err) => formatErrorMessage(err, "reaction"),
  );

  // v0.4: activity timeline
  const [activityEvents, setActivityEvents] = useState<PrActivityEvent[]>([]);
  const [activityNextToken, setActivityNextToken] = useState<string | undefined>(undefined);
  const activityAction = useAsyncAction(
    async (pullRequestId: string, nextToken?: string) => {
      try {
        const result = await service.getPullRequestActivity({
          pullRequestId,
          ...(nextToken !== undefined ? { nextToken } : {}),
          maxResults: 50,
        });
        if (nextToken) {
          setActivityEvents((prev) => [...prev, ...result.events]);
        } else {
          setActivityEvents(result.events);
        }
        setActivityNextToken(result.nextToken);
      } catch (err) {
        if (err instanceof Error && err.name === "InvalidContinuationTokenException") {
          setActivityEvents([]);
          setActivityNextToken(undefined);
          // Retry from the start inside this action so execute() is not re-entered
          // (that would flicker loading / risk a retry loop).
          const retry = await service.getPullRequestActivity({ pullRequestId, maxResults: 50 });
          setActivityEvents(retry.events);
          setActivityNextToken(retry.nextToken);
          return;
        }
        throw err;
      }
    },
    (err) => formatErrorMessage(err, "activity"),
  );

  // v0.8: filter, search, pagination
  const [statusFilter, setStatusFilter] = useState<PullRequestDisplayStatus>("OPEN");
  const [searchQuery, setSearchQuery] = useState("");
  const [pagination, setPagination] = useState<PaginationState>(createInitialPagination);

  function isDetailLoadStale(loadId: number): boolean {
    return detailLoadRef.current !== loadId;
  }

  function isCommitLoadStale(loadId: number): boolean {
    return commitLoadRef.current !== loadId;
  }

  function beginDetailLoad(): number {
    const loadId = detailLoadRef.current + 1;
    detailLoadRef.current = loadId;
    commitLoadRef.current += 1;
    return loadId;
  }

  async function reloadReactions(threads: CommentThread[], loadId = detailLoadRef.current) {
    const allCommentIds = threads.flatMap((t) =>
      t.comments.map((c) => c.commentId).filter((id): id is string => !!id),
    );
    if (allCommentIds.length > 0) {
      const reactions = await service.getReactionsForComments(allCommentIds);
      if (isDetailLoadStale(loadId)) return;
      setReactionsByComment(reactions);
    } else {
      if (isDetailLoadStale(loadId)) return;
      setReactionsByComment(new Map());
    }
  }

  /**
   * Wrapper for async operations with automatic loading/error state management.
   * Eliminates repetitive try-catch-finally patterns.
   */
  async function withLoadingState<T>(
    operation: () => Promise<T>,
    onError?: (err: unknown) => void,
  ): Promise<T | undefined> {
    setLoading(true);
    setError(null);
    try {
      return await operation();
    } catch (err) {
      if (onError) {
        onError(err);
      } else {
        setError(formatErrorMessage(err));
      }
      return undefined;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (start) void loadPullRequestDetail(start.pullRequestId);
    else void loadPullRequests(repository);
  }, []);

  async function fetchPullRequestPage(
    repoName: string,
    status: PullRequestDisplayStatus,
    cursor: PaginationCursor,
  ): Promise<{
    pullRequests: PullRequestSummary[];
    nextCursor: PaginationCursor;
    hasNextPage: boolean;
  }> {
    if (status === "OPEN") {
      const result = await service.listPullRequests(repoName, cursor.apiToken, "OPEN");
      return {
        pullRequests: result.pullRequests,
        nextCursor: { apiToken: result.nextToken, pending: [] },
        hasNextPage: result.nextToken != null,
      };
    }

    const filteredPullRequests = [...cursor.pending];
    let nextToken = cursor.apiToken;
    let canFetch = cursor.apiToken !== undefined || cursor.pending.length === 0;

    while (filteredPullRequests.length < PAGE_SIZE && canFetch) {
      const result = await service.listPullRequests(repoName, nextToken, "CLOSED");
      filteredPullRequests.push(...filterPullRequestsByStatus(result.pullRequests, status));
      nextToken = result.nextToken;
      canFetch = nextToken !== undefined;
    }

    const page = filteredPullRequests.slice(0, PAGE_SIZE);
    const remaining = filteredPullRequests.slice(PAGE_SIZE);

    return {
      pullRequests: page,
      nextCursor: { apiToken: nextToken, pending: remaining },
      hasNextPage: remaining.length > 0 || nextToken !== undefined,
    };
  }

  async function loadPullRequests(
    repoName: string,
    status: PullRequestDisplayStatus = "OPEN",
    cursor: PaginationCursor = EMPTY_CURSOR,
  ) {
    await withLoadingState(
      async () => {
        const result = await fetchPullRequestPage(repoName, status, cursor);
        setPullRequests(result.pullRequests);
        setPagination((prev) => ({
          ...prev,
          nextCursor: result.nextCursor,
          hasNextPage: result.hasNextPage,
        }));
      },
      (err) => {
        if (err instanceof Error && err.name === "InvalidContinuationTokenException") {
          setError("Page token expired. Returning to first page.");
          setPagination(createInitialPagination());
        } else {
          setError(formatErrorMessage(err));
        }
      },
    );
  }

  async function loadPullRequestDetail(pullRequestId: string) {
    const loadId = beginDetailLoad();

    await withLoadingState(async () => {
      const detail = await service.getPullRequestDetail(pullRequestId, selectedRepo);
      if (isDetailLoadStale(loadId)) return;

      setPrDetail(detail.pullRequest);
      void loadDrafts(draftKey(detail.pullRequest));
      setPrDifferences(detail.differences);
      setCommentThreads(detail.commentThreads);
      setDiffTexts(new Map());
      setApprovals([]);
      setApprovalEvaluation(null);
      setReactionsByComment(new Map());

      const status = new Map<string, "loading" | "loaded" | "error">();
      for (const diff of detail.differences) {
        status.set(blobKey(diff), "loading");
      }
      setDiffTextStatus(status);
      setCommits([]);
      setCommitDifferences([]);
      setCommitDiffTexts(new Map());
      commitsPromiseRef.current = Promise.resolve([]);

      // Background: blob texts (batched so each arrival does not rebuild all lines)
      type BlobUpdate =
        | { key: string; status: "loaded"; texts: { before: string; after: string } }
        | { key: string; status: "error" };
      const blobBatcher = createBatcher<BlobUpdate>((updates) => {
        /* v8 ignore next -- stale-load guard hard to test deterministically */
        if (isDetailLoadStale(loadId)) return;
        const loaded = updates.filter(
          (u): u is Extract<BlobUpdate, { status: "loaded" }> => u.status === "loaded",
        );
        if (loaded.length > 0) {
          setDiffTexts((prev) => {
            const next = new Map(prev);
            for (const update of loaded) next.set(update.key, update.texts);
            return next;
          });
        }
        setDiffTextStatus((prev) => {
          const next = new Map(prev);
          for (const update of updates) next.set(update.key, update.status);
          return next;
        });
      }, BLOB_TEXT_BATCH_DELAY_MS);

      void streamBlobTexts(service, selectedRepo, detail.differences, {
        isStale: () => isDetailLoadStale(loadId),
        onLoaded: (key, texts) => {
          blobBatcher.enqueue({ key, status: "loaded", texts });
        },
        onError: (key) => {
          blobBatcher.enqueue({ key, status: "error" });
        },
      }).then(() => blobBatcher.flush());

      // Background: commits (parent-chain walk cannot be parallelized)
      const sourceCommit = detail.pullRequest.pullRequestTargets?.[0]?.sourceCommit;
      const mergeBase = detail.pullRequest.pullRequestTargets?.[0]?.mergeBase;
      if (sourceCommit && mergeBase) {
        const promise = service.getCommitsForPR(selectedRepo, sourceCommit, mergeBase);
        commitsPromiseRef.current = promise;
        void promise.then(
          (loaded) => {
            if (isDetailLoadStale(loadId)) return;
            setCommits(loaded);
          },
          () => undefined,
        );
      }

      // Background: approvals
      const revisionId = detail.pullRequest.revisionId;
      if (revisionId) {
        void Promise.all([
          service.getApprovalStates({ pullRequestId, revisionId }),
          service.evaluateApprovalRules({ pullRequestId, revisionId }).catch(() => null),
        ]).then(([states, evaluation]) => {
          if (isDetailLoadStale(loadId)) return;
          setApprovals(states);
          setApprovalEvaluation(evaluation);
        });
      }

      // Background: reactions
      void reloadReactions(detail.commentThreads, loadId);
    });
  }

  function handleSelectPR(pullRequestId: string) {
    setScreen("detail");
    loadPullRequestDetail(pullRequestId);
  }

  function handleChangeStatusFilter(filter: PullRequestDisplayStatus) {
    setStatusFilter(filter);
    setSearchQuery("");
    setPagination(createInitialPagination());
    void loadPullRequests(selectedRepo, filter, EMPTY_CURSOR);
  }

  function handleNextPage() {
    if (!pagination.hasNextPage) return;
    const nextCursor = pagination.nextCursor;

    setPagination((prev) => ({
      ...prev,
      previousCursors: [...prev.previousCursors, prev.currentCursor],
      currentCursor: nextCursor,
      currentPage: prev.currentPage + 1,
      hasPreviousPage: true,
    }));

    void loadPullRequests(selectedRepo, statusFilter, nextCursor);
  }

  function handlePreviousPage() {
    if (pagination.previousCursors.length === 0) return;

    const newPreviousCursors = [...pagination.previousCursors];
    const prevCursor = newPreviousCursors.pop();
    if (!prevCursor) return;

    setPagination((prev) => ({
      ...prev,
      previousCursors: newPreviousCursors,
      currentCursor: prevCursor,
      currentPage: prev.currentPage - 1,
      hasPreviousPage: newPreviousCursors.length > 0,
    }));

    void loadPullRequests(selectedRepo, statusFilter, prevCursor);
  }

  async function reloadComments(pullRequestId: string, loadId = detailLoadRef.current) {
    // Optimized: fetch only comments instead of full PR detail
    const target = prDetail?.pullRequestTargets?.[0];
    const threads = await service.getComments(pullRequestId, {
      repositoryName: selectedRepo,
      ...(target?.sourceCommit && target?.destinationCommit
        ? {
            afterCommitId: target.sourceCommit,
            beforeCommitId: target.destinationCommit,
          }
        : {}),
    });
    if (isDetailLoadStale(loadId)) return;
    setCommentThreads(threads);
    await reloadReactions(threads, loadId);
  }

  async function reloadApprovals(
    pullRequestId: string,
    revisionId: string,
    loadId = detailLoadRef.current,
  ) {
    const [approvalStates, evaluation] = await Promise.all([
      service.getApprovalStates({ pullRequestId, revisionId }),
      /* v8 ignore next -- defensive: evaluation failure should not block approval */
      service.evaluateApprovalRules({ pullRequestId, revisionId }).catch(() => null),
    ]);
    if (isDetailLoadStale(loadId)) return;
    setApprovals(approvalStates);
    setApprovalEvaluation(evaluation);
  }

  async function handleCheckConflicts(strategy: MergeStrategy): Promise<ConflictSummary> {
    const target = prDetail?.pullRequestTargets?.[0];
    if (!target?.sourceCommit || !target?.destinationCommit) {
      return { mergeable: true, conflictCount: 0, conflictFiles: [] };
    }
    // The merge lands on the destination branch's current tip, which may have
    // moved since the screen opened, so check against the branch, not the
    // commit read then. GetMergeConflicts takes a branch name as a specifier.
    const destination = target.destinationReference?.replace(/^refs\/heads\//, "");
    return await service.getMergeConflicts({
      repositoryName: selectedRepo,
      sourceCommitId: target.sourceCommit,
      destinationCommitId: destination || target.destinationCommit,
      strategy,
    });
  }

  async function handleLoadCommitDiff(commitIndex: number) {
    const loadId = commitLoadRef.current + 1;
    commitLoadRef.current = loadId;

    setIsLoadingCommitDiff(true);
    setCommitDifferences([]);
    setCommitDiffTexts(new Map());
    try {
      const currentCommits = await commitsPromiseRef.current;
      if (isCommitLoadStale(loadId)) return;
      setCommits(currentCommits);

      const commit = currentCommits[commitIndex];
      if (!commit || commit.parentIds.length === 0) return;

      const parentId = commit.parentIds[0]!;
      const diffs = await service.getAllDifferences(selectedRepo, parentId, commit.commitId);
      if (isCommitLoadStale(loadId)) return;
      setCommitDifferences(diffs);

      const texts = await fetchBlobTexts(service, selectedRepo, diffs);
      if (isCommitLoadStale(loadId)) return;
      setCommitDiffTexts(texts);
    } finally {
      if (!isCommitLoadStale(loadId)) {
        setIsLoadingCommitDiff(false);
      }
    }
  }

  function handleShowActivity() {
    if (!prDetail?.pullRequestId) return;
    setScreen("activity");
    setActivityEvents([]);
    setActivityNextToken(undefined);
    activityAction.execute(prDetail.pullRequestId);
  }

  function handleLoadNextActivityPage() {
    if (!prDetail?.pullRequestId || !activityNextToken || activityAction.isProcessing) return;
    activityAction.execute(prDetail.pullRequestId, activityNextToken);
  }

  function handleBack() {
    if (screen === "detail" && hasList) setScreen("prs");
    else leave();
  }

  /**
   * After a merge or close: back to the parent screen when there is one, else to
   * the PR list, loading it if it was never shown.
   */
  function leaveClosedPullRequest(pullRequestId: string) {
    if (onExit && !hasList) {
      onExit();
      return;
    }
    setScreen("prs");
    if (hasList) {
      setPullRequests((prev) => prev.filter((pr) => pr.pullRequestId !== pullRequestId));
    } else {
      setHasList(true);
      void loadPullRequests(repository);
    }
  }

  if (showHelp) {
    return <Help onClose={() => setShowHelp(false)} />;
  }

  if (error) return <ErrorScreen error={error} onBack={onExit} />;

  if (loading) {
    return (
      <Box padding={1}>
        <Text color="cyan">Loading...</Text>
      </Box>
    );
  }

  switch (screen) {
    case "prs":
      return (
        <PullRequestList
          repositoryName={selectedRepo}
          pullRequests={pullRequests}
          onSelect={handleSelectPR}
          onBack={handleBack}
          onHelp={() => setShowHelp(true)}
          statusFilter={statusFilter}
          onChangeStatusFilter={handleChangeStatusFilter}
          searchQuery={searchQuery}
          onChangeSearchQuery={setSearchQuery}
          pagination={{
            currentPage: pagination.currentPage,
            hasNextPage: pagination.hasNextPage,
            hasPreviousPage: pagination.hasPreviousPage,
          }}
          onNextPage={handleNextPage}
          onPreviousPage={handlePreviousPage}
        />
      );
    case "detail":
      if (!prDetail) return null;
      return (
        <PullRequestDetail
          pullRequest={prDetail}
          differences={prDifferences}
          commentThreads={commentThreads}
          diffTexts={diffTexts}
          diffTextStatus={diffTextStatus}
          onBack={handleBack}
          onHelp={() => setShowHelp(true)}
          onShowActivity={handleShowActivity}
          comment={postCommentAction}
          inlineComment={postInlineCommentAction}
          reply={postReplyAction}
          approval={{ ...approvalAction, approvals, evaluation: approvalEvaluation }}
          merge={{
            ...mergeAction,
            onCheckConflicts: handleCheckConflicts,
            preferred: service.mergeStrategy,
          }}
          close={closePRAction}
          commitView={{
            commits,
            differences: commitDifferences,
            diffTexts: commitDiffTexts,
            isLoading: isLoadingCommitDiff,
            onLoad: handleLoadCommitDiff,
            commitsAvailable: !!(
              prDetail?.pullRequestTargets?.[0]?.sourceCommit &&
              prDetail?.pullRequestTargets?.[0]?.mergeBase
            ),
          }}
          editComment={updateCommentAction}
          deleteComment={deleteCommentAction}
          reaction={{ ...reactAction, byComment: reactionsByComment }}
          drafts={{
            list: drafts,
            saveError: draftSaveError,
            add: addDraft,
            edit: (id, content) =>
              changeDrafts((list) => list.map((d) => (d.id === id ? editDraft(d, content) : d))),
            discard: (id) => changeDrafts((list) => list.filter((d) => d.id !== id)),
            postAnyway: (id) => {
              const t = prDetail.pullRequestTargets?.[0];
              if (!t?.destinationCommit || !t.sourceCommit) return;
              const tip = { beforeCommitId: t.destinationCommit, afterCommitId: t.sourceCommit };
              changeDrafts((list) => list.map((d) => (d.id === id ? postAnyway(d, tip) : d)));
            },
            submit: () => void handleSubmitDrafts(),
            state: {
              isProcessing: isPostingDrafts,
              progress: draftProgress,
              error: draftError,
              clearError: () => setDraftError(null),
            },
          }}
        />
      );
    case "activity":
      return (
        <ActivityTimeline
          pullRequestTitle={prDetail?.title ?? ""}
          events={activityEvents}
          isLoading={activityAction.isProcessing}
          error={activityAction.error}
          hasNextPage={!!activityNextToken}
          onLoadNextPage={handleLoadNextActivityPage}
          onBack={() => setScreen("detail")}
        />
      );
  }
}

function ErrorScreen({ error, onBack }: { error: string; onBack: (() => void) | undefined }) {
  useInput(
    (input, key) => {
      if (input === "q" || key.escape) onBack?.();
    },
    { isActive: onBack !== undefined },
  );
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red" bold>
        Error: {error}
      </Text>
      <Text dimColor>{onBack ? "Press q to go back." : "Press Ctrl+C to exit."}</Text>
    </Box>
  );
}
