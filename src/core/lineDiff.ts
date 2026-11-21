/** One line of a line diff, with its +, - or space in front as unified diff writes it. */
export interface DiffRow {
  type: "add" | "delete" | "context";
  text: string;
  beforeLineNumber?: number;
  afterLineNumber?: number;
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
 * A greedy line diff: it prefers matching lines over the shortest edit script,
 * and the lookahead keeps a reordered line from turning a whole run into
 * deletions and additions.
 */
export function computeSimpleDiff(beforeLines: string[], afterLines: string[]): DiffRow[] {
  const result: DiffRow[] = [];
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
