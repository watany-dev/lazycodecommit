import type { Approval, Difference, Evaluation, PullRequest } from "@aws-sdk/client-codecommit";
import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { type BlobTexts, blobKey, fetchBlobTexts, streamBlobTexts } from "../core/blobTexts.js";
import type { Checks } from "../core/checks.js";
import {
  type CommentDraft,
  type DraftLocation,
  type DraftTarget,
  draftKey,
  editDraft,
  newDraft,
  postAnyway,
  postPullRequestDrafts,
  type StoredDrafts,
  tipOf,
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
import { HelpMenu, PR_DETAIL_HELP, PR_LIST_HELP, useHelp } from "./components/Help.js";
import { PullRequestDetail } from "./components/PullRequestDetail.js";
import { PullRequestList } from "./components/PullRequestList.js";
import { useAsyncAction } from "./hooks/useAsyncAction.js";
import { useKeys } from "./hooks/useKeys.js";
import { useQuit } from "./hooks/useQuit.js";
import { createBatcher } from "./utils/batchUpdates.js";
import { formatErrorMessage } from "./utils/formatError.js";
import { reactedCommentIds } from "./utils/reactions.js";

const BLOB_TEXT_BATCH_DELAY_MS = 16;

type Screen = "prs" | "detail" | "activity";

type InlineLocation = Omit<DraftLocation, "lineText">;

interface PaginationState {
  currentCursor: PaginationCursor;
  nextCursor: PaginationCursor;
  /** One per page before this one. */
  previousCursors: PaginationCursor[];
  hasNextPage: boolean;
}

interface PaginationCursor {
  apiToken: string | undefined;
  pending: PullRequestSummary[];
}

const PAGE_SIZE = 25;
const EMPTY_CURSOR: PaginationCursor = { apiToken: undefined, pending: [] };

function createInitialPagination(): PaginationState {
  return {
    currentCursor: EMPTY_CURSOR,
    nextCursor: EMPTY_CURSOR,
    previousCursors: [],
    hasNextPage: false,
  };
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
  const quit = useQuit();
  const [screen, setScreen] = useState<Screen>(start ? "detail" : "prs");
  // Started on one PR: Esc stays put until the list has been shown.
  const [hasList, setHasList] = useState(!start);
  const help = useHelp();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedRepo = repository;
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);

  const [prDetail, setPrDetail] = useState<PullRequest | null>(null);
  const [prDifferences, setPrDifferences] = useState<Difference[]>([]);
  const [commentThreads, setCommentThreads] = useState<CommentThread[]>([]);
  const [diffTexts, setDiffTexts] = useState<Map<string, BlobTexts>>(new Map());
  const [diffTextStatus, setDiffTextStatus] = useState<Map<string, "loading" | "loaded" | "error">>(
    new Map(),
  );

  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalEvaluation, setApprovalEvaluation] = useState<Evaluation | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);

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
  const [commitDiffTexts, setCommitDiffTexts] = useState<Map<string, BlobTexts>>(new Map());
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
  // Kept for the session: the moved file is the user's to look at.
  const [draftsSetAside, setDraftsSetAside] = useState<string | null>(null);
  const [draftsHidden, setDraftsHidden] = useState(0);
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
      const stored = await service.drafts?.save(key, next);
      setDraftSaveError(null);
      if (!stored) return next;
      if (draftsForRef.current === key) showStored(stored);
      return stored.drafts;
    } catch (err) {
      setDraftSaveError(formatErrorMessage(err));
      throw err;
    }
  }

  function showStored(stored: StoredDrafts) {
    draftsRef.current = stored.drafts;
    setDrafts(stored.drafts);
    setDraftsHidden(stored.hidden);
    if (stored.setAside) setDraftsSetAside(stored.setAside);
  }

  /** Edits from the screen: a failed write shows in the header, the drafts stay in memory. */
  function changeDrafts(change: (list: readonly CommentDraft[]) => readonly CommentDraft[]) {
    if (!prDetail?.pullRequestId) return;
    storeDrafts(draftKey(prDetail), change(draftsRef.current)).catch(() => {});
  }

  function addDraft(content: string, target: DraftTarget) {
    const tip = tipOf(prDetail);
    if (!tip) return;
    changeDrafts((list) => [...list, newDraft(content, target, tip)]);
  }

  async function loadDrafts(key: string) {
    if (draftsForRef.current === key) return;
    draftsForRef.current = key;
    draftsRef.current = [];
    setDrafts([]);
    setDraftsHidden(0);
    setDraftError(null);
    if (!service.drafts) return;
    try {
      const stored = await service.drafts.load(key);
      if (draftsForRef.current === key) showStored(stored);
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
      const result = await postPullRequestDrafts({
        service,
        repository: selectedRepo,
        pullRequestId,
        current: () => draftsRef.current,
        save: (list) => storeDrafts(key, list),
        progress: (done, total) => setDraftProgress({ done, total }),
        onTip: (tip) => {
          const old = tipOf(prDetail);
          moved =
            old?.afterCommitId !== tip.afterCommitId || old?.beforeCommitId !== tip.beforeCommitId;
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

  /** A general comment, or an inline one at `location`. */
  const postCommentAction = useAsyncAction(
    async (content: string, location?: InlineLocation) => {
      const tip = tipOf(prDetail);
      if (!prDetail?.pullRequestId || !tip) return;
      await service.postComment({
        pullRequestId: prDetail.pullRequestId,
        repositoryName: selectedRepo,
        ...tip,
        content,
        ...(location ? { location } : {}),
      });
      await reloadComments(prDetail.pullRequestId);
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
      await reloadReactionsOf(commentId);
    },
    (err) => formatErrorMessage(err, "reaction"),
  );

  const [activityEvents, setActivityEvents] = useState<PrActivityEvent[]>([]);
  const [activityNextToken, setActivityNextToken] = useState<string | undefined>(undefined);
  // A load answered after a newer one began (the timeline left and opened
  // again, maybe on another PR) is dropped.
  const activityLoadRef = useRef(0);
  const activityAction = useAsyncAction(
    async (pullRequestId: string, nextToken?: string) => {
      const loadId = ++activityLoadRef.current;
      const isStale = () => activityLoadRef.current !== loadId;
      try {
        const result = await service.getPullRequestActivity({
          pullRequestId,
          ...(nextToken !== undefined ? { nextToken } : {}),
          maxResults: 50,
        });
        if (isStale()) return;
        if (nextToken) {
          setActivityEvents((prev) => [...prev, ...result.events]);
        } else {
          setActivityEvents(result.events);
        }
        setActivityNextToken(result.nextToken);
      } catch (err) {
        if (isStale()) return;
        if (err instanceof Error && err.name === "InvalidContinuationTokenException") {
          setActivityEvents([]);
          setActivityNextToken(undefined);
          // Retry from the start inside this action so execute() is not re-entered
          // (that would flicker loading / risk a retry loop).
          const retry = await service.getPullRequestActivity({ pullRequestId, maxResults: 50 });
          if (isStale()) return;
          setActivityEvents(retry.events);
          setActivityNextToken(retry.nextToken);
          return;
        }
        throw err;
      }
    },
    (err) => formatErrorMessage(err, "activity"),
  );

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
    const ids = reactedCommentIds(threads);
    const reactions = ids.length > 0 ? await service.getReactionsForComments(ids) : new Map();
    if (isDetailLoadStale(loadId)) return;
    setReactionsByComment(reactions);
  }

  /** After a reaction only that comment changed: the others keep what was read. */
  async function reloadReactionsOf(commentId: string, loadId = detailLoadRef.current) {
    const reactions = (await service.getReactionsForComments([commentId])).get(commentId);
    if (isDetailLoadStale(loadId)) return;
    setReactionsByComment((prev) => {
      const next = new Map(prev);
      if (reactions) next.set(commentId, reactions);
      else next.delete(commentId);
      return next;
    });
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
      filteredPullRequests.push(...result.pullRequests.filter((pr) => pr.status === status));
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
      setChecks(null);
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
        | { key: string; status: "loaded"; texts: BlobTexts }
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

      const revisionId = detail.pullRequest.revisionId;
      if (revisionId) void reloadApprovals(pullRequestId, revisionId, loadId);

      // Background: CI. Each lookup's failure is inside the result; a failure
      // to load the CI clients at all leaves the line out.
      if (service.checks && sourceCommit) {
        service.checks({ repository: selectedRepo, sourceCommit }).then(
          (loaded) => {
            if (!isDetailLoadStale(loadId)) setChecks(loaded);
          },
          () => undefined,
        );
      }

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
    }));

    void loadPullRequests(selectedRepo, statusFilter, prevCursor);
  }

  async function reloadComments(pullRequestId: string, loadId = detailLoadRef.current) {
    // Optimized: fetch only comments instead of full PR detail
    const target = prDetail?.pullRequestTargets?.[0];
    const threads = await service.getComments(pullRequestId, target?.sourceCommit);
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
      // Without the rules line the approvals still show.
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
    } catch {
      // Nobody awaits this load: a rejection here would end the process.
      // The commit view stays empty and Tab leaves it.
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

  /** Esc. At the top (lazycc pr view or pr list on its own) it stays, as in lazygit: q quits. */
  function handleBack() {
    if (screen === "detail" && hasList) setScreen("prs");
    else onExit?.();
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

  if (help.open && (screen === "prs" || screen === "detail")) {
    return (
      <HelpMenu
        title={screen === "prs" ? "Pull requests help" : "Review help"}
        sections={screen === "prs" ? PR_LIST_HELP : PR_DETAIL_HELP}
        onClose={help.close}
        onRun={help.run}
      />
    );
  }

  if (error) return <ErrorScreen error={error} onBack={onExit} onQuit={quit} />;

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
          onHelp={help.show}
          statusFilter={statusFilter}
          onChangeStatusFilter={handleChangeStatusFilter}
          searchQuery={searchQuery}
          onChangeSearchQuery={setSearchQuery}
          pagination={{
            currentPage: pagination.previousCursors.length + 1,
            hasNextPage: pagination.hasNextPage,
            hasPreviousPage: pagination.previousCursors.length > 0,
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
          onHelp={help.show}
          onShowActivity={handleShowActivity}
          comment={postCommentAction}
          reply={postReplyAction}
          approval={{ ...approvalAction, approvals, evaluation: approvalEvaluation }}
          checks={checks}
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
            setAside: draftsSetAside,
            hidden: draftsHidden,
            add: addDraft,
            edit: (id, content) =>
              changeDrafts((list) => list.map((d) => (d.id === id ? editDraft(d, content) : d))),
            discard: (id) => changeDrafts((list) => list.filter((d) => d.id !== id)),
            postAnyway: (id) => {
              const tip = tipOf(prDetail);
              if (!tip) return;
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

function ErrorScreen({
  error,
  onBack,
  onQuit,
}: {
  error: string;
  onBack: (() => void) | undefined;
  onQuit: () => void;
}) {
  useKeys((input, key) => {
    if (input === "q") onQuit();
    else if (key.escape) onBack?.();
  });
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red" bold>
        Error: {error}
      </Text>
      <Text dimColor>{onBack ? "Esc back, q quit" : "q quit"}</Text>
    </Box>
  );
}
