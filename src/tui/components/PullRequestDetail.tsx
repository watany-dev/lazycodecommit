import { basename } from "node:path";
import type { Approval, Difference, Evaluation, PullRequest } from "@aws-sdk/client-codecommit";
import { Box, Text, useStdout } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import wrapAnsi from "wrap-ansi";
import { CHECK_COLOR, CHECK_MARK, type Checks, noRun } from "../../core/checks.js";
import type { CommentDraft, DraftTarget } from "../../core/commentDrafts.js";
import type {
  CommentThread,
  CommitInfo,
  ConflictSummary,
  MergeStrategy,
  ReactionsByComment,
} from "../../core/review.js";
import { head, printable, shortArn } from "../../core/text.js";
import type { AsyncActionState } from "../hooks/useAsyncAction.js";
import { useAsyncDismiss } from "../hooks/useAsyncDismiss.js";
import { useKeys } from "../hooks/useKeys.js";
import { useQuit } from "../hooks/useQuit.js";
import { isBottom, isPageDown, isPageUp, isTop } from "../listKeys.js";
import {
  buildDisplayLines,
  COMMENT_LINE_TYPES,
  countLines,
  DIFF_CHUNK_SIZE,
  diffLimitKey,
  FOLD_THRESHOLD,
  getThreadKey,
  LARGE_DIFF_THRESHOLD,
} from "../utils/displayLines.js";
import { formatRelativeDate } from "../utils/formatDate.js";
import type { DisplayLine } from "../utils/formatDiff.js";
import { formatErrorMessage } from "../utils/formatError.js";
import { CommentInput } from "./CommentInput.js";
import { ConfirmPrompt } from "./ConfirmPrompt.js";
import { ConflictDisplay } from "./ConflictDisplay.js";
import { DiffRow } from "./DiffLine.js";
import { DraftList, type DraftSubmitState } from "./DraftList.js";
import { windowStart } from "./FilterLine.js";
import { MergeStrategySelector } from "./MergeStrategySelector.js";
import { ReactionPicker } from "./ReactionPicker.js";

type InlineLocation = {
  filePath: string;
  filePosition: number;
  relativeFileVersion: "BEFORE" | "AFTER";
};

/** Rows of the f file list on screen; a PR of many files scrolls it. */
const FILE_LIST_ROWS = 10;

const EMPTY_STATUS_MAP = new Map<string, "loading" | "loaded" | "error">();

interface CommitViewProps {
  commits: CommitInfo[];
  differences: Difference[];
  diffTexts: Map<string, { before: string; after: string }>;
  isLoading: boolean;
  onLoad: (commitIndex: number) => void;
  commitsAvailable: boolean;
}

interface DraftProps {
  list: readonly CommentDraft[];
  /** Why drafts.json could not be written: the drafts then last only while the screen is open. */
  saveError: string | null;
  /** Where a corrupt drafts.json was moved; what it held is not on the screen. */
  setAside: string | null;
  /** Drafts kept for another lazycc version, which this one neither shows nor posts. */
  hidden: number;
  add: (content: string, target: DraftTarget) => void;
  edit: (id: string, content: string) => void;
  discard: (id: string) => void;
  postAnyway: (id: string) => void;
  submit: () => void;
  state: DraftSubmitState;
}

interface Props {
  pullRequest: PullRequest;
  differences: Difference[];
  commentThreads: CommentThread[];
  diffTexts: Map<string, { before: string; after: string }>;
  diffTextStatus?: Map<string, "loading" | "loaded" | "error">;
  onBack: () => void;
  onHelp: () => void;
  onShowActivity: () => void;
  /** A general comment, or an inline one with a location. */
  comment: AsyncActionState<[content: string, location?: InlineLocation]>;
  reply: AsyncActionState<[inReplyTo: string, content: string]>;
  approval: AsyncActionState<["APPROVE" | "REVOKE"]> & {
    approvals: Approval[];
    evaluation: Evaluation | null;
  };
  merge: AsyncActionState<[strategy: MergeStrategy]> & {
    onCheckConflicts: (strategy: MergeStrategy) => Promise<ConflictSummary>;
    /** The strategy the dialog starts on. */
    preferred?: MergeStrategy | undefined;
  };
  close: AsyncActionState<[]>;
  commitView: CommitViewProps;
  editComment: AsyncActionState<[commentId: string, content: string]>;
  deleteComment: AsyncActionState<[commentId: string]>;
  reaction: AsyncActionState<[commentId: string, reactionValue: string]> & {
    byComment: ReactionsByComment;
  };
  /** Absent: c / C / R only post immediately and there is no draft list. */
  drafts?: DraftProps;
  /** CI on the source commit (ADR 0010); null while loading or when the config's ci lists nothing. */
  checks?: Checks | null;
}

function buildCollapsedThreadState(
  threads: CommentThread[],
  previous?: Map<string, boolean>,
): Map<string, boolean> {
  const next = new Map<string, boolean>();
  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i]!;
    const key = getThreadKey(thread, i);
    next.set(key, previous?.get(key) ?? thread.comments.length >= FOLD_THRESHOLD);
  }
  return next;
}

export function PullRequestDetail({
  pullRequest,
  differences,
  commentThreads,
  diffTexts,
  diffTextStatus = EMPTY_STATUS_MAP,
  onBack,
  onHelp,
  onShowActivity,
  comment,
  reply,
  approval,
  merge,
  close,
  commitView: {
    commits,
    differences: commitDifferences,
    diffTexts: commitDiffTexts,
    isLoading: isLoadingCommitDiff,
    onLoad: onLoadCommitDiff,
    commitsAvailable,
  },
  editComment,
  deleteComment,
  reaction,
  drafts,
  checks = null,
}: Props) {
  const quit = useQuit();
  const [cursorIndex, setCursorIndex] = useState(0);
  const [isCommenting, setIsCommenting] = useState(false);
  const [inlineCommentLocation, setInlineCommentLocation] = useState<InlineLocation | null>(null);
  const [replyTarget, setReplyTarget] = useState<{
    commentId: string;
    author: string;
    content: string;
  } | null>(null);
  const [approvalAction, setApprovalAction] = useState<"approve" | "revoke" | null>(null);
  const [mergeStep, setMergeStep] = useState<"strategy" | "confirm" | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<MergeStrategy>("fast-forward");
  const [conflictSummary, setConflictSummary] = useState<ConflictSummary | null>(null);
  const [isCheckingConflicts, setIsCheckingConflicts] = useState(false);
  /** Why the conflict check failed, shown until the next key. */
  const [conflictCheckError, setConflictCheckError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [viewIndex, setViewIndex] = useState(-1); // -1 = All changes
  const [collapsedThreads, setCollapsedThreads] = useState<Map<string, boolean>>(() =>
    buildCollapsedThreadState(commentThreads),
  );
  const [editTarget, setEditTarget] = useState<{
    commentId: string;
    content: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    commentId: string;
  } | null>(null);
  const [reactionTarget, setReactionTarget] = useState<string | null>(null);
  const [diffLineLimits, setDiffLineLimits] = useState<Map<string, number>>(new Map());
  const [showFileList, setShowFileList] = useState(false);
  const [fileListCursor, setFileListCursor] = useState(0);
  const [pendingBracket, setPendingBracket] = useState<"[" | "]" | null>(null);
  // Reopened on the outcome of a post that reloaded the PR (new commits).
  const [showDrafts, setShowDrafts] = useState(() => !!drafts?.state.error);
  // The commented line as it reads now, so a draft notices when it moves.
  const [inlineLineText, setInlineLineText] = useState("");
  const diffCacheRef = useRef<Map<string, DisplayLine[]>>(new Map());

  useEffect(() => {
    setDiffLineLimits(new Map());
    diffCacheRef.current = new Map();
  }, [differences]);

  useEffect(() => {
    setCollapsedThreads((prev) => buildCollapsedThreadState(commentThreads, prev));
  }, [commentThreads]);

  useAsyncDismiss(comment.isProcessing, comment.error, () => {
    setIsCommenting(false);
    setInlineCommentLocation(null);
  });
  useAsyncDismiss(reply.isProcessing, reply.error, () => setReplyTarget(null));
  useAsyncDismiss(approval.isProcessing, approval.error, () => setApprovalAction(null));
  /* v8 ignore next -- merge success auto-close tested in app.test.tsx */
  useAsyncDismiss(merge.isProcessing, merge.error, () => setMergeStep(null));
  /* v8 ignore next -- close success auto-close tested in app.test.tsx */
  useAsyncDismiss(close.isProcessing, close.error, () => setIsClosing(false));
  useAsyncDismiss(editComment.isProcessing, editComment.error, () => setEditTarget(null));
  useAsyncDismiss(deleteComment.isProcessing, deleteComment.error, () => setDeleteTarget(null));
  useAsyncDismiss(reaction.isProcessing, reaction.error, () => setReactionTarget(null));

  const target = pullRequest.pullRequestTargets?.[0];
  const title = pullRequest.title ?? "(no title)";
  const prId = pullRequest.pullRequestId ?? "";
  const author = shortArn(pullRequest.authorArn ?? "unknown");
  const status = pullRequest.pullRequestStatus ?? "OPEN";
  const creationDate = pullRequest.creationDate ? formatRelativeDate(pullRequest.creationDate) : "";
  const destRef = printable(target?.destinationReference?.replace("refs/heads/", "") ?? "");
  const sourceRef = printable(target?.sourceReference?.replace("refs/heads/", "") ?? "");

  const approvedUsers = useMemo(
    () => approval.approvals.filter((a) => a.approvalState === "APPROVE"),
    [approval.approvals],
  );

  const lines = useMemo(() => {
    if (viewIndex === -1) {
      return buildDisplayLines(
        differences,
        diffTexts,
        diffTextStatus,
        diffLineLimits,
        commentThreads,
        collapsedThreads,
        reaction.byComment,
        diffCacheRef.current,
      );
    }
    return buildDisplayLines(
      commitDifferences,
      commitDiffTexts,
      new Map(),
      diffLineLimits,
      [],
      new Map(),
      new Map(),
    );
  }, [
    viewIndex,
    differences,
    diffTexts,
    diffTextStatus,
    diffLineLimits,
    commentThreads,
    collapsedThreads,
    reaction.byComment,
    commitDifferences,
    commitDiffTexts,
  ]);

  // Keep 0 <= cursorIndex < max(lines.length, 1) when lines shrink (thread fold,
  // comment deletion) or are replaced (view switch), so a row is always highlighted.
  useEffect(() => {
    setCursorIndex((prev) => Math.max(0, Math.min(prev, lines.length - 1)));
  }, [lines.length]);

  const hasTruncation = useMemo(() => lines.some((line) => line.type === "truncation"), [lines]);

  const headerIndices = useMemo(
    () =>
      lines.reduce<number[]>((acc, line, i) => {
        if (line.type === "header") acc.push(i);
        return acc;
      }, []),
    [lines],
  );

  const fileNames = useMemo(() => headerIndices.map((i) => lines[i]!.text), [headerIndices, lines]);

  const filePosition = useMemo(() => {
    if (headerIndices.length === 0) return { current: 0, total: 0 };
    const current =
      Math.max(
        headerIndices.findLastIndex((h) => cursorIndex >= h),
        0,
      ) + 1;
    return { current, total: headerIndices.length };
  }, [cursorIndex, headerIndices]);

  async function handleStrategySelect(strategy: MergeStrategy) {
    setSelectedStrategy(strategy);
    setIsCheckingConflicts(true);
    setConflictSummary(null);

    try {
      const summary = await merge.onCheckConflicts(strategy);
      setConflictSummary(summary);
      setIsCheckingConflicts(false);

      if (summary.mergeable) {
        setMergeStep("confirm");
      }
    } catch (err) {
      setIsCheckingConflicts(false);
      setMergeStep(null);
      setConflictCheckError(formatErrorMessage(err, "merge"));
    }
  }

  /** A box, prompt or list below the diff takes the keys and part of the screen. */
  const dialogOpen = Boolean(
    isCommenting ||
      inlineCommentLocation ||
      replyTarget ||
      editTarget ||
      deleteTarget ||
      approvalAction ||
      mergeStep ||
      isClosing ||
      reactionTarget ||
      showDrafts,
  );
  const { stdout } = useStdout();
  const hasRules =
    (approval.evaluation?.approvalRulesSatisfied?.length ?? 0) +
      (approval.evaluation?.approvalRulesNotSatisfied?.length ?? 0) >
    0;
  const keyLine =
    dialogOpen || showFileList
      ? ""
      : pendingBracket
        ? `${pendingBracket}_ Press c for ${pendingBracket === "]" ? "next" : "previous"} change, other key to cancel`
        : viewIndex >= 0
          ? `Tab next Shift+Tab prev ↑↓ ]c/[c change e edit d del a/r approve m merge x close q quit ? help${hasTruncation ? " t more" : ""}`
          : `${commits.length > 0 || commitsAvailable ? "Tab view " : ""}↑↓ n/N file ]c/[c change f list c comment C inline R reply D drafts o fold e edit d del g react a/r approve m merge x close A activity q ? help${hasTruncation ? " t more" : ""}`;
  const conflictError =
    conflictCheckError && `Could not check for conflicts: ${conflictCheckError}`;
  // The key line and an error wrap rather than lose words: count their rows.
  const width = Math.max((stdout.columns || 80) - 2, 1);
  // The rows around the diff: padding, the header lines, the key line, and
  // the optional rules, CI, drafts, commit and error lines.
  const chromeLines =
    8 +
    (drafts?.setAside ? 1 : 0) +
    (drafts && drafts.hidden > 0 ? 1 : 0) +
    wrappedRows(keyLine, width) +
    wrappedRows(conflictError || "", width) +
    (hasRules ? 2 : 0) +
    (checks ? 2 + checks.runs.length : 0) +
    (commits.length > 0 || commitsAvailable ? (viewIndex >= 0 ? 2 : 1) : 0) +
    (isLoadingCommitDiff && viewIndex >= 0 ? 1 : 0);
  // The file list takes its rows plus a title and a key line; a box or prompt
  // below the diff takes about ten more.
  const visibleLineCount = Math.max(
    (stdout.rows || 24) -
      chromeLines -
      (showFileList ? Math.min(fileNames.length, FILE_LIST_ROWS) + 2 : dialogOpen ? 10 : 0),
    3,
  );

  useKeys((input, key) => {
    // File list mode: handle its own keys before the modal guard
    if (showFileList) {
      if (input === "j" || key.downArrow) {
        setFileListCursor((prev) => Math.min(prev + 1, fileNames.length - 1));
      } else if (input === "k" || key.upArrow) {
        setFileListCursor((prev) => Math.max(prev - 1, 0));
      } else if (key.return) {
        const targetIndex = headerIndices[fileListCursor];
        if (targetIndex !== undefined) setCursorIndex(targetIndex);
        setShowFileList(false);
      } else if (isTop(input, key)) setFileListCursor(0);
      else if (isBottom(input, key)) setFileListCursor(Math.max(fileNames.length - 1, 0));
      else if (input === "q") quit();
      else if (key.escape || input === "f" || (key.ctrl && input === "g")) {
        setShowFileList(false);
      }
      return;
    }

    if (dialogOpen) return;
    setConflictCheckError(null);

    if (pendingBracket && input === "c") {
      const isNext = pendingBracket === "]";
      setPendingBracket(null);
      if (isNext) {
        const idx = lines.findIndex(
          (l, i) => i > cursorIndex && (l.type === "add" || l.type === "delete"),
        );
        if (idx !== -1) setCursorIndex(idx);
      } else {
        for (let i = cursorIndex - 1; i >= 0; i--) {
          if (lines[i]!.type === "add" || lines[i]!.type === "delete") {
            setCursorIndex(i);
            break;
          }
        }
      }
      return;
    }
    if (pendingBracket) {
      setPendingBracket(null);
    }

    if (key.tab && (commits.length > 0 || commitsAvailable)) {
      if (commits.length === 0) {
        // Commits that never came (none, or failed to load): Tab goes back.
        if (viewIndex >= 0 && !isLoadingCommitDiff) {
          setViewIndex(-1);
          setCursorIndex(0);
          return;
        }
        // Lazy load: trigger first commit load
        setViewIndex(0);
        setCursorIndex(0);
        onLoadCommitDiff(0);
        return;
      }

      const newIndex = key.shift
        ? viewIndex - 1 < -1
          ? commits.length - 1
          : viewIndex - 1
        : viewIndex + 1 > commits.length - 1
          ? -1
          : viewIndex + 1;

      setViewIndex(newIndex);
      setCursorIndex(0);
      if (newIndex >= 0) {
        onLoadCommitDiff(newIndex);
      }
      return;
    }

    if (input === "q") {
      quit();
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (input === "?") {
      onHelp();
      return;
    }
    if (input === "j" || key.downArrow) {
      setCursorIndex((prev) => Math.max(0, Math.min(prev + 1, lines.length - 1)));
      return;
    }
    if (input === "k" || key.upArrow) {
      setCursorIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (input === "t") {
      const currentLine = lines[cursorIndex];
      const diffKey = currentLine?.diffKey;
      if (!diffKey) return;
      const texts = (viewIndex >= 0 ? commitDiffTexts : diffTexts).get(diffKey);
      /* v8 ignore next -- diffKey originates from diffTexts entries */
      if (!texts) return;
      const totalLines = countLines(texts.before) + countLines(texts.after);
      if (totalLines <= LARGE_DIFF_THRESHOLD) return;
      const limitKey = diffLimitKey(currentLine.filePath ?? "", diffKey);
      const currentLimit = diffLineLimits.get(limitKey) ?? DIFF_CHUNK_SIZE;
      /* v8 ignore next -- requires many t-presses to reach full expansion */
      if (currentLimit >= totalLines) return;
      const nextLimit = Math.min(currentLimit + DIFF_CHUNK_SIZE, totalLines);
      setDiffLineLimits((prev) => {
        const next = new Map(prev);
        next.set(limitKey, nextLimit);
        return next;
      });
      return;
    }
    if (isPageDown(input, key)) {
      if (lines.length === 0) return;
      const halfPage = Math.floor(visibleLineCount / 2);
      setCursorIndex((prev) => Math.min(prev + halfPage, lines.length - 1));
      return;
    }
    if (isPageUp(input, key)) {
      if (lines.length === 0) return;
      const halfPage = Math.floor(visibleLineCount / 2);
      setCursorIndex((prev) => Math.max(prev - halfPage, 0));
      return;
    }
    if (input === "G" || isBottom(input, key)) {
      if (lines.length === 0) return;
      setCursorIndex(lines.length - 1);
      return;
    }
    // <, Home: jump to the top (g is react)
    if (isTop(input, key)) {
      setCursorIndex(0);
      return;
    }
    if (input === "n") {
      const idx = findNextHeaderIndex(headerIndices, cursorIndex);
      if (idx !== -1) setCursorIndex(idx);
      return;
    }
    if (input === "N") {
      const idx = findPrevHeaderIndex(headerIndices, cursorIndex);
      if (idx !== -1) setCursorIndex(idx);
      return;
    }
    // f, Ctrl+g (lazygit's jump to file): file list
    if (input === "f" || (key.ctrl && input === "g")) {
      if (viewIndex >= 0) return;
      setShowFileList(true);
      setFileListCursor(0);
      return;
    }
    if (input === "c") {
      if (viewIndex >= 0) return;
      setIsCommenting(true);
      return;
    }
    if (input === "C") {
      if (viewIndex >= 0) return;
      const currentLine = lines[cursorIndex];
      if (!currentLine) return;
      const location = getLocationFromLine(currentLine);
      if (!location) return;
      setInlineCommentLocation(location);
      setInlineLineText(currentLine.text.slice(1));
      return;
    }
    if (input === "o") {
      const currentLine = lines[cursorIndex];
      if (!currentLine) return;
      if (currentLine.threadIndex === undefined) return;
      const thread = commentThreads[currentLine.threadIndex];
      if (!thread) return;
      const threadKey = getThreadKey(thread, currentLine.threadIndex);
      const defaultCollapsed = thread.comments.length >= FOLD_THRESHOLD;
      const collapsing = defaultCollapsed && !(collapsedThreads.get(threadKey) ?? true);
      // Folding from a reply removes the cursor's row: stay on the thread's fold line.
      // The fold line follows the root comment's rows, one per line of it.
      const root = rootRowOf(lines, cursorIndex);
      let foldRow = root + 1;
      while (lines[foldRow]?.commentId === lines[root]!.commentId) foldRow++;
      if (collapsing && cursorIndex >= foldRow) setCursorIndex(foldRow);
      setCollapsedThreads((prev) => {
        const next = new Map(prev);
        next.set(threadKey, !(prev.get(threadKey) ?? defaultCollapsed));
        return next;
      });
      return;
    }
    if (input === "R") {
      const currentLine = lines[cursorIndex];
      if (!currentLine) return;
      const commentId = commentIdOf(currentLine);
      if (!commentId) return;
      // A comment's first row names its author.
      const first = lines.find((l) => l.commentId === commentId) as DisplayLine;
      setReplyTarget(getReplyTargetFromLine(first));
      return;
    }
    if (input === "a") {
      setApprovalAction("approve");
      return;
    }
    if (input === "r") {
      setApprovalAction("revoke");
      return;
    }
    if (input === "m" || input === "M") {
      setMergeStep("strategy");
      return;
    }
    if (input === "x") {
      setIsClosing(true);
      return;
    }
    if (input === "A") {
      onShowActivity();
      return;
    }
    if (input === "e") {
      const currentLine = lines[cursorIndex];
      if (!currentLine) return;
      const commentId = commentIdOf(currentLine);
      if (!commentId) return;
      setEditTarget({ commentId, content: findCommentContent(commentThreads, commentId) });
      return;
    }
    if (input === "d") {
      const currentLine = lines[cursorIndex];
      if (!currentLine) return;
      const commentId = commentIdOf(currentLine);
      if (!commentId) return;
      setDeleteTarget({ commentId });
      return;
    }
    if (input === "g") {
      if (viewIndex >= 0) return;
      const currentLine = lines[cursorIndex];
      if (!currentLine) return;
      const commentId = commentIdOf(currentLine);
      if (!commentId) return;
      setReactionTarget(commentId);
      return;
    }
    if (input === "D" && drafts) {
      setShowDrafts(true);
      return;
    }
    if (input === "]") {
      setPendingBracket("]");
      return;
    }
    if (input === "[") {
      setPendingBracket("[");
      return;
    }
  });

  const scrollOffset = useMemo(() => {
    const halfVisible = Math.floor(visibleLineCount / 2);
    const maxOffset = Math.max(0, lines.length - visibleLineCount);
    const idealOffset = cursorIndex - halfVisible;
    return Math.max(0, Math.min(idealOffset, maxOffset));
  }, [cursorIndex, lines.length, visibleLineCount]);
  const visibleLines = lines.slice(scrollOffset, scrollOffset + visibleLineCount);
  const fileListTop = windowStart(fileListCursor, FILE_LIST_ROWS, fileNames.length);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Each header line is one row, cut at the edge: chromeLines counts them. */}
      <Text bold color="cyan" wrap="truncate">
        PR #{prId}: {title}
      </Text>
      <Text wrap="truncate">
        Author: {author} Status: {status} {creationDate}
      </Text>
      <Box marginBottom={1}>
        {/* Long branch names give way to the file count and the drafts. */}
        <Text dimColor wrap="truncate">
          {destRef} ← {sourceRef}
        </Text>
        <Box flexShrink={0}>
          {filePosition.total > 0 && (
            <Text dimColor>
              {" "}
              File {filePosition.current}/{filePosition.total}
            </Text>
          )}
          {drafts && drafts.list.length > 0 && (
            <Text color="yellow"> Drafts: {drafts.list.length} (D)</Text>
          )}
        </Box>
        {drafts?.saveError && (
          <Text color="red" wrap="truncate">
            {" "}
            Drafts not saved: {drafts.saveError}
          </Text>
        )}
      </Box>
      {drafts?.setAside && (
        <Text color="yellow" wrap="truncate">
          drafts.json was unreadable: kept beside it as {basename(drafts.setAside)}
        </Text>
      )}
      {drafts && drafts.hidden > 0 && (
        <Text color="yellow" wrap="truncate">
          {drafts.hidden} {drafts.hidden === 1 ? "draft" : "drafts"} from another lazycc version
          kept, not shown
        </Text>
      )}
      <Box>
        <Text wrap="truncate">
          Approvals:{" "}
          {approvedUsers.length > 0
            ? `${approvedUsers.map((a) => shortArn(a.userArn ?? "")).join(", ")} ✓`
            : "(none)"}
        </Text>
      </Box>
      {approval.evaluation &&
        (approval.evaluation.approvalRulesSatisfied?.length ?? 0) +
          (approval.evaluation.approvalRulesNotSatisfied?.length ?? 0) >
          0 && (
          <Box marginBottom={1}>
            <Text wrap="truncate">
              Rules: {approval.evaluation.approved ? "✓" : "✗"}{" "}
              {approval.evaluation.approved ? "Approved" : "Not approved"} (
              {approval.evaluation.approvalRulesSatisfied?.length ?? 0}/
              {(approval.evaluation.approvalRulesSatisfied?.length ?? 0) +
                (approval.evaluation.approvalRulesNotSatisfied?.length ?? 0)}{" "}
              rules satisfied)
            </Text>
          </Box>
        )}
      {checks && <ChecksLines checks={checks} />}
      {(commits.length > 0 || commitsAvailable) && (
        <Box flexDirection="column" marginBottom={0}>
          <Text wrap="truncate">
            {viewIndex === -1 ? (
              <>
                <Text bold color="cyan">
                  [All changes]
                </Text>
                {commits.length > 0 && <Text> Commits ({commits.length})</Text>}
              </>
            ) : commits[viewIndex] ? (
              <>
                <Text>All changes </Text>
                <Text bold color="cyan">
                  [Commit {viewIndex + 1}/{commits.length}]
                </Text>
                <Text> {commits[viewIndex]!.shortId}</Text>
              </>
            ) : (
              <>
                <Text>All changes </Text>
                <Text color="cyan">Loading commits...</Text>
              </>
            )}
          </Text>
          {viewIndex >= 0 && commits[viewIndex] && (
            <Text dimColor wrap="truncate">
              {`${commits[viewIndex]!.message} ${commits[viewIndex]!.authorName} ${formatRelativeDate(commits[viewIndex]!.authorDate)}`}
            </Text>
          )}
        </Box>
      )}
      {isLoadingCommitDiff && viewIndex >= 0 && (
        <Box>
          <Text color="cyan">Loading commit diff...</Text>
        </Box>
      )}
      <Box flexDirection="column">
        {visibleLines.map((line, index) => {
          const globalIndex = scrollOffset + index;
          return <DiffRow key={globalIndex} line={line} isCursor={globalIndex === cursorIndex} />;
        })}
      </Box>
      {isCommenting && (
        <CommentInput
          onSubmit={comment.execute}
          onDraft={
            drafts &&
            ((content) => {
              drafts.add(content, { kind: "general" });
              setIsCommenting(false);
            })
          }
          onCancel={() => {
            setIsCommenting(false);
            comment.clearError();
          }}
          isPosting={comment.isProcessing}
          error={comment.error}
          onClearError={comment.clearError}
        />
      )}
      {inlineCommentLocation && (
        <Box flexDirection="column">
          <Text dimColor>
            Inline comment on {printable(inlineCommentLocation.filePath)}:
            {inlineCommentLocation.filePosition}
          </Text>
          <CommentInput
            onSubmit={(content) => comment.execute(content, inlineCommentLocation)}
            onDraft={
              drafts &&
              ((content) => {
                drafts.add(content, {
                  kind: "inline",
                  location: { ...inlineCommentLocation, lineText: inlineLineText },
                });
                setInlineCommentLocation(null);
              })
            }
            onCancel={() => {
              setInlineCommentLocation(null);
              comment.clearError();
            }}
            isPosting={comment.isProcessing}
            error={comment.error}
            onClearError={comment.clearError}
          />
        </Box>
      )}
      {replyTarget && (
        <Box flexDirection="column">
          <Text dimColor>
            Replying to {replyTarget.author}: {head(replyTarget.content, 50)}
            {head(replyTarget.content, 50).length < replyTarget.content.length ? "..." : ""}
          </Text>
          <CommentInput
            onSubmit={(content) => reply.execute(replyTarget.commentId, content)}
            onDraft={
              drafts &&
              ((content) => {
                drafts.add(content, {
                  kind: "reply",
                  inReplyTo: replyTarget.commentId,
                  replyTo: {
                    author: replyTarget.author,
                    excerpt: head(replyTarget.content, 50),
                  },
                });
                setReplyTarget(null);
              })
            }
            onCancel={() => {
              setReplyTarget(null);
              reply.clearError();
            }}
            isPosting={reply.isProcessing}
            error={reply.error}
            onClearError={reply.clearError}
          />
        </Box>
      )}
      {approvalAction && (
        <ConfirmPrompt
          message={
            approvalAction === "approve" ? "Approve this pull request?" : "Revoke your approval?"
          }
          onConfirm={
            approvalAction === "approve"
              ? () => approval.execute("APPROVE")
              : () => approval.execute("REVOKE")
          }
          onCancel={() => {
            setApprovalAction(null);
            approval.clearError();
          }}
          isProcessing={approval.isProcessing}
          processingMessage={approvalAction === "approve" ? "Approving..." : "Revoking approval..."}
          error={approval.error}
          onClearError={() => {
            approval.clearError();
            setApprovalAction(null);
          }}
        />
      )}
      {mergeStep === "strategy" && !isCheckingConflicts && !conflictSummary && (
        <MergeStrategySelector
          sourceRef={sourceRef}
          destRef={destRef}
          initial={merge.preferred}
          onSelect={handleStrategySelect}
          onCancel={() => {
            setMergeStep(null);
            setConflictSummary(null);
          }}
        />
      )}
      {isCheckingConflicts && (
        <Box flexDirection="column">
          <Text color="cyan">Checking for conflicts...</Text>
        </Box>
      )}
      {conflictSummary && !conflictSummary.mergeable && (
        <ConflictDisplay
          conflictSummary={conflictSummary}
          strategy={selectedStrategy}
          onDismiss={() => {
            setConflictSummary(null);
            setMergeStep(null);
          }}
        />
      )}
      {mergeStep === "confirm" && (
        <ConfirmPrompt
          message={`Merge ${sourceRef} into ${destRef} using ${formatStrategyName(selectedStrategy)}?`}
          onConfirm={() => merge.execute(selectedStrategy)}
          onCancel={() => {
            setMergeStep(null);
            setConflictSummary(null);
            merge.clearError();
          }}
          isProcessing={merge.isProcessing}
          processingMessage="Merging..."
          error={merge.error}
          onClearError={() => {
            merge.clearError();
            setMergeStep(null);
          }}
        />
      )}
      {isClosing && (
        <ConfirmPrompt
          message="Close this pull request without merging?"
          onConfirm={() => close.execute()}
          onCancel={() => {
            setIsClosing(false);
            close.clearError();
          }}
          isProcessing={close.isProcessing}
          processingMessage="Closing..."
          error={close.error}
          onClearError={() => {
            close.clearError();
            setIsClosing(false);
          }}
        />
      )}
      {editTarget && (
        <Box flexDirection="column">
          <CommentInput
            onSubmit={(content) => editComment.execute(editTarget.commentId, content)}
            onCancel={() => {
              setEditTarget(null);
              editComment.clearError();
            }}
            isPosting={editComment.isProcessing}
            error={editComment.error}
            onClearError={editComment.clearError}
            initialValue={editTarget.content}
            label="Edit Comment:"
            postingMessage="Updating comment..."
            errorPrefix="Failed to update comment:"
          />
        </Box>
      )}
      {deleteTarget && (
        <ConfirmPrompt
          message="Delete this comment?"
          onConfirm={() => deleteComment.execute(deleteTarget.commentId)}
          onCancel={() => {
            setDeleteTarget(null);
            deleteComment.clearError();
          }}
          isProcessing={deleteComment.isProcessing}
          processingMessage="Deleting comment..."
          error={deleteComment.error}
          onClearError={() => {
            deleteComment.clearError();
            setDeleteTarget(null);
          }}
        />
      )}
      {reactionTarget && (
        <ReactionPicker
          onSelect={(shortCode) => reaction.execute(reactionTarget, shortCode)}
          onCancel={() => {
            setReactionTarget(null);
            reaction.clearError();
          }}
          isProcessing={reaction.isProcessing}
          error={reaction.error}
          onClearError={() => {
            reaction.clearError();
            setReactionTarget(null);
          }}
          currentReactions={reaction.byComment.get(reactionTarget) ?? []}
        />
      )}
      {showDrafts && drafts && (
        <DraftList
          drafts={drafts.list}
          submit={drafts.state}
          onSubmit={drafts.submit}
          onEdit={drafts.edit}
          onDiscard={drafts.discard}
          onPostAnyway={drafts.postAnyway}
          onJump={(draft) => {
            const index = findDraftLine(lines, draft);
            if (index !== -1) {
              setCursorIndex(index);
              setShowDrafts(false);
            }
          }}
          onClose={() => setShowDrafts(false)}
        />
      )}
      {showFileList && (
        <Box flexDirection="column">
          <Text bold>Files ({fileNames.length}):</Text>
          {fileNames.slice(fileListTop, fileListTop + FILE_LIST_ROWS).map((name, i) => (
            <Text key={name} wrap="truncate">
              {fileListTop + i === fileListCursor ? "> " : "  "}
              {name}
            </Text>
          ))}
          <Text dimColor>j/k move Enter select Esc close</Text>
        </Box>
      )}
      {conflictError && <Text color="red">{conflictError}</Text>}
      <Box marginTop={1}>
        <Text dimColor>{keyLine}</Text>
      </Box>
    </Box>
  );
}

/** The rows `text` takes at `width`, wrapped the way Ink wraps a Text. */
function wrappedRows(text: string, width: number): number {
  if (!text) return 0;
  return wrapAnsi(text, width, { trim: false, hard: true }).split("\n").length;
}

/** The first row of the thread that row `index` belongs to. */
function rootRowOf(lines: DisplayLine[], index: number): number {
  const thread = lines[index]?.threadIndex;
  let i = index;
  while (i > 0 && lines[i - 1]!.threadIndex === thread) i--;
  return i;
}

function commentIdOf(line: DisplayLine): string | undefined {
  return COMMENT_LINE_TYPES.has(line.type) ? line.commentId : undefined;
}

/* v8 ignore start -- commentId always matches a thread entry; loop-exit branch unreachable */
function findCommentContent(commentThreads: CommentThread[], commentId: string): string {
  for (const thread of commentThreads) {
    for (const comment of thread.comments) {
      if (comment.commentId === commentId) {
        return comment.content ?? "";
      }
    }
  }
  return "";
}
/* v8 ignore stop */

function getReplyTargetFromLine(line: DisplayLine): {
  commentId: string;
  author: string;
  content: string;
} {
  const commentId = line.commentId as string;

  const text = line.text;
  let author = "unknown";
  let content = text;
  // For inline comments: "💬 author: content" or reply "└ author: content"
  // For general comments: "author: content" or reply "└ author: content"
  const colonIdx = text.indexOf(": ");
  if (colonIdx !== -1) {
    const prefix = text.slice(0, colonIdx);
    content = text.slice(colonIdx + 2);
    author = prefix.replace(/^[💬└\s]+/u, "").trim();
  }

  return { commentId, author, content };
}

function getLocationFromLine(line: DisplayLine): InlineLocation | null {
  if (!line.filePath) return null;

  if (line.type === "delete" && line.beforeLineNumber) {
    return {
      filePath: line.filePath,
      filePosition: line.beforeLineNumber,
      relativeFileVersion: "BEFORE",
    };
  }
  if ((line.type === "add" || line.type === "context") && line.afterLineNumber) {
    return {
      filePath: line.filePath,
      filePosition: line.afterLineNumber,
      relativeFileVersion: "AFTER",
    };
  }

  // A note or placeholder row under a file's name: no line to comment on.
  return null;
}

/** The diff row an inline draft was written on, or -1 when it is not shown. */
function findDraftLine(lines: DisplayLine[], draft: CommentDraft): number {
  if (draft.target.kind !== "inline") return -1;
  const { filePath, filePosition, relativeFileVersion } = draft.target.location;
  return lines.findIndex((l) => {
    if (l.filePath !== filePath) return false;
    return relativeFileVersion === "BEFORE"
      ? l.type === "delete" && l.beforeLineNumber === filePosition
      : (l.type === "add" || l.type === "context") && l.afterLineNumber === filePosition;
  });
}

function findNextHeaderIndex(headerIndices: number[], currentIndex: number): number {
  if (headerIndices.length === 0) return -1;
  const next = headerIndices.find((i) => i > currentIndex);
  return next ?? headerIndices[0]!;
}

function findPrevHeaderIndex(headerIndices: number[], currentIndex: number): number {
  if (headerIndices.length === 0) return -1;
  const prev = headerIndices.toReversed().find((i) => i < currentIndex);
  return prev ?? headerIndices[headerIndices.length - 1]!;
}

function formatStrategyName(strategy: MergeStrategy): string {
  return strategy === "three-way" ? "three-way merge" : strategy;
}

/** The review screen's CI block: the overall state, then one line per project or pipeline. */
function ChecksLines({ checks }: { checks: Checks }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        CI:{" "}
        <Text color={CHECK_COLOR[checks.state]}>
          {CHECK_MARK[checks.state]} {checks.state}
        </Text>
      </Text>
      {checks.runs.map((r) => (
        <Text key={`${r.provider}:${r.name}`} wrap="truncate">
          {"  "}
          <Text color={CHECK_COLOR[r.state]}>{CHECK_MARK[r.state]}</Text> {r.provider}{" "}
          {printable(r.name)}{" "}
          <Text dimColor>
            {r.state === "error"
              ? printable(r.message ?? "")
              : r.state === "none"
                ? noRun(checks.commit)
                : printable(`${r.status} ${r.url ?? ""}`)}
          </Text>
        </Text>
      ))}
    </Box>
  );
}
