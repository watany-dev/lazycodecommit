import type { Difference } from "@aws-sdk/client-codecommit";
import { mapLimit } from "../aws/mapLimit.js";
import type { BlobContent, ReviewService } from "./review.js";

type Blobs = Pick<ReviewService, "getBlobContent">;

/**
 * A changed file's two sides as the diff compares them ("" for a missing side),
 * and a line to show above the diff for what the diff cannot show.
 */
export interface BlobTexts {
  readonly before: string;
  readonly after: string;
  readonly note?: string;
}

export function blobKey(diff: Difference): string {
  return `${diff.beforeBlob?.blobId ?? ""}:${diff.afterBlob?.blobId ?? ""}`;
}

const describe = (b: BlobContent) => ("text" in b ? "text" : `${b.binarySize} bytes`);

type Text = Extract<BlobContent, { text: string }>;

/**
 * The texts compare with CRLF made LF, so a change of line endings alone
 * leaves no changed line. Two mixed files whose texts read the same can only
 * differ in which lines end in CRLF.
 */
function lineEndingsNote(before: Text, after: Text, sameBlob: boolean): string | undefined {
  const [from, to] = [before.lineEndings, after.lineEndings];
  if (!from || !to) return undefined;
  if (from !== to) return `(line endings changed: ${from} → ${to})`;
  if (from === "mixed" && before.text === after.text && !sameBlob) return "(line endings changed)";
  return undefined;
}

/**
 * A file with a binary side is one line instead of a diff: its size, both
 * sizes, or "text" for the side of a file that became binary or stopped being.
 * A blob that did not change (a rename or a mode change) shows one size.
 */
function toTexts(
  diff: Difference,
  before: BlobContent | undefined,
  after: BlobContent | undefined,
): BlobTexts {
  const sameBlob = diff.beforeBlob?.blobId === diff.afterBlob?.blobId;
  if ((!before || "text" in before) && (!after || "text" in after)) {
    const texts = { before: before?.text ?? "", after: after?.text ?? "" };
    const note = before && after && lineEndingsNote(before, after, sameBlob);
    return note ? { ...texts, note } : texts;
  }
  const sides =
    before && after && !sameBlob
      ? `${describe(before)} → ${describe(after)}`
      : describe((before ?? after)!);
  return { before: "", after: "", note: `(binary file, ${sides})` };
}

async function loadBlobPair(
  service: Blobs,
  repoName: string,
  diff: Difference,
): Promise<{ key: string; texts: BlobTexts }> {
  const key = blobKey(diff);
  const beforeBlobId = diff.beforeBlob?.blobId;
  const afterBlobId = diff.afterBlob?.blobId;
  const [before, after] = await Promise.all([
    beforeBlobId ? service.getBlobContent(repoName, beforeBlobId) : undefined,
    afterBlobId ? service.getBlobContent(repoName, afterBlobId) : undefined,
  ]);
  return { key, texts: toTexts(diff, before, after) };
}

export async function fetchBlobTexts(
  service: Blobs,
  repoName: string,
  diffs: Difference[],
): Promise<Map<string, BlobTexts>> {
  const results = await mapLimit(diffs, 5, (diff) => loadBlobPair(service, repoName, diff));
  return new Map(results.map(({ key, texts }) => [key, texts]));
}

interface StreamCallbacks {
  isStale: () => boolean;
  onLoaded: (key: string, texts: BlobTexts) => void;
  onError: (key: string) => void;
}

export async function streamBlobTexts(
  service: Blobs,
  repoName: string,
  differences: Difference[],
  callbacks: StreamCallbacks,
  concurrency = 6,
): Promise<void> {
  const { isStale, onLoaded, onError } = callbacks;
  await mapLimit(differences, concurrency, async (diff) => {
    try {
      const { key, texts } = await loadBlobPair(service, repoName, diff);
      if (!isStale()) {
        onLoaded(key, texts);
      }
    } catch {
      if (!isStale()) {
        onError(blobKey(diff));
      }
    }
  });
}
