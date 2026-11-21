import type { CodeCommitApi, FileChange, PullRequest } from "../aws/codecommit.js";
import type { Git } from "../git/git.js";
import { isBinary } from "./browse.js";
import { computeSimpleDiff, type DiffRow } from "./lineDiff.js";

const CONTEXT = 3;
const decoder = new TextDecoder();

/**
 * The PR's changes as a unified diff, from the merge base to the source commit
 * like the review screen. Inside the clone it is git's own; outside, or when
 * git lacks the commits, it is built from the API in git's format.
 */
export async function pullRequestDiff(
  pr: PullRequest,
  deps: { api: CodeCommitApi; git?: Git },
): Promise<string> {
  const { api, git } = deps;
  if (git) {
    try {
      const base =
        pr.mergeBase ?? (await git.mergeBase(pr.destinationCommit, pr.sourceCommit)) ?? "";
      if (base) return await git.diff(base, pr.sourceCommit);
    } catch {
      // Commits not fetched yet: the API gives the same diff.
    }
  }
  const base = pr.mergeBase ?? pr.destinationCommit;
  const changes = await api.differences(pr.repository, base, pr.sourceCommit);
  const read = (id: string | undefined) => (id ? api.blob(pr.repository, id) : undefined);
  // The client caps the calls in flight, so every blob can be asked for at once.
  const files = await Promise.all(
    changes
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(async (change) => {
        const sameBlob = change.before?.id === change.after?.id;
        const [before, after] = sameBlob
          ? []
          : await Promise.all([read(change.before?.id), read(change.after?.id)]);
        return fileDiff(change, before, after);
      }),
  );
  return files.join("");
}

function fileDiff(change: FileChange, before?: Uint8Array, after?: Uint8Array): string {
  const { path } = change;
  const from = change.before ? `a/${path}` : "/dev/null";
  const to = change.after ? `b/${path}` : "/dev/null";
  const out = [`diff --git a/${path} b/${path}`];
  if (!change.before) out.push(`new file mode ${change.after?.mode}`);
  else if (!change.after) out.push(`deleted file mode ${change.before.mode}`);
  else if (change.before.mode !== change.after.mode)
    out.push(`old mode ${change.before.mode}`, `new mode ${change.after.mode}`);
  if (before || after) {
    if ((before && isBinary(before)) || (after && isBinary(after))) {
      out.push(`Binary files ${from} and ${to} differ`);
    } else {
      const rows = computeSimpleDiff(lines(before), lines(after));
      const hunks = unifiedHunks(rows);
      if (hunks.length > 0) out.push(`--- ${from}`, `+++ ${to}`, ...hunks);
    }
  }
  return `${out.join("\n")}\n`;
}

/**
 * The lines of a file. A last line without a newline keeps a "\n" (which no
 * line can otherwise hold), so it differs from the same line with one, as in git.
 */
function lines(bytes: Uint8Array | undefined): string[] {
  const text = bytes ? decoder.decode(bytes) : "";
  if (text === "") return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  else split[split.length - 1] += "\n";
  return split;
}

/** Hunks with CONTEXT lines around each change; changes closer than twice that share a hunk. */
function unifiedHunks(rows: readonly DiffRow[]): string[] {
  // Lines of each side before row i.
  const beforeAt = [0];
  const afterAt = [0];
  for (const row of rows) {
    beforeAt.push(beforeAt.at(-1)! + (row.type === "add" ? 0 : 1));
    afterAt.push(afterAt.at(-1)! + (row.type === "delete" ? 0 : 1));
  }
  const changed = rows.flatMap((row, i) => (row.type === "context" ? [] : [i]));
  const out: string[] = [];
  for (let i = 0; i < changed.length; i++) {
    const first = changed[i]!;
    let last = first;
    while (i + 1 < changed.length && changed[i + 1]! - last <= 2 * CONTEXT + 1)
      last = changed[++i]!;
    const start = Math.max(0, first - CONTEXT);
    const end = Math.min(rows.length, last + CONTEXT + 1);
    out.push(
      `@@ -${range(beforeAt[start]!, beforeAt[end]!)} +${range(afterAt[start]!, afterAt[end]!)} @@`,
    );
    for (const { text } of rows.slice(start, end)) {
      if (text.endsWith("\n")) out.push(text.slice(0, -1), "\\ No newline at end of file");
      else out.push(text);
    }
  }
  return out;
}

/** A hunk's side as git writes it: an empty side is "line,0" for the line it follows. */
function range(from: number, to: number): string {
  const count = to - from;
  if (count === 1) return `${from + 1}`;
  return `${count === 0 ? from : from + 1},${count}`;
}
