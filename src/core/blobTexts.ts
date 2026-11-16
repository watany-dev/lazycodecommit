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

/**
 * A file with a binary side is one line instead of a diff: its size, both
 * sizes, or "text" for the side of a file that became binary or stopped being.
 */
function toTexts(before: BlobContent | undefined, after: BlobContent | undefined): BlobTexts {
  if ((!before || "text" in before) && (!after || "text" in after)) {
    return { before: before?.text ?? "", after: after?.text ?? "" };
  }
  let sizes: string;
  if (before && after) {
    sizes =
      "binarySize" in before && "binarySize" in after
        ? `${before.binarySize} → ${after.binarySize} bytes`
        : `${describe(before)} → ${describe(after)}`;
  } else {
    sizes = describe((before ?? after)!);
  }
  return { before: "", after: "", note: `(binary file, ${sizes})` };
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
  return { key, texts: toTexts(before, after) };
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
