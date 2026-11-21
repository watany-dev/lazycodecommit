export interface DisplayLine {
  type:
    | "header"
    | "separator"
    | "add"
    | "delete"
    | "context"
    | "truncation"
    | "truncate-context"
    | "comment-header"
    | "comment"
    | "inline-comment"
    | "inline-reply"
    | "comment-reply"
    | "fold-indicator";
  text: string;
  filePath?: string;
  diffKey?: string;
  beforeLineNumber?: number;
  afterLineNumber?: number;
  threadIndex?: number | undefined;
  commentId?: string | undefined;
  reactionText?: string;
}

/** Lookahead window for detecting nearby matching lines (reorders/small edits). */
const LOOKAHEAD_WINDOW = 5;

function hasNearbyMatch(lines: string[], start: number, target: string): boolean {
  const end = Math.min(lines.length, start + LOOKAHEAD_WINDOW);
  for (let i = start; i < end; i++) {
    if (lines[i] === target) return true;
  }
  return false;
}

/**
 * A greedy diff that prefers matching lines over a minimal edit distance. The
 * lookahead stops a run of deletions or additions at a line that matches
 * soon after, so reordered lines do not turn into long delete/add blocks.
 */
export function computeSimpleDiff(beforeLines: string[], afterLines: string[]): DisplayLine[] {
  const result: DisplayLine[] = [];
  // Inputs are never mutated, so hoist lengths out of the hot loop.
  const blen = beforeLines.length;
  const alen = afterLines.length;
  let bi = 0;
  let ai = 0;

  while (bi < blen || ai < alen) {
    const beforeLine = beforeLines[bi];
    const afterLine = afterLines[ai];

    if (bi < blen && ai < alen && beforeLine === afterLine) {
      result.push({
        type: "context",
        text: ` ${beforeLine}`,
        beforeLineNumber: bi + 1,
        afterLineNumber: ai + 1,
      });
      bi++;
      ai++;
    } else {
      const startBi = bi;
      const startAi = ai;

      // oxlint-disable-next-line no-unmodified-loop-condition -- ai stays put while deletions are consumed
      while (bi < blen && (ai >= alen || beforeLines[bi] !== afterLines[ai])) {
        const bl = beforeLines[bi]!;
        if (hasNearbyMatch(afterLines, ai, bl)) break;
        result.push({
          type: "delete",
          text: `-${bl}`,
          beforeLineNumber: bi + 1,
        });
        bi++;
      }

      // oxlint-disable-next-line no-unmodified-loop-condition -- bi stays put while additions are consumed
      while (ai < alen && (bi >= blen || afterLines[ai] !== beforeLines[bi])) {
        const al = afterLines[ai]!;
        if (hasNearbyMatch(beforeLines, bi, al)) break;
        result.push({
          type: "add",
          text: `+${al}`,
          afterLineNumber: ai + 1,
        });
        ai++;
      }

      // Safety: if both loops broke without advancing, force progress to prevent infinite loop
      /* v8 ignore start -- defensive guard; the greedy algorithm always advances in normal cases */
      if (bi === startBi && ai === startAi) {
        if (bi < blen) {
          result.push({
            type: "delete",
            text: `-${beforeLines[bi]}`,
            beforeLineNumber: bi + 1,
          });
          bi++;
        }
        if (ai < alen) {
          result.push({
            type: "add",
            text: `+${afterLines[ai]}`,
            afterLineNumber: ai + 1,
          });
          ai++;
        }
      }
      /* v8 ignore stop */
    }
  }

  return result;
}
