import { describe, expect, it, vi } from "vitest";
import * as aws from "../aws/review.js";
import { GitError } from "../git/git.js";
import { fakeGit } from "../testing/fakes.js";
import { createReviewService, openReviewService } from "./review.js";

vi.mock("../aws/review.js", async (importOriginal) => {
  const real = await importOriginal<typeof aws>();
  const spied = Object.fromEntries(
    Object.entries(real).map(([k, v]) => [k, typeof v === "function" ? vi.fn(v) : v]),
  );
  return {
    ...spied,
    getPullRequestDetail: vi.fn(),
    getAllDifferences: vi.fn(async () => [{ changeType: "M", afterBlob: { blobId: "api" } }]),
    getBlobContent: vi.fn(async () => "from api"),
    getCommitsForPR: vi.fn(async () => [{ commitId: "api" }]),
    postComment: vi.fn(async () => ({ commentId: "c1" })),
  };
});

const client = { send: vi.fn() } as any;
const target = {
  sourceReference: "refs/heads/topic",
  destinationReference: "refs/heads/main",
  sourceCommit: "src",
  destinationCommit: "dst",
};

describe("createReviewService without a clone", () => {
  it("binds every operation to the client", async () => {
    const service = createReviewService(client);
    const spies: Record<string, { mock: { lastCall?: unknown[] } }> = { ...aws } as never;
    for (const [name, fn] of Object.entries(service)) {
      await Promise.resolve((fn as () => unknown)()).catch(() => {});
      expect(spies[name]?.mock.lastCall?.[0]).toBe(client);
    }
  });

  it("passes the client to every call", async () => {
    const service = createReviewService(client);
    await service.postComment({
      pullRequestId: "1",
      repositoryName: "demo",
      beforeCommitId: "a",
      afterCommitId: "b",
      content: "hi",
    });
    expect(aws.postComment).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ content: "hi" }),
    );
    await service.getPullRequestDetail("1", "demo");
    expect(aws.getPullRequestDetail).toHaveBeenCalledWith(client, "1", "demo");
  });
});

describe("openReviewService", () => {
  it("creates a client from the options", () => {
    expect(openReviewService({ region: "us-west-2" }).getBlobContent).toBeTypeOf("function");
    expect(openReviewService({}, fakeGit()).getBlobContent).toBeTypeOf("function");
  });
});

async function loader(git: Parameters<typeof createReviewService>[1]) {
  vi.mocked(aws.getPullRequestDetail).mockClear();
  await createReviewService(client, git).getPullRequestDetail("1", "demo");
  const call = vi.mocked(aws.getPullRequestDetail).mock.calls[0];
  return call?.[3] as (t: typeof target & { mergeBase?: string }) => Promise<unknown>;
}

const fail = async () => {
  throw new GitError([], "missing", 128);
};

describe("createReviewService in a clone", () => {
  it("diffs the merge base against the source with git", async () => {
    const diffTree = vi.fn(async () => [
      { status: "M", path: "a.ts", before: "b1", after: "b2" },
      { status: "A", path: "new.ts", after: "b3" },
      { status: "D", path: "old.ts", before: "b4" },
    ]);
    const fetch = vi.fn(async () => {});
    const load = await loader(fakeGit({ diffTree, fetch }));
    expect(await load({ ...target, mergeBase: "mb" })).toEqual([
      {
        changeType: "M",
        beforeBlob: { blobId: "b1", path: "a.ts" },
        afterBlob: { blobId: "b2", path: "a.ts" },
      },
      { changeType: "A", afterBlob: { blobId: "b3", path: "new.ts" } },
      { changeType: "D", beforeBlob: { blobId: "b4", path: "old.ts" } },
    ]);
    expect(diffTree).toHaveBeenCalledWith("mb", "src");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches missing commits quietly and computes the merge base", async () => {
    const fetch = vi.fn(async (_refspecs: readonly string[], _opts?: { quiet: boolean }) => {});
    const diffTree = vi.fn(async () => []);
    let fetched = false;
    const git = fakeGit({
      resolveCommit: async () => (fetched ? "x" : null),
      fetch: async (refspecs, opts) => {
        fetched = true;
        await fetch(refspecs, opts);
      },
      mergeBase: async () => "computed",
      diffTree,
    });
    const load = await loader(git);
    await load(target);
    expect(fetch).toHaveBeenCalledWith(
      ["+refs/heads/topic:refs/remotes/origin/topic", "+refs/heads/main:refs/remotes/origin/main"],
      { quiet: true },
    );
    expect(diffTree).toHaveBeenCalledWith("computed", "src");
  });

  it("uses the destination when there is no merge base", async () => {
    const diffTree = vi.fn(async () => []);
    const load = await loader(fakeGit({ mergeBase: async () => null, diffTree }));
    await load(target);
    expect(diffTree).toHaveBeenCalledWith("dst", "src");
  });

  it("falls back to the API when the commits cannot be fetched", async () => {
    const git = fakeGit({
      resolveCommit: async () => null,
      fetch: async () => {
        throw new GitError(["fetch"], "denied", 128);
      },
    });
    const load = await loader(git);
    expect(await load(target)).toEqual([{ changeType: "M", afterBlob: { blobId: "api" } }]);
    expect(aws.getAllDifferences).toHaveBeenCalledWith(client, "demo", "dst", "src");
  });

  it("reads blobs, commit diffs and commits from git, falling back to the API", async () => {
    const ok = createReviewService(
      client,
      fakeGit({
        blob: async () => Buffer.from("from git"),
        diffTree: async () => [{ status: "M", path: "a", before: "1", after: "2" }],
        firstParentLog: async () => [
          {
            id: "0123456789abc",
            parents: ["p"],
            author: "alice",
            date: new Date(0),
            subject: "Do it",
          },
        ],
      }),
    );
    expect(await ok.getBlobContent("demo", "b")).toBe("from git");
    expect(await ok.getAllDifferences("demo", "p", "c")).toHaveLength(1);
    expect(await ok.getCommitsForPR("demo", "src", "mb")).toEqual([
      {
        commitId: "0123456789abc",
        shortId: "0123456",
        message: "Do it",
        authorName: "alice",
        authorDate: new Date(0),
        parentIds: ["p"],
      },
    ]);

    const broken = createReviewService(
      client,
      fakeGit({ blob: fail, diffTree: fail, firstParentLog: fail }),
    );
    expect(await broken.getBlobContent("demo", "b")).toBe("from api");
    expect(await broken.getAllDifferences("demo", "p", "c")).toEqual([
      { changeType: "M", afterBlob: { blobId: "api" } },
    ]);
    expect(await broken.getCommitsForPR("demo", "src", "mb")).toEqual([{ commitId: "api" }]);
  });
});
