import type { Difference } from "@aws-sdk/client-codecommit";
import { type BlobTexts, blobKey } from "../../core/blobTexts.js";
import { computeSimpleDiff } from "../../core/lineDiff.js";
import type { CommentThread, ReactionSummary, ReactionsByComment } from "../../core/review.js";
import { printable, shortArn } from "../../core/text.js";
import type { DisplayLine } from "./formatDiff.js";

export const LARGE_DIFF_THRESHOLD = 1500;
export const DIFF_CHUNK_SIZE = 300;

export const COMMENT_LINE_TYPES = new Set<DisplayLine["type"]>([
  "inline-comment",
  "comment",
  "inline-reply",
  "comment-reply",
]);

export const FOLD_THRESHOLD = 4;

const SEPARATOR_TEXT = "─".repeat(50);

/**
 * What `t` grows a file's shown lines under: two files can have the same
 * contents, and so the same blob key, but each is shown in full on its own.
 */
export function diffLimitKey(filePath: string, diffKey: string): string {
  return `${filePath}\0${diffKey}`;
}

/**
 * The lines of a file: a final newline ends the last line rather than starting
 * an empty one, and an empty file (or the missing side of an add or delete) has none.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Counts lines the way splitLines splits them, without allocating an array. */
export function countLines(text: string): number {
  if (text === "") return 0;
  let count = text.endsWith("\n") ? 0 : 1;
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    count++;
    idx = text.indexOf("\n", idx + 1);
  }
  return count;
}

/** CodeCommit keeps a deleted comment with an empty body; say so rather than show nothing. */
type Comment = CommentThread["comments"][number];

function commentText(comment: Comment): string {
  return comment.deleted ? "(deleted)" : (comment.content ?? "");
}

export function getThreadKey(thread: CommentThread, index: number): string {
  const rootComment = thread.comments.find((comment) => !comment.inReplyTo) ?? thread.comments[0];
  return rootComment?.commentId ?? `thread-${index}`;
}

function formatReactionBadge(reactions: ReactionSummary[] | undefined): string {
  if (!reactions || reactions.length === 0) return "";
  return reactions
    .filter((r) => r.count > 0)
    .map((r) => `${r.emoji}×${r.count}`)
    .join(" ");
}

function appendThreadLines(
  lines: DisplayLine[],
  thread: CommentThread,
  threadIndex: number,
  collapsedThreads: Map<string, boolean>,
  threadKey: string,
  mode: "inline" | "general",
  reactionsByComment: ReactionsByComment,
): void {
  const comments = thread.comments;
  if (comments.length === 0) return;

  const rootComment = comments.find((c) => !c.inReplyTo) ?? comments[0]!;
  const replies = comments.filter((c) => c !== rootComment);
  const shouldFold = comments.length >= FOLD_THRESHOLD;
  const isCollapsed = collapsedThreads.get(threadKey) ?? shouldFold;

  const inline = mode === "inline";
  // One row per line of the comment: a row is one line on the screen. The
  // first names the author; R, e, d and g work from any of them.
  const push = (comment: Comment, type: DisplayLine["type"], prefix: string) => {
    const [first, ...rest] = commentText(comment).split("\n");
    lines.push({
      type,
      text: `${prefix}${shortArn(comment.authorArn ?? "unknown")}: ${first}`,
      threadIndex,
      commentId: comment.commentId,
      reactionText: formatReactionBadge(reactionsByComment.get(comment.commentId ?? "")),
    });
    const indent = " ".repeat(prefix.length);
    for (const text of rest) {
      lines.push({ type, text: `${indent}${text}`, threadIndex, commentId: comment.commentId });
    }
  };

  push(rootComment, inline ? "inline-comment" : "comment", inline ? "💬 " : "");

  if (shouldFold && isCollapsed) {
    lines.push({
      type: "fold-indicator",
      text: `[+${replies.length} replies]`,
      threadIndex,
    });
    return;
  }

  for (const reply of replies) push(reply, inline ? "inline-reply" : "comment-reply", "└ ");
}

/**
 * The first rows of a whole diff that show at most `limit` lines of the two
 * files: an unchanged row shows a line of each. Cutting each file on its own
 * instead would show the lines past one file's cut as deleted or added.
 */
function firstRows(rows: DisplayLine[], limit: number): DisplayLine[] {
  let used = 0;
  let end = 0;
  for (; end < rows.length; end++) {
    used += rows[end]!.type === "context" ? 2 : 1;
    if (used > limit) break;
  }
  return end === rows.length ? rows : rows.slice(0, end);
}

type ThreadEntry = { thread: CommentThread; index: number };

/** Inline threads for a single file, bucketed by line number for each version. */
interface FileThreadIndex {
  before: Map<number, ThreadEntry[]>;
  after: Map<number, ThreadEntry[]>;
}

/**
 * Returns the inline-thread entries anchored to `line`, or undefined when none.
 * Uses integer line-number lookups so the hot loop never concatenates keys.
 */
function findMatchingThreadEntries(
  fileThreads: FileThreadIndex,
  line: DisplayLine,
): ThreadEntry[] | undefined {
  if (line.type === "delete") {
    return line.beforeLineNumber ? fileThreads.before.get(line.beforeLineNumber) : undefined;
  }

  if (line.type === "add") {
    return line.afterLineNumber ? fileThreads.after.get(line.afterLineNumber) : undefined;
  }

  /* v8 ignore start -- context lines always have both line numbers in practice */
  if (line.type === "context") {
    const before = line.beforeLineNumber
      ? fileThreads.before.get(line.beforeLineNumber)
      : undefined;
    const after = line.afterLineNumber ? fileThreads.after.get(line.afterLineNumber) : undefined;
    if (before && after) return [...before, ...after];
    return before ?? after;
  }
  /* v8 ignore stop */

  /* v8 ignore next -- diff lines are only ever add/delete/context */
  return undefined;
}

export function buildDisplayLines(
  differences: Difference[],
  diffTexts: Map<string, BlobTexts>,
  diffTextStatus: Map<string, "loading" | "loaded" | "error">,
  diffLineLimits: Map<string, number>,
  commentThreads: CommentThread[],
  collapsedThreads: Map<string, boolean>,
  reactionsByComment: ReactionsByComment,
  diffCache?: Map<string, DisplayLine[]>,
): DisplayLine[] {
  const lines: DisplayLine[] = [];

  // Index inline comments by file, then by line number per version, so the
  // diff loop below can resolve anchors with integer lookups (no key strings).
  const inlineThreadsByFile = new Map<string, FileThreadIndex>();
  for (let i = 0; i < commentThreads.length; i++) {
    const thread = commentThreads[i]!;
    const location = thread.location;
    if (!location || thread.outdated) continue;

    let fileIndex = inlineThreadsByFile.get(location.filePath);
    if (!fileIndex) {
      fileIndex = { before: new Map(), after: new Map() };
      inlineThreadsByFile.set(location.filePath, fileIndex);
    }
    const bucket = location.relativeFileVersion === "BEFORE" ? fileIndex.before : fileIndex.after;
    const existing = bucket.get(location.filePosition);
    if (existing) {
      existing.push({ thread, index: i });
    } else {
      bucket.set(location.filePosition, [{ thread, index: i }]);
    }
  }

  for (const diff of differences) {
    const filePath = diff.afterBlob?.path ?? diff.beforeBlob?.path ?? "(unknown file)";
    lines.push({ type: "header", text: printable(filePath) });
    lines.push({ type: "separator", text: SEPARATOR_TEXT });

    const key = blobKey(diff);
    const texts = diffTexts.get(key);
    const status = diffTextStatus.get(key) ?? "loading";

    if (texts) {
      // No line numbers, so no inline comment can be put on it.
      if (texts.note) lines.push({ type: "context", text: texts.note, filePath, diffKey: key });
      const beforeCount = countLines(texts.before);
      const afterCount = countLines(texts.after);
      const totalLines = beforeCount + afterCount;
      const defaultLimit = totalLines > LARGE_DIFF_THRESHOLD ? DIFF_CHUNK_SIZE : totalLines;
      const currentLimit = diffLineLimits.get(diffLimitKey(filePath, key)) ?? defaultLimit;
      const displayLimit = Math.min(currentLimit, totalLines);
      // Two files can share a blob key (e.g. two empty files added in one PR), so the
      // key must include the path: cached lines carry `filePath` for inline comments.
      const cacheKey = `${filePath}\0${key}:${displayLimit}`;
      let diffLines = diffCache?.get(cacheKey);
      if (!diffLines) {
        // Split only on cache miss; the warm path never needs the line arrays
        diffLines = firstRows(
          computeSimpleDiff(splitLines(texts.before), splitLines(texts.after)),
          displayLimit,
        );
        // Enrich once here so the hot loop below can push lines without per-call copies
        for (const dl of diffLines) {
          dl.filePath = filePath;
          dl.diffKey = key;
        }
        diffCache?.set(cacheKey, diffLines);
      }
      // Only files that actually have inline threads pay the per-line lookup cost.
      const fileThreads = inlineThreadsByFile.get(filePath);
      const appendThreads = (entries: ThreadEntry[]) => {
        for (const { thread, index: threadIdx } of entries) {
          appendThreadLines(
            lines,
            thread,
            threadIdx,
            collapsedThreads,
            getThreadKey(thread, threadIdx),
            "inline",
            reactionsByComment,
          );
        }
      };
      for (const dl of diffLines) {
        lines.push(dl);

        if (!fileThreads) continue;
        const matchingEntries = findMatchingThreadEntries(fileThreads, dl);
        if (matchingEntries) appendThreads(matchingEntries);
      }
      // A binary file has no line to anchor a thread to: its threads go under its note.
      if (fileThreads && texts.note && totalLines === 0) {
        appendThreads(
          [...fileThreads.before.values(), ...fileThreads.after.values()]
            .flat()
            .toSorted((a, b) => a.index - b.index),
        );
      }
      if (totalLines > displayLimit) {
        const moreCount = Math.min(DIFF_CHUNK_SIZE, totalLines - displayLimit);
        lines.push({
          type: "truncate-context",
          text: `... truncated ${displayLimit}/${totalLines} lines`,
          filePath,
          diffKey: key,
        });
        lines.push({
          type: "truncation",
          text: `[t] show next ${moreCount} lines`,
          filePath,
          diffKey: key,
        });
      }
    } else if (status === "error") {
      lines.push({
        type: "context",
        text: "(Failed to load file content)",
        filePath,
        diffKey: key,
      });
    } else {
      lines.push({
        type: "context",
        text: "(Loading file content...)",
        filePath,
        diffKey: key,
      });
    }

    lines.push({ type: "separator", text: "", diffKey: key, filePath });
  }

  const generalThreads = commentThreads
    .map((t, i) => ({ thread: t, index: i }))
    .filter(({ thread }) => thread.location === null);

  if (generalThreads.length > 0) {
    const totalComments = generalThreads.reduce(
      (sum, { thread }) => sum + thread.comments.length,
      0,
    );
    lines.push({ type: "separator", text: SEPARATOR_TEXT });
    lines.push({ type: "comment-header", text: `Comments (${totalComments}):` });
    for (const { thread, index: threadIdx } of generalThreads) {
      appendThreadLines(
        lines,
        thread,
        threadIdx,
        collapsedThreads,
        getThreadKey(thread, threadIdx),
        "general",
        reactionsByComment,
      );
    }
  }

  // A line number from before a push may point at another line now, so these
  // are listed with where they were written instead of on the diff.
  const earlier = commentThreads
    .map((t, i) => ({ thread: t, index: i }))
    .filter(({ thread }) => thread.location !== null && thread.outdated);
  if (earlier.length > 0) {
    lines.push({ type: "separator", text: SEPARATOR_TEXT });
    lines.push({ type: "comment-header", text: `Earlier revisions (${earlier.length}):` });
    for (const { thread, index: threadIdx } of earlier) {
      const { filePath, filePosition, relativeFileVersion } = thread.location!;
      const side = relativeFileVersion === "BEFORE" ? " (old)" : "";
      lines.push({ type: "comment-header", text: `${printable(filePath)}:${filePosition}${side}` });
      appendThreadLines(
        lines,
        thread,
        threadIdx,
        collapsedThreads,
        getThreadKey(thread, threadIdx),
        "general",
        reactionsByComment,
      );
    }
  }

  return lines;
}
