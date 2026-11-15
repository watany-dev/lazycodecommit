import { describe, expect, it, vi } from "vitest";
import type { ReviewApi } from "../aws/review.js";
import { GitError } from "../git/git.js";
import { fakeGit } from "../testing/fakes.js";
import { createReviewService, openReviewService } from "./review.js";

function fakeApi() {
  return {
    listPullRequests: vi.fn(async () => ({ pullRequests: [] })),
    getPullRequestDetail: vi.fn(async () => ({
      pullRequest: {},
      differences: [],
      commentThreads: [],
    })),
    getComments: vi.fn(async () => []),
    getAllDifferences: vi.fn(async () => [{ changeType: "M", afterBlob: { blobId: "api" } }]),
    getBlobContent: vi.fn(async () => "from api"),
    getCommitsForPR: vi.fn(async () => [{ commitId: "api", message: "m", authorName: "n" }]),
    getPullRequestActivity: vi.fn(async () => ({ events: [] })),
  } as unknown as { [K in keyof ReviewApi]: ReturnType<typeof vi.fn> & ReviewApi[K] };
}

let api = fakeApi();
const target = {
  sourceReference: "refs/heads/topic",
  destinationReference: "refs/heads/main",
  sourceCommit: "src",
  destinationCommit: "dst",
};

describe("createReviewService without a clone", () => {
  it("passes calls through to the API", async () => {
    api = fakeApi();
    await createReviewService(api).getPullRequestDetail("1", "demo");
    expect(api.getPullRequestDetail).toHaveBeenCalledWith("1", "demo");
  });
});

describe("openReviewService", () => {
  it("creates a client from the options", () => {
    expect(openReviewService({ region: "us-west-2" }).getBlobContent).toBeTypeOf("function");
    expect(openReviewService({}, fakeGit()).getBlobContent).toBeTypeOf("function");
  });
});

async function loader(git: Parameters<typeof createReviewService>[1]) {
  api = fakeApi();
  await createReviewService(api, git).getPullRequestDetail("1", "demo");
  const call = api.getPullRequestDetail.mock.calls[0] as unknown[] | undefined;
  return call?.[2] as (t: typeof target & { mergeBase?: string }) => Promise<unknown>;
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
    expect(api.getAllDifferences).toHaveBeenCalledWith("demo", "dst", "src");
  });

  it("falls back to the API diff from the same merge base git would have used", async () => {
    const load = await loader(fakeGit({ resolveCommit: async () => null, fetch: fail }));
    await load({ ...target, mergeBase: "mb" });
    expect(api.getAllDifferences).toHaveBeenCalledWith("demo", "mb", "src");
  });

  it("reads blobs, commit diffs and commits from git, falling back to the API", async () => {
    const ok = createReviewService(
      fakeApi(),
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
      fakeApi(),
      fakeGit({ blob: fail, diffTree: fail, firstParentLog: fail }),
    );
    expect(await broken.getBlobContent("demo", "b")).toBe("from api");
    expect(await broken.getAllDifferences("demo", "p", "c")).toEqual([
      { changeType: "M", afterBlob: { blobId: "api" } },
    ]);
    expect(await broken.getCommitsForPR("demo", "src", "mb")).toMatchObject([{ commitId: "api" }]);
  });
});

describe("text written by other people", () => {
  // An escape sequence that would clear the screen and write the clipboard (OSC 52).
  const EVIL = "a\x1b]52;c;aGk=\x07\x1b[2Jb";
  const SHOWN = "a^[]52;c;aGk=^G^[[2Jb";

  it("reaches the review screen with control characters made visible", async () => {
    api = fakeApi();
    const service = createReviewService(api, fakeGit());
    const comment = { commentId: "c", content: `${EVIL}\r\nline 2\ttab` };
    vi.mocked(api.listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "1",
          title: EVIL,
          authorArn: "a",
          creationDate: new Date(0),
          status: "OPEN",
        },
      ],
    });
    vi.mocked(api.getPullRequestDetail).mockResolvedValueOnce({
      pullRequest: { pullRequestId: "1", title: EVIL, description: EVIL },
      differences: [{ afterBlob: { blobId: "b", path: "p" } }],
      commentThreads: [{ location: null, comments: [comment] }],
    });
    // A deleted comment has no content.
    vi.mocked(api.getComments).mockResolvedValueOnce([
      { location: null, comments: [comment, { commentId: "d", deleted: true }] },
    ]);
    vi.mocked(api.getPullRequestActivity).mockResolvedValueOnce({
      events: [{ eventDate: new Date(0), eventType: "X", actorArn: "a", description: EVIL }],
    });

    expect((await service.listPullRequests("demo")).pullRequests[0]?.title).toBe(SHOWN);
    const detail = await service.getPullRequestDetail("1", "demo");
    expect(detail.pullRequest).toMatchObject({ title: SHOWN, description: SHOWN });
    expect(detail.commentThreads[0]?.comments[0]?.content).toBe(`${SHOWN}\nline 2\ttab`);
    expect(detail.differences).toEqual([{ afterBlob: { blobId: "b", path: "p" } }]);
    expect((await service.getComments("1"))[0]?.comments).toEqual([
      { commentId: "c", content: `${SHOWN}\nline 2\ttab` },
      { commentId: "d", deleted: true },
    ]);
    expect(
      (await service.getPullRequestActivity({ pullRequestId: "1" })).events[0]?.description,
    ).toBe(SHOWN);
  });

  it("covers blobs and commits from git as well as from the API", async () => {
    const git = fakeGit({
      blob: async () => Buffer.from(`${EVIL}\r\nx`),
      firstParentLog: async () => [
        { id: "c1", parents: [], author: EVIL, date: new Date(0), subject: EVIL },
      ],
    });
    const local = createReviewService(fakeApi(), git);
    expect(await local.getBlobContent("demo", "b")).toBe(`${SHOWN}\nx`);
    expect(await local.getCommitsForPR("demo", "s", "m")).toMatchObject([
      { message: SHOWN, authorName: SHOWN },
    ]);
    api = fakeApi();
    vi.mocked(api.getBlobContent).mockResolvedValueOnce(EVIL);
    expect(await createReviewService(api).getBlobContent("demo", "b")).toBe(SHOWN);
  });
});
