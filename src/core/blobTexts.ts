import type { Difference } from "@aws-sdk/client-codecommit";
import { mapLimit } from "../aws/codecommit.js";
import type { ReviewService } from "./review.js";

type Blobs = Pick<ReviewService, "getBlobContent">;

export function blobKey(diff: Difference): string {
  return `${diff.beforeBlob?.blobId ?? ""}:${diff.afterBlob?.blobId ?? ""}`;
}

async function loadBlobPair(
  service: Blobs,
  repoName: string,
  diff: Difference,
): Promise<{ key: string; before: string; after: string }> {
  const key = blobKey(diff);
  const beforeBlobId = diff.beforeBlob?.blobId;
  const afterBlobId = diff.afterBlob?.blobId;
  const [before, after] = await Promise.all([
    beforeBlobId ? service.getBlobContent(repoName, beforeBlobId) : Promise.resolve(""),
    afterBlobId ? service.getBlobContent(repoName, afterBlobId) : Promise.resolve(""),
  ]);
  return { key, before, after };
}

export async function fetchBlobTexts(
  service: Blobs,
  repoName: string,
  diffs: Difference[],
): Promise<Map<string, { before: string; after: string }>> {
  const results = await mapLimit(diffs, 5, (diff) => loadBlobPair(service, repoName, diff));
  return new Map(results.map(({ key, before, after }) => [key, { before, after }]));
}

interface StreamCallbacks {
  isStale: () => boolean;
  onLoaded: (key: string, texts: { before: string; after: string }) => void;
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
      const { key, before, after } = await loadBlobPair(service, repoName, diff);
      if (!isStale()) {
        onLoaded(key, { before, after });
      }
    } catch {
      if (!isStale()) {
        onError(blobKey(diff));
      }
    }
  });
}
