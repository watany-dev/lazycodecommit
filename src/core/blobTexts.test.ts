import type { Difference } from "@aws-sdk/client-codecommit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type BlobTexts, blobKey, fetchBlobTexts, streamBlobTexts } from "./blobTexts.js";
import type { BlobContent } from "./review.js";

const getBlobContent = vi.fn<(repo: string, blobId: string) => Promise<BlobContent>>();
const mockClient = { getBlobContent };

beforeEach(() => {
  vi.mocked(getBlobContent).mockReset();
});

function streamCallbacks(
  overrides: Partial<{
    isStale: () => boolean;
    onLoaded: (key: string, texts: BlobTexts) => void;
    onError: (key: string) => void;
  }> = {},
) {
  return {
    isStale: () => false,
    onLoaded: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("blobKey", () => {
  it("joins before and after blob ids with a colon", () => {
    expect(blobKey({ beforeBlob: { blobId: "b1" }, afterBlob: { blobId: "a1" } })).toBe("b1:a1");
  });

  it("uses empty strings for missing blob ids", () => {
    expect(blobKey({ afterBlob: { blobId: "a1" } })).toBe(":a1");
    expect(blobKey({ beforeBlob: { blobId: "b1" } })).toBe("b1:");
    expect(blobKey({})).toBe(":");
  });
});

describe("fetchBlobTexts", () => {
  it("fetches before and after blob content for each diff", async () => {
    vi.mocked(getBlobContent).mockImplementation((_repo, blobId) =>
      Promise.resolve({ text: `content-of-${blobId}` }),
    );

    const diffs: Difference[] = [
      { beforeBlob: { blobId: "b1" }, afterBlob: { blobId: "a1" } },
      { beforeBlob: { blobId: "b2" }, afterBlob: { blobId: "a2" } },
    ];

    const result = await fetchBlobTexts(mockClient, "my-repo", diffs);

    expect(result.size).toBe(2);
    expect(result.get("b1:a1")).toEqual({ before: "content-of-b1", after: "content-of-a1" });
    expect(result.get("b2:a2")).toEqual({ before: "content-of-b2", after: "content-of-a2" });
  });

  it("handles missing beforeBlob (new file)", async () => {
    vi.mocked(getBlobContent).mockResolvedValue({ text: "new-content" });

    const diffs: Difference[] = [{ beforeBlob: undefined, afterBlob: { blobId: "a1" } }];

    const result = await fetchBlobTexts(mockClient, "my-repo", diffs);

    expect(result.get(":a1")).toEqual({ before: "", after: "new-content" });
  });

  it("handles missing afterBlob (deleted file)", async () => {
    vi.mocked(getBlobContent).mockResolvedValue({ text: "old-content" });

    const diffs: Difference[] = [{ beforeBlob: { blobId: "b1" }, afterBlob: undefined }];

    const result = await fetchBlobTexts(mockClient, "my-repo", diffs);

    expect(result.get("b1:")).toEqual({ before: "old-content", after: "" });
  });

  it("returns empty map for empty diffs", async () => {
    const result = await fetchBlobTexts(mockClient, "my-repo", []);

    expect(result.size).toBe(0);
  });

  it("propagates blob fetch errors", async () => {
    vi.mocked(getBlobContent).mockRejectedValue(new Error("boom"));

    const diffs: Difference[] = [{ beforeBlob: { blobId: "b1" }, afterBlob: { blobId: "a1" } }];

    await expect(fetchBlobTexts(mockClient, "my-repo", diffs)).rejects.toThrow("boom");
  });
});

describe("streamBlobTexts", () => {
  it("calls onLoaded incrementally as each blob pair completes", async () => {
    const pending = new Map<string, { resolve: (value: BlobContent) => void }>();
    vi.mocked(getBlobContent).mockImplementation((_repo, blobId) => {
      return new Promise((resolve) => {
        pending.set(blobId, { resolve });
      });
    });

    const loaded: string[] = [];
    const diffs: Difference[] = [
      { beforeBlob: { blobId: "b1" }, afterBlob: { blobId: "a1" } },
      { beforeBlob: { blobId: "b2" }, afterBlob: { blobId: "a2" } },
    ];
    const done = streamBlobTexts(mockClient, "my-repo", diffs, {
      isStale: () => false,
      onLoaded: (key) => {
        loaded.push(key);
      },
      onError: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(pending.size).toBe(4);
    });

    pending.get("b1")!.resolve({ text: "before-1" });
    pending.get("a1")!.resolve({ text: "after-1" });
    await vi.waitFor(() => {
      expect(loaded).toEqual(["b1:a1"]);
    });

    pending.get("b2")!.resolve({ text: "before-2" });
    pending.get("a2")!.resolve({ text: "after-2" });
    await done;

    expect(loaded).toEqual(["b1:a1", "b2:a2"]);
  });

  it("calls onError with blobKey when a blob fetch fails", async () => {
    vi.mocked(getBlobContent).mockImplementation((_repo, blobId) => {
      if (blobId === "bad") return Promise.reject(new Error("fail"));
      return Promise.resolve({ text: `content-of-${blobId}` });
    });

    const callbacks = streamCallbacks();
    const diffs: Difference[] = [
      { beforeBlob: { blobId: "b1" }, afterBlob: { blobId: "a1" } },
      { beforeBlob: { blobId: "bad" }, afterBlob: { blobId: "a2" } },
    ];

    await streamBlobTexts(mockClient, "my-repo", diffs, callbacks);

    expect(callbacks.onLoaded).toHaveBeenCalledTimes(1);
    expect(callbacks.onLoaded).toHaveBeenCalledWith("b1:a1", {
      before: "content-of-b1",
      after: "content-of-a1",
    });
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).toHaveBeenCalledWith(blobKey(diffs[1]!));
  });

  it("skips onLoaded and onError when isStale is true", async () => {
    vi.mocked(getBlobContent).mockImplementation((_repo, blobId) => {
      if (blobId === "bad") return Promise.reject(new Error("fail"));
      return Promise.resolve({ text: `content-of-${blobId}` });
    });

    const callbacks = streamCallbacks({ isStale: () => true });
    const diffs: Difference[] = [
      { beforeBlob: { blobId: "b1" }, afterBlob: { blobId: "a1" } },
      { beforeBlob: { blobId: "bad" }, afterBlob: { blobId: "a2" } },
    ];

    await streamBlobTexts(mockClient, "my-repo", diffs, callbacks);

    expect(callbacks.onLoaded).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("resolves immediately for empty diffs", async () => {
    const callbacks = streamCallbacks();

    await streamBlobTexts(mockClient, "my-repo", [], callbacks);

    expect(callbacks.onLoaded).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(getBlobContent).not.toHaveBeenCalled();
  });

  it("loads missing before/after blobs as empty strings without fetching them", async () => {
    vi.mocked(getBlobContent).mockImplementation((_repo, blobId) =>
      Promise.resolve({ text: `content-of-${blobId}` }),
    );

    const callbacks = streamCallbacks();
    const diffs: Difference[] = [
      { afterBlob: { blobId: "a1" } },
      { beforeBlob: { blobId: "b1" } },
      {},
    ];

    await streamBlobTexts(mockClient, "my-repo", diffs, callbacks);

    expect(callbacks.onLoaded).toHaveBeenCalledWith(":a1", {
      before: "",
      after: "content-of-a1",
    });
    expect(callbacks.onLoaded).toHaveBeenCalledWith("b1:", {
      before: "content-of-b1",
      after: "",
    });
    expect(callbacks.onLoaded).toHaveBeenCalledWith(":", { before: "", after: "" });
    expect(vi.mocked(getBlobContent).mock.calls.map((call) => call[1])).toEqual(["a1", "b1"]);
  });

  it("uses blobKey format for callback keys", async () => {
    vi.mocked(getBlobContent).mockResolvedValue({ text: "text" });

    const callbacks = streamCallbacks();
    const diff: Difference = { beforeBlob: { blobId: "before" }, afterBlob: { blobId: "after" } };

    await streamBlobTexts(mockClient, "my-repo", [diff], callbacks);

    expect(callbacks.onLoaded).toHaveBeenCalledWith(blobKey(diff), {
      before: "text",
      after: "text",
    });
  });
});

const shown = (note: string) => ({ before: "", after: "", note });

describe("binary files", () => {
  const blobs: Record<string, BlobContent> = {
    png1: { binarySize: 1200 },
    png2: { binarySize: 1350 },
    txt: { text: "hello\n" },
  };
  async function textsOf(diff: Difference) {
    vi.mocked(getBlobContent).mockImplementation(async (_repo, blobId) => blobs[blobId]!);
    return (await fetchBlobTexts(mockClient, "my-repo", [diff])).get(blobKey(diff));
  }

  it("shows the size of an added or deleted binary file instead of a diff", async () => {
    expect(await textsOf({ afterBlob: { blobId: "png1" } })).toEqual(
      shown("(binary file, 1200 bytes)"),
    );
    expect(await textsOf({ beforeBlob: { blobId: "png1" } })).toEqual(
      shown("(binary file, 1200 bytes)"),
    );
  });

  it("shows both sizes of a modified binary file", async () => {
    expect(
      await textsOf({ beforeBlob: { blobId: "png1" }, afterBlob: { blobId: "png2" } }),
    ).toEqual(shown("(binary file, 1200 → 1350 bytes)"));
  });

  it("shows a file that became binary, or stopped being, without diffing its text side", async () => {
    expect(await textsOf({ beforeBlob: { blobId: "txt" }, afterBlob: { blobId: "png1" } })).toEqual(
      shown("(binary file, text → 1200 bytes)"),
    );
    expect(await textsOf({ beforeBlob: { blobId: "png2" }, afterBlob: { blobId: "txt" } })).toEqual(
      shown("(binary file, 1350 bytes → text)"),
    );
  });
});

describe("line endings", () => {
  const blobs: Record<string, BlobContent> = {
    crlf: { text: "a\nb\n", lineEndings: "CRLF" },
    lf: { text: "a\nb\n", lineEndings: "LF" },
    mixed1: { text: "a\nb\n", lineEndings: "mixed" },
    mixed2: { text: "a\nb\n", lineEndings: "mixed" },
    edited: { text: "a\nc\n", lineEndings: "LF" },
    oneLine: { text: "a" },
  };
  async function textsOf(before: string | undefined, after: string | undefined) {
    vi.mocked(getBlobContent).mockImplementation(async (_repo, blobId) => blobs[blobId]!);
    const diff: Difference = {
      ...(before ? { beforeBlob: { blobId: before } } : {}),
      ...(after ? { afterBlob: { blobId: after } } : {}),
    };
    return (await fetchBlobTexts(mockClient, "my-repo", [diff])).get(blobKey(diff));
  }

  it("says the line endings changed when that is all that changed", async () => {
    expect(await textsOf("crlf", "lf")).toEqual({
      before: "a\nb\n",
      after: "a\nb\n",
      note: "(line endings changed: CRLF → LF)",
    });
    expect((await textsOf("lf", "crlf"))?.note).toBe("(line endings changed: LF → CRLF)");
    expect((await textsOf("mixed1", "lf"))?.note).toBe("(line endings changed: mixed → LF)");
    // Both mixed, but the blobs differ while their texts read the same.
    expect((await textsOf("mixed1", "mixed2"))?.note).toBe("(line endings changed)");
  });

  it("says so above the diff when the lines changed as well", async () => {
    expect(await textsOf("crlf", "edited")).toEqual({
      before: "a\nb\n",
      after: "a\nc\n",
      note: "(line endings changed: CRLF → LF)",
    });
  });

  it("says nothing for an added or deleted file, a file with no line break, or the same blob", async () => {
    expect((await textsOf(undefined, "crlf"))?.note).toBeUndefined();
    expect((await textsOf("crlf", undefined))?.note).toBeUndefined();
    expect((await textsOf("oneLine", "crlf"))?.note).toBeUndefined();
    // A mode change keeps the blob.
    expect((await textsOf("mixed1", "mixed1"))?.note).toBeUndefined();
    expect((await textsOf("lf", "edited"))?.note).toBeUndefined();
  });
});
