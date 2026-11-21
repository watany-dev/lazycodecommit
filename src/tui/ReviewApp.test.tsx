import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { press, render, settle } from "../testing/keys.js";

const exit = vi.fn();
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  useApp: () => ({ exit }),
}));

import type { ReviewService } from "../core/review.js";
import { App } from "./ReviewApp.js";

const service = {
  closePullRequest: vi.fn(),
  deleteComment: vi.fn(),
  evaluateApprovalRules: vi.fn(),
  getAllDifferences: vi.fn(),
  getApprovalStates: vi.fn(),
  getBlobContent: vi.fn(),
  getComments: vi.fn(),
  getCommitsForPR: vi.fn(),
  getMergeConflicts: vi.fn(),
  getPullRequestActivity: vi.fn(),
  getPullRequestDetail: vi.fn(),
  getReactionsForComments: vi.fn(),
  listPullRequests: vi.fn(),
  mergePullRequest: vi.fn(),
  postComment: vi.fn(),
  postCommentReply: vi.fn(),
  putReaction: vi.fn(),
  updateApprovalState: vi.fn(),
  updateComment: vi.fn(),
};
const svc = service as unknown as ReviewService;
const {
  closePullRequest,
  deleteComment,
  evaluateApprovalRules,
  getAllDifferences,
  getApprovalStates,
  getBlobContent,
  getComments,
  getCommitsForPR,
  getMergeConflicts,
  getPullRequestActivity,
  getPullRequestDetail,
  getReactionsForComments,
  listPullRequests,
  mergePullRequest,
  postComment,
  postCommentReply,
  putReaction,
  updateApprovalState,
  updateComment,
} = service;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("App", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no reactions
    vi.mocked(getReactionsForComments).mockResolvedValue(new Map());
    vi.mocked(putReaction).mockResolvedValue(undefined);
    // Default: empty activity
    vi.mocked(getPullRequestActivity).mockResolvedValue({ events: [], nextToken: undefined });
    // Default: no commits
    vi.mocked(getCommitsForPR).mockResolvedValue([]);
    vi.mocked(getAllDifferences).mockResolvedValue([]);
    // Default: no approvals, no rules
    vi.mocked(getApprovalStates).mockResolvedValue([]);
    vi.mocked(evaluateApprovalRules).mockResolvedValue(null);
    // Default: no conflicts
    vi.mocked(getMergeConflicts).mockResolvedValue({
      mergeable: true,
      conflictCount: 0,
      conflictFiles: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    vi.mocked(listPullRequests).mockReturnValue(new Promise(() => {}));
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    expect(lastFrame()).toContain("Loading");
  });

  it("loads PRs when initialRepo is provided", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
  });

  // formatError tests for all error types
  it("shows auth error for CredentialsProviderError", async () => {
    const error = new Error("bad");
    error.name = "CredentialsProviderError";
    vi.mocked(listPullRequests).mockRejectedValue(error);
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("AWS credentials are missing or expired");
    });
  });

  it("shows repo not found error", async () => {
    const error = new Error("not found");
    error.name = "RepositoryDoesNotExistException";
    vi.mocked(listPullRequests).mockRejectedValue(error);
    const { lastFrame } = render(<App service={svc} repository="missing" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Repository not found");
    });
  });

  it("shows access denied error", async () => {
    const error = new Error("no");
    error.name = "AccessDeniedException";
    vi.mocked(listPullRequests).mockRejectedValue(error);
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Access denied");
    });
  });

  it("shows network error for a timeout", async () => {
    const error = new Error("network fail");
    error.name = "TimeoutError";
    vi.mocked(listPullRequests).mockRejectedValue(error);
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Network error");
    });
  });

  it("shows network error for ECONNREFUSED", async () => {
    vi.mocked(listPullRequests).mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:443"));
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Network error");
    });
  });

  it("shows network error for ETIMEDOUT", async () => {
    vi.mocked(listPullRequests).mockRejectedValue(new Error("connect ETIMEDOUT"));
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Network error");
    });
  });

  it("shows generic error message", async () => {
    vi.mocked(listPullRequests).mockRejectedValue(new Error("something went wrong"));
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("something went wrong");
    });
  });

  it("shows generic message for non-Error values", async () => {
    vi.mocked(listPullRequests).mockRejectedValue("raw string error");
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("An unexpected error occurred");
    });
  });

  it("sanitizes ARN from error message", async () => {
    vi.mocked(listPullRequests).mockRejectedValue(
      new Error("Resource arn:aws:codecommit:us-east-1:123456789012:my-repo not available"),
    );
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("[ARN]");
      expect(frame).not.toContain("arn:aws:");
      expect(frame).not.toContain("123456789012");
    });
  });

  it("sanitizes access key ID from error message", async () => {
    vi.mocked(listPullRequests).mockRejectedValue(
      new Error("Invalid credentials for AKIAIOSFODNN7EXAMPLE"),
    );
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("[ACCESS_KEY]");
      expect(frame).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });
  });

  // Screen navigation tests
  it("navigates from PRs to detail on selection", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r"); // Enter to select PR
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
  });

  it("navigates back from detail to PRs", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("\u001B");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Open Pull Requests");
    });
  });

  it("exits when going back from the PR list", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [],
    });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("No open pull requests");
    });

    stdin.write("q");
    expect(exit).toHaveBeenCalled();
  });

  it("stays on the PR list on Esc when it is the top screen", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({ pullRequests: [] });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("No open pull requests"));
    stdin.write("\u001B");
    await settle();
    expect(lastFrame()).toContain("No open pull requests");
    expect(exit).not.toHaveBeenCalled();
  });

  it("shows help screen and returns", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({ pullRequests: [] });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("my-service");
    });

    stdin.write("?");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Pull requests help");
    });

    // Close help by pressing ? again
    stdin.write("?");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("my-service");
    });
  });

  it("loads PR detail with blob content", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [
        {
          beforeBlob: { blobId: "b1", path: "src/auth.ts" },
          afterBlob: { blobId: "b2", path: "src/auth.ts" },
        },
      ],
      commentThreads: [],
    });
    vi.mocked(getBlobContent)
      .mockResolvedValueOnce({ text: "const timeout = 3000;" })
      .mockResolvedValueOnce({ text: "const timeout = 10000;" });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    await vi.waitFor(() => {
      expect(getBlobContent).toHaveBeenCalledWith("my-service", "b1");
      expect(getBlobContent).toHaveBeenCalledWith("my-service", "b2");
    });
  });

  it("loads PR detail with only afterBlob", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "feat: new file",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "feat: new file",
        pullRequestTargets: [],
      },
      differences: [
        {
          beforeBlob: undefined,
          afterBlob: { blobId: "b2", path: "src/new.ts" },
        },
      ],
      commentThreads: [],
    });
    vi.mocked(getBlobContent).mockResolvedValueOnce({ text: "const x = 1;" });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("feat: new file");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    await vi.waitFor(() => {
      expect(getBlobContent).toHaveBeenCalledWith("my-service", "b2");
    });
  });

  it("shows a binary file as its size, and takes no inline comment on it", async () => {
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: { pullRequestId: "42", title: "feat: logo", pullRequestTargets: [] },
      differences: [
        {
          beforeBlob: { blobId: "b1", path: "logo.png" },
          afterBlob: { blobId: "b2", path: "logo.png" },
        },
      ],
      commentThreads: [],
    });
    vi.mocked(getBlobContent)
      .mockResolvedValueOnce({ binarySize: 1200 })
      .mockResolvedValueOnce({ binarySize: 1350 });

    const { lastFrame, stdin } = render(
      <App service={svc} repository="my-service" start={{ pullRequestId: "42" }} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(binary file, 1200 bytes → 1350 bytes)");
    });
    await press(stdin, "j", "j");
    expect(lastFrame()).toMatch(/> .*\(binary file, 1200 bytes → 1350 bytes\)/);
    await press(stdin, "C");
    expect(lastFrame()).not.toContain("Inline comment on");
  });

  it("shows error when PR detail loading fails", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockRejectedValue(new Error("failed to load"));

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("failed to load");
    });

    expect(getBlobContent).not.toHaveBeenCalled();
  });

  it("shows error when loading PRs fails", async () => {
    vi.mocked(listPullRequests).mockRejectedValue(new Error("load failed"));
    const { lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("load failed");
    });
  });

  it("loads PR detail with no blobs (deleted file)", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "chore: remove old",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "chore: remove old",
        pullRequestTargets: [],
      },
      differences: [
        {
          beforeBlob: { blobId: "b1", path: "src/old.ts" },
          afterBlob: undefined,
        },
      ],
      commentThreads: [],
    });
    vi.mocked(getBlobContent).mockResolvedValueOnce({ text: "old content" });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("chore: remove old");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    await vi.waitFor(() => {
      expect(getBlobContent).toHaveBeenCalledWith("my-service", "b1");
    });
  });

  it("shows blob error state when blob fetch fails", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [
        {
          beforeBlob: { blobId: "b1", path: "src/auth.ts" },
          afterBlob: { blobId: "b2", path: "src/auth.ts" },
        },
      ],
      commentThreads: [],
    });
    vi.mocked(getBlobContent)
      .mockResolvedValueOnce({ text: "const timeout = 3000;" })
      .mockRejectedValueOnce(new Error("blob failed"));

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Failed to load file content)");
    });
  });

  it("shows help from PR list screen", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("?");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Pull requests help");
    });
  });

  it("shows help from PR detail screen", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("?");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Moving around");
    });

    expect(getBlobContent).not.toHaveBeenCalled();

    // Enter presses the selected key on the review screen: here "A", the activity timeline.
    await press(stdin, "/", "a", "c", "t", "i", "v", "\r", "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("Activity: fix: login"));
  });

  it("posts comment successfully and reloads comments", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(postComment).mockResolvedValue({
      commentId: "c1",
      content: "Looks good!",
      authorArn: "arn:aws:iam::123456789012:user/watany",
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    // Enter comment mode and submit
    stdin.write("c");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("New Comment:");
    });

    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "c1",
              content: "Looks good!",
              authorArn: "arn:aws:iam::123456789012:user/watany",
            },
          ],
        },
      ],
    });

    stdin.write("Looks good!");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(postComment).toHaveBeenCalled();
    });
  });

  it("shows error when comment post fails", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });

    const accessError = new Error("denied");
    accessError.name = "AccessDeniedException";
    vi.mocked(postComment).mockRejectedValue(accessError);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("c");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("New Comment:");
    });

    stdin.write("test comment");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("Failed to post comment:");
      expect(lastFrame()).toContain("Access denied");
    });
  });

  it("shows comment error for CommentContentRequiredException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("empty");
    err.name = "CommentContentRequiredException";
    vi.mocked(postComment).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("c");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("New Comment:");
    });
    stdin.write("x");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("Comment cannot be empty.");
    });
  });

  it("shows comment error for CommentContentSizeLimitExceededException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("too long");
    err.name = "CommentContentSizeLimitExceededException";
    vi.mocked(postComment).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("c");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("New Comment:");
    });
    stdin.write("x");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("The comment is over CodeCommit's 10,240 character limit.");
    });
  });

  it("shows comment error for PullRequestDoesNotExistException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("gone");
    err.name = "PullRequestDoesNotExistException";
    vi.mocked(postComment).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("c");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("New Comment:");
    });
    stdin.write("x");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("Pull request not found.");
    });
  });

  it("shows generic comment error message", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(postComment).mockRejectedValue(new Error("something broke"));

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("c");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("New Comment:");
    });
    stdin.write("x");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("something broke");
    });
  });

  it("shows non-Error comment error as string", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(postComment).mockRejectedValue("raw error string");

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("c");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("New Comment:");
    });
    stdin.write("x");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("raw error string");
    });
  });

  it("does not call postComment when pullRequestTargets is empty", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("c");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("New Comment:");
    });

    stdin.write("test");
    await vi.waitFor(() => {
      stdin.write("\r");
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(postComment).not.toHaveBeenCalled();
  });

  // v0.3: Approval integration tests
  it("loads approval states when opening PR detail", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(getApprovalStates).mockResolvedValue([
      { userArn: "arn:aws:iam::123456789012:user/taro", approvalState: "APPROVE" },
    ]);
    vi.mocked(evaluateApprovalRules).mockResolvedValue({
      approved: true,
      overridden: false,
      approvalRulesSatisfied: ["RequireOne"],
      approvalRulesNotSatisfied: [],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
      expect(lastFrame()).toContain("taro");
      expect(lastFrame()).toContain("Approved");
    });
  });

  it("ignores stale approval and reaction loads from a previous PR detail", async () => {
    const approvalDeferred = createDeferred<any[]>();
    const reactionDeferred = createDeferred<any>();

    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "first pr",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail)
      .mockResolvedValueOnce({
        pullRequest: {
          pullRequestId: "42",
          title: "first pr",
          revisionId: "rev-1",
          pullRequestTargets: [],
        },
        differences: [],
        commentThreads: [
          {
            location: null,
            comments: [
              {
                commentId: "shared-comment",
                authorArn: "arn:aws:iam::123456789012:user/taro",
                content: "stale comment",
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        pullRequest: {
          pullRequestId: "43",
          title: "second pr",
          revisionId: "rev-2",
          pullRequestTargets: [],
        },
        differences: [],
        commentThreads: [
          {
            location: null,
            comments: [
              {
                commentId: "shared-comment",
                authorArn: "arn:aws:iam::123456789012:user/hanako",
                content: "current comment",
              },
            ],
          },
        ],
      });
    vi.mocked(getApprovalStates)
      .mockImplementationOnce(() => approvalDeferred.promise as Promise<any[]>)
      .mockResolvedValueOnce([]);
    vi.mocked(evaluateApprovalRules).mockResolvedValue(null);
    vi.mocked(getReactionsForComments)
      .mockImplementationOnce(() => reactionDeferred.promise as Promise<any>)
      .mockResolvedValueOnce(new Map());

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("first pr");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("\u001B");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("first pr");
    });

    // The list is drawn, but its key handler may still be a render behind (Esc
    // lands a tick later than q did): give useInput time to take it.
    await settle();
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "43",
          title: "second pr",
          authorArn: "arn:aws:iam::123456789012:user/hanako",
          creationDate: new Date("2026-02-14T10:00:00Z"),
          status: "CLOSED" as const,
        },
      ],
    });
    stdin.write("f");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("second pr");
      expect(lastFrame()).toContain("[Closed]");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #43");
      expect(lastFrame()).toContain("current comment");
      expect(lastFrame()).not.toContain("taro");
      expect(lastFrame()).not.toContain("👍×1");
    });

    approvalDeferred.resolve([
      { userArn: "arn:aws:iam::123456789012:user/taro", approvalState: "APPROVE" },
    ]);
    reactionDeferred.resolve(
      new Map([
        ["shared-comment", [{ emoji: "👍", shortCode: ":thumbsup:", count: 1, userArns: [] }]],
      ]),
    );

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #43");
      expect(lastFrame()).toContain("current comment");
      expect(lastFrame()).not.toContain("taro");
      expect(lastFrame()).not.toContain("👍×1");
    });
  });

  it("approves PR successfully and reloads approval states", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(updateApprovalState).mockResolvedValue(undefined);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });

    vi.mocked(getApprovalStates).mockResolvedValue([
      { userArn: "arn:aws:iam::123456789012:user/watany", approvalState: "APPROVE" },
    ]);

    // Confirm with 'y'
    stdin.write("y");
    await vi.waitFor(() => {
      expect(updateApprovalState).toHaveBeenCalledWith(
        expect.objectContaining({ approvalState: "APPROVE" }),
      );
    });
  });

  it("revokes approval successfully", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(updateApprovalState).mockResolvedValue(undefined);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Revoke your approval?");
    });

    stdin.write("y");
    await vi.waitFor(() => {
      expect(updateApprovalState).toHaveBeenCalledWith(
        expect.objectContaining({ approvalState: "REVOKE" }),
      );
    });
  });

  it("shows approval error on failure", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const accessError = new Error("denied");
    accessError.name = "AccessDeniedException";
    vi.mocked(updateApprovalState).mockRejectedValue(accessError);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });

    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Access denied. Check your IAM policy.");
    });
  });

  it("does not call updateApprovalState when revisionId is missing", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: undefined,
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });

    stdin.write("y");
    await new Promise((r) => setTimeout(r, 0));
    expect(updateApprovalState).not.toHaveBeenCalled();
  });

  it("handles evaluateApprovalRules failure gracefully", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(evaluateApprovalRules).mockRejectedValue(new Error("no rules configured"));

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
      expect(lastFrame()).not.toContain("Rules:");
    });
  });

  // formatApprovalError edge cases
  it("shows PullRequestCannotBeApprovedByAuthorException error", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("cannot approve own");
    err.name = "PullRequestCannotBeApprovedByAuthorException";
    vi.mocked(updateApprovalState).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Cannot approve your own pull request.");
    });
  });

  it("shows PullRequestCannotBeApprovedByAuthorException error on revoke", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("cannot approve own");
    err.name = "PullRequestCannotBeApprovedByAuthorException";
    vi.mocked(updateApprovalState).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Revoke your approval?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Cannot revoke approval on your own pull request.");
    });
  });

  it("shows InvalidRevisionIdException error", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("invalid");
    err.name = "InvalidRevisionIdException";
    vi.mocked(updateApprovalState).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Invalid revision. The PR may have been updated.");
    });
  });

  it("shows PullRequestAlreadyClosedException error", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("closed");
    err.name = "PullRequestAlreadyClosedException";
    vi.mocked(updateApprovalState).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("The pull request is already closed.");
    });
  });

  it("shows EncryptionKeyAccessDeniedException error", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("key denied");
    err.name = "EncryptionKeyAccessDeniedException";
    vi.mocked(updateApprovalState).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Encryption key access denied.");
    });
  });

  it("shows generic approval error message", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(updateApprovalState).mockRejectedValue(new Error("unknown error occurred"));

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("unknown error occurred");
    });
  });

  it("shows PullRequestDoesNotExistException approval error", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("not found");
    err.name = "PullRequestDoesNotExistException";
    vi.mocked(updateApprovalState).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Pull request not found.");
    });
  });

  it("shows RevisionIdRequiredException approval error", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("required");
    err.name = "RevisionIdRequiredException";
    vi.mocked(updateApprovalState).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Invalid revision. The PR may have been updated.");
    });
  });

  it("clears approval error and returns to normal mode", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const accessError = new Error("denied");
    accessError.name = "AccessDeniedException";
    vi.mocked(updateApprovalState).mockRejectedValue(accessError);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Access denied. Check your IAM policy.");
    });

    stdin.write("x");
    await vi.waitFor(() => {
      expect(lastFrame()).not.toContain("Access denied");
      expect(lastFrame()).toContain("a/r approve");
    });
  });

  it("shows revoke approval error on failure", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const accessError = new Error("denied");
    accessError.name = "AccessDeniedException";
    vi.mocked(updateApprovalState).mockRejectedValue(accessError);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Revoke your approval?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Access denied. Check your IAM policy.");
    });
  });

  it("shows non-Error approval error as string", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(updateApprovalState).mockRejectedValue("raw string error");

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("a");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Approve this pull request?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("raw string error");
    });
  });

  // v0.4: Inline comment integration tests
  it("shows inline comment error on failure", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [
        {
          beforeBlob: { blobId: "b1", path: "src/auth.ts" },
          afterBlob: { blobId: "b2", path: "src/auth.ts" },
        },
      ],
      commentThreads: [],
    });
    vi.mocked(getBlobContent)
      .mockResolvedValueOnce({ text: "const timeout = 3000;" })
      .mockResolvedValueOnce({ text: "const timeout = 10000;" });
    const accessError = new Error("denied");
    accessError.name = "AccessDeniedException";
    vi.mocked(postComment).mockRejectedValue(accessError);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toMatch(/> .*const timeout = 3000/);
    });
    stdin.write("C");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Inline comment on");
    });

    stdin.write("test inline");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("Failed to post comment:");
      expect(lastFrame()).toContain("Access denied");
    });
  });

  it("posts inline comment successfully and reloads comments", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "def456",
            sourceCommit: "abc123",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [
        {
          beforeBlob: { blobId: "b1", path: "src/auth.ts" },
          afterBlob: { blobId: "b2", path: "src/auth.ts" },
        },
      ],
      commentThreads: [],
    });
    vi.mocked(getBlobContent)
      .mockResolvedValueOnce({ text: "const timeout = 3000;" })
      .mockResolvedValueOnce({ text: "const timeout = 10000;" });
    vi.mocked(postComment).mockResolvedValue({
      commentId: "c1",
      content: "Fix this!",
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toMatch(/> .*const timeout = 3000/);
    });
    stdin.write("C");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Inline comment on");
    });

    vi.mocked(getComments).mockResolvedValue([
      {
        location: {
          filePath: "src/auth.ts",
          filePosition: 1,
          relativeFileVersion: "AFTER",
        },
        comments: [
          {
            commentId: "c1",
            content: "Fix this!",
            authorArn: "arn:aws:iam::123456789012:user/watany",
          },
        ],
      },
    ]);

    stdin.write("Fix this!");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(postComment).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Fix this!",
          location: expect.objectContaining({
            filePath: "src/auth.ts",
          }),
        }),
      );
    });
    // The current source tip, so threads from before a push can be told apart.
    await vi.waitFor(() => {
      expect(getComments).toHaveBeenCalledWith("42", "abc123");
    });
  });

  // v0.5: Reply integration tests
  it("shows reply error on failure", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: undefined,
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        authorArn: "arn:aws:iam::123456789012:user/watany",
        pullRequestStatus: "OPEN",
        creationDate: new Date("2026-02-13T10:00:00Z"),
        revisionId: "rev-1",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
            destinationCommit: "abc",
            sourceCommit: "def",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "c1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "Please fix",
            },
          ],
        },
      ],
    });
    vi.mocked(getBlobContent).mockResolvedValue({ text: "" });

    const replyError = new Error("comment not found");
    replyError.name = "CommentDoesNotExistException";
    vi.mocked(postCommentReply).mockRejectedValue(replyError);

    const { stdin, lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    // Select PR
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    // Navigate to comment line (sep=0, comment-header=1, comment=2)
    stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      expect(lastFrame()).toMatch(/> .*taro: Please fix/);
    });

    stdin.write("R");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Replying to taro:");
    });

    stdin.write("my reply");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("Failed to post comment:");
      expect(lastFrame()).toContain("The comment you are replying to no longer exists.");
    });
  });

  it("posts reply successfully and reloads comments", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: undefined,
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        authorArn: "arn:aws:iam::123456789012:user/watany",
        pullRequestStatus: "OPEN",
        creationDate: new Date("2026-02-13T10:00:00Z"),
        revisionId: "rev-1",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
            destinationCommit: "abc",
            sourceCommit: "def",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "c1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "Please fix",
            },
          ],
        },
      ],
    });
    vi.mocked(getBlobContent).mockResolvedValue({ text: "" });
    vi.mocked(postCommentReply).mockResolvedValue({
      commentId: "reply-1",
      content: "Will do!",
      authorArn: "arn:aws:iam::123456789012:user/watany",
      inReplyTo: "c1",
    });

    vi.mocked(getComments).mockResolvedValue([
      {
        location: null,
        comments: [
          {
            commentId: "c1",
            authorArn: "arn:aws:iam::123456789012:user/taro",
            content: "Please fix",
          },
          {
            commentId: "reply-1",
            inReplyTo: "c1",
            authorArn: "arn:aws:iam::123456789012:user/watany",
            content: "Will do!",
          },
        ],
      },
    ]);

    const { stdin, lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      expect(lastFrame()).toMatch(/> .*taro: Please fix/);
    });

    stdin.write("R");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Replying to taro:");
    });

    stdin.write("Will do!");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(postCommentReply).toHaveBeenCalledWith(
        expect.objectContaining({
          inReplyTo: "c1",
          content: "Will do!",
        }),
      );
    });
  });

  it("shows reply size limit error", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: undefined,
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        authorArn: "arn:aws:iam::123456789012:user/watany",
        pullRequestStatus: "OPEN",
        creationDate: new Date("2026-02-13T10:00:00Z"),
        revisionId: "rev-1",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
            destinationCommit: "abc",
            sourceCommit: "def",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "c1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "Fix it",
            },
          ],
        },
      ],
    });
    vi.mocked(getBlobContent).mockResolvedValue({ text: "" });

    const sizeError = new Error("size limit");
    sizeError.name = "CommentContentSizeLimitExceededException";
    vi.mocked(postCommentReply).mockRejectedValue(sizeError);

    const { stdin, lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      expect(lastFrame()).toMatch(/> .*taro: Fix it/);
    });
    stdin.write("R");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Replying to taro:");
    });
    stdin.write("long reply");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("The comment is over CodeCommit's 10,240 character limit.");
    });
  });

  it("shows reply empty error for CommentContentRequiredException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: undefined,
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        authorArn: "arn:aws:iam::123456789012:user/watany",
        pullRequestStatus: "OPEN",
        creationDate: new Date("2026-02-13T10:00:00Z"),
        revisionId: "rev-1",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
            destinationCommit: "abc",
            sourceCommit: "def",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "c1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "Fix it",
            },
          ],
        },
      ],
    });
    vi.mocked(getBlobContent).mockResolvedValue({ text: "" });

    const emptyError = new Error("empty");
    emptyError.name = "CommentContentRequiredException";
    vi.mocked(postCommentReply).mockRejectedValue(emptyError);

    const { stdin, lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      expect(lastFrame()).toMatch(/> .*taro: Fix it/);
    });
    stdin.write("R");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Replying to taro:");
    });
    stdin.write("reply");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("Reply cannot be empty.");
    });
  });

  it("shows invalid comment ID error", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: undefined,
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        authorArn: "arn:aws:iam::123456789012:user/watany",
        pullRequestStatus: "OPEN",
        creationDate: new Date("2026-02-13T10:00:00Z"),
        revisionId: "rev-1",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
            destinationCommit: "abc",
            sourceCommit: "def",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "c1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "Fix it",
            },
          ],
        },
      ],
    });
    vi.mocked(getBlobContent).mockResolvedValue({ text: "" });

    const idError = new Error("invalid id");
    idError.name = "InvalidCommentIdException";
    vi.mocked(postCommentReply).mockRejectedValue(idError);

    const { stdin, lastFrame } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      expect(lastFrame()).toMatch(/> .*taro: Fix it/);
    });
    stdin.write("R");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Replying to taro:");
    });
    stdin.write("reply");
    await vi.waitFor(() => {
      stdin.write("\r");
      expect(lastFrame()).toContain("Invalid comment ID format.");
    });
  });

  it("starts the merge dialog on the service's preselected strategy", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const preselected = { ...svc, mergeStrategy: "squash" as const };
    const { lastFrame, stdin } = render(
      <App service={preselected} repository="my-service" start={null} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("fix: login"));
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("PR #42"));
    stdin.write("m");
    await vi.waitFor(() => expect(lastFrame()).toContain("> Squash"));
  });

  // v0.6: Merge integration tests
  it("merges PR and returns to PR list", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(mergePullRequest).mockResolvedValue({
      pullRequestId: "42",
      pullRequestStatus: "CLOSED",
    } as any);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });

    stdin.write("\r"); // select fast-forward
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });

    stdin.write("y");
    await vi.waitFor(() => {
      expect(mergePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          pullRequestId: "42",
          strategy: "fast-forward",
        }),
      );
    });
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Open Pull Requests");
    });
  });

  it("shows merge error for ManualMergeRequiredException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("conflicts");
    err.name = "ManualMergeRequiredException";
    vi.mocked(mergePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });

    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("cannot be merged automatically");
    });
  });

  it("shows merge error for PullRequestApprovalRulesNotSatisfiedException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("rules not met");
    err.name = "PullRequestApprovalRulesNotSatisfiedException";
    vi.mocked(mergePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("approval rules are not satisfied yet");
    });
  });

  it("shows merge error for TipOfSourceReferenceIsDifferentException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("branch updated");
    err.name = "TipOfSourceReferenceIsDifferentException";
    vi.mocked(mergePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("The source branch has moved since the pull request was read.");
    });
  });

  // v0.6: Close PR integration tests
  it("closes PR and returns to PR list", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(closePullRequest).mockResolvedValue({
      pullRequestId: "42",
      pullRequestStatus: "CLOSED",
    } as any);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("x");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Close this pull request without merging?");
    });

    stdin.write("y");
    await vi.waitFor(() => {
      expect(closePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ pullRequestId: "42" }),
      );
    });
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Open Pull Requests");
    });
  });

  it("drops only the closed PR from the list it returns to", async () => {
    const pr = (pullRequestId: string, title: string) => ({
      pullRequestId,
      title,
      authorArn: "arn:aws:iam::123456789012:user/watany",
      creationDate: new Date("2026-02-13T10:00:00Z"),
      status: "OPEN" as const,
    });
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [pr("42", "fix: login"), pr("43", "feat: search")],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: { pullRequestId: "42", title: "fix: login", pullRequestTargets: [] },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(closePullRequest).mockResolvedValue({} as any);
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("feat: search"));
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("PR #42"));
    stdin.write("x");
    await vi.waitFor(() => expect(lastFrame()).toContain("Close this pull request"));
    stdin.write("y");
    await vi.waitFor(() => expect(lastFrame()).toContain("Open Pull Requests"));
    expect(lastFrame()).toContain("feat: search");
    expect(lastFrame()).not.toContain("fix: login");
    expect(listPullRequests).toHaveBeenCalledTimes(1);
  });

  it("shows close error for PullRequestAlreadyClosedException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("already closed");
    err.name = "PullRequestAlreadyClosedException";
    vi.mocked(closePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("x");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Close this pull request without merging?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("The pull request is already closed.");
    });
  });

  it("shows merge error for ConcurrentReferenceUpdateException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("concurrent");
    err.name = "ConcurrentReferenceUpdateException";
    vi.mocked(mergePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("The branch was updated at the same moment.");
    });
  });

  it("shows merge error for PullRequestAlreadyClosedException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("closed");
    err.name = "PullRequestAlreadyClosedException";
    vi.mocked(mergePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("The pull request is already closed.");
    });
  });

  it("shows merge error for EncryptionKeyAccessDeniedException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("key denied");
    err.name = "EncryptionKeyAccessDeniedException";
    vi.mocked(mergePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Encryption key access denied.");
    });
  });

  it("shows merge error for TipsDivergenceExceededException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("diverged");
    err.name = "TipsDivergenceExceededException";
    vi.mocked(mergePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("The branches have diverged too far to merge here.");
    });
  });

  it("shows merge error for PullRequestDoesNotExistException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("not found");
    err.name = "PullRequestDoesNotExistException";
    vi.mocked(mergePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Pull request not found.");
    });
  });

  it("shows close error for PullRequestDoesNotExistException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("not found");
    err.name = "PullRequestDoesNotExistException";
    vi.mocked(closePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("x");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Close this pull request without merging?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Pull request not found.");
    });
  });

  it("checks conflicts against the destination branch's tip, not the commit read at open", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            sourceCommit: "src1",
            destinationCommit: "stale-dst",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(getMergeConflicts).toHaveBeenCalled();
    });
    expect(vi.mocked(getMergeConflicts).mock.calls[0]!.at(-1)).toMatchObject({
      sourceCommitId: "src1",
      destinationCommitId: "main",
    });
  });

  it("skips conflict check when PR target has no commit IDs", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(mergePullRequest).mockResolvedValue({
      pullRequestId: "42",
      pullRequestStatus: "CLOSED",
    } as any);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("m");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Select merge strategy:");
    });
    stdin.write("\r"); // select fast-forward
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("(Enter/y, Esc/n)");
    });
    // getMergeConflicts should NOT have been called since commits are missing
    expect(getMergeConflicts).not.toHaveBeenCalled();

    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Open Pull Requests");
    });
  });

  it("shows close error for AccessDeniedException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    });
    const err = new Error("denied");
    err.name = "AccessDeniedException";
    vi.mocked(closePullRequest).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    stdin.write("x");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Close this pull request without merging?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Access denied.");
    });
  });

  it("prefetches commits when opening a PR with mergeBase", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            sourceCommit: "src123",
            destinationCommit: "dest456",
            mergeBase: "base789",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(getCommitsForPR).mockResolvedValue([
      {
        commitId: "src123",
        shortId: "src1234",
        message: "Fix bug",
        authorName: "watany",
        authorDate: new Date("2026-02-13T10:00:00Z"),
        parentIds: ["base789"],
      },
    ]);
    vi.mocked(getAllDifferences).mockResolvedValue([]);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    await vi.waitFor(() => {
      expect(getCommitsForPR).toHaveBeenCalledWith("my-service", "src123", "base789");
    });
    // Tab header should show [All changes] because commitsAvailable is true
    expect(lastFrame()).toContain("[All changes]");

    // Tab reuses the prefetched commits instead of fetching again
    stdin.write("\t");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Commit 1/1]");
    });
    expect(getCommitsForPR).toHaveBeenCalledTimes(1);
  });

  it("reuses an in-flight commit prefetch when Tab is pressed early", async () => {
    const commitsDeferred =
      createDeferred<
        Array<{
          commitId: string;
          shortId: string;
          message: string;
          authorName: string;
          authorDate: Date;
          parentIds: string[];
        }>
      >();
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            sourceCommit: "src123",
            destinationCommit: "dest456",
            mergeBase: "base789",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(getCommitsForPR).mockReturnValue(commitsDeferred.promise);
    vi.mocked(getAllDifferences).mockResolvedValue([]);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    await vi.waitFor(() => {
      expect(getCommitsForPR).toHaveBeenCalledTimes(1);
    });

    stdin.write("\t");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Loading commits...");
    });
    expect(getCommitsForPR).toHaveBeenCalledTimes(1);

    stdin.write("\t");
    expect(getCommitsForPR).toHaveBeenCalledTimes(1);

    commitsDeferred.resolve([
      {
        commitId: "src123",
        shortId: "src1234",
        message: "Fix bug",
        authorName: "watany",
        authorDate: new Date("2026-02-13T10:00:00Z"),
        parentIds: ["base789"],
      },
    ]);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Commit 1/1]");
    });
    expect(getCommitsForPR).toHaveBeenCalledTimes(1);
  });

  it("keeps PR detail usable when commit prefetch fails", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            sourceCommit: "src123",
            destinationCommit: "dest456",
            mergeBase: "base789",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(getCommitsForPR).mockRejectedValue(new Error("GetCommit failed"));

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    await vi.waitFor(() => {
      expect(getCommitsForPR).toHaveBeenCalled();
    });
    expect(lastFrame()).toContain("[All changes]");
  });

  it("survives Tab after the commits failed to load and Tab returns to All changes", async () => {
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          { sourceCommit: "src123", destinationCommit: "dest456", mergeBase: "base789" },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(getCommitsForPR).mockRejectedValue(new Error("GetCommit failed"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const screen = render(
        <App service={svc} repository="my-service" start={{ pullRequestId: "42" }} />,
      );
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("[All changes]"));
      await vi.waitFor(() => expect(getCommitsForPR).toHaveBeenCalled());
      await press(screen, "\t");
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
      await press(screen, "\t");
      expect(screen.lastFrame()).toContain("[All changes]");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("does not show commits when mergeBase is missing", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            sourceCommit: "src123",
            destinationCommit: "dest456",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    expect(getCommitsForPR).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain("[All changes]");
  });

  it("loads commits and commit diff when switching to commit view via Tab", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            sourceCommit: "src123",
            destinationCommit: "dest456",
            mergeBase: "base789",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(getCommitsForPR).mockResolvedValue([
      {
        commitId: "src123",
        shortId: "src1234",
        message: "Fix bug",
        authorName: "watany",
        authorDate: new Date("2026-02-13T10:00:00Z"),
        parentIds: ["base789"],
      },
    ]);
    vi.mocked(getAllDifferences).mockResolvedValue([
      {
        beforeBlob: { blobId: "cb1", path: "src/auth.ts" },
        afterBlob: { blobId: "cb2", path: "src/auth.ts" },
      },
    ]);
    vi.mocked(getBlobContent).mockResolvedValue({ text: "content" });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    await vi.waitFor(() => {
      expect(getCommitsForPR).toHaveBeenCalledWith("my-service", "src123", "base789");
    });

    stdin.write("\t"); // switch to commit view (commits already prefetched)
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Commit 1/1]");
    });
    await vi.waitFor(() => {
      expect(getAllDifferences).toHaveBeenCalledWith("my-service", "base789", "src123");
    });
  });

  it("loads commit diff for new file (afterBlob only) and reuses cached commits", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            sourceCommit: "src123",
            destinationCommit: "dest456",
            mergeBase: "base789",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(getCommitsForPR).mockResolvedValue([
      {
        commitId: "c1",
        shortId: "c1short",
        message: "First commit",
        authorName: "watany",
        authorDate: new Date("2026-02-13T09:00:00Z"),
        parentIds: ["base789"],
      },
      {
        commitId: "c2",
        shortId: "c2short",
        message: "Second commit",
        authorName: "watany",
        authorDate: new Date("2026-02-13T10:00:00Z"),
        parentIds: ["c1"],
      },
    ]);
    // First commit: new file + deleted file (covers both missing blob branches)
    vi.mocked(getAllDifferences)
      .mockResolvedValueOnce([
        {
          afterBlob: { blobId: "newfile1", path: "src/new.ts" },
        },
        {
          beforeBlob: { blobId: "deleted1", path: "src/old.ts" },
        },
      ])
      .mockResolvedValueOnce([
        {
          beforeBlob: { blobId: "b1", path: "src/edit.ts" },
          afterBlob: { blobId: "b2", path: "src/edit.ts" },
        },
      ]);
    vi.mocked(getBlobContent).mockResolvedValue({ text: "content" });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    await vi.waitFor(() => {
      expect(getCommitsForPR).toHaveBeenCalledTimes(1);
    });

    // Switch to commit view (commits already prefetched)
    stdin.write("\t");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Commit 1/2]");
    });

    // Navigate to second commit via Tab (commits already cached, no re-fetch)
    stdin.write("\t");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Commit 2/2]");
    });
    // getCommitsForPR should NOT be called again
    expect(getCommitsForPR).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(getAllDifferences).toHaveBeenCalledTimes(2);
    });
  });

  it("ignores stale commit diff results when switching commits quickly", async () => {
    const firstCommitDeferred = createDeferred<any[]>();

    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            sourceCommit: "src123",
            destinationCommit: "dest456",
            mergeBase: "base789",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    });
    vi.mocked(getCommitsForPR).mockResolvedValue([
      {
        commitId: "c1",
        shortId: "c1short",
        message: "First commit",
        authorName: "watany",
        authorDate: new Date("2026-02-13T09:00:00Z"),
        parentIds: ["base789"],
      },
      {
        commitId: "c2",
        shortId: "c2short",
        message: "Second commit",
        authorName: "watany",
        authorDate: new Date("2026-02-13T10:00:00Z"),
        parentIds: ["c1"],
      },
    ]);
    vi.mocked(getAllDifferences)
      .mockImplementationOnce(() => firstCommitDeferred.promise as Promise<any[]>)
      .mockResolvedValueOnce([
        {
          beforeBlob: { blobId: "commit2-before", path: "src/commit2.ts" },
          afterBlob: { blobId: "commit2-after", path: "src/commit2.ts" },
        },
      ]);
    vi.mocked(getBlobContent).mockImplementation(async (_repo, blobId) => {
      if (blobId === "commit1-before") return { text: "old first" };
      if (blobId === "commit1-after") return { text: "new first" };
      if (blobId === "commit2-before") return { text: "old second" };
      if (blobId === "commit2-after") return { text: "new second" };
      return { text: "" };
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    stdin.write("\t");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Commit 1/2]");
    });

    stdin.write("\t");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Commit 2/2]");
    });
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("+new second");
    });

    firstCommitDeferred.resolve([
      {
        beforeBlob: { blobId: "commit1-before", path: "src/commit1.ts" },
        afterBlob: { blobId: "commit1-after", path: "src/commit1.ts" },
      },
    ]);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Commit 2/2]");
      expect(lastFrame()).toContain("+new second");
      expect(lastFrame()).not.toContain("+new first");
    });
  });

  it("reloads comments without commit IDs when target has no commits", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "Original",
            },
          ],
        },
      ],
    });
    vi.mocked(updateComment).mockResolvedValue({
      commentId: "comment-1",
      content: "Updated",
    });
    vi.mocked(getComments).mockResolvedValue([]);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 10; i++) {
      stdin.write("j");
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro");
    });
    stdin.write("e");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Edit Comment:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(getComments).toHaveBeenCalledWith("42", undefined);
    });
  });

  // v0.7: Comment edit/delete tests
  it("calls updateComment and reloads comments on successful edit", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "dest1",
            sourceCommit: "src1",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "Original content",
            },
          ],
        },
      ],
    });
    vi.mocked(updateComment).mockResolvedValue({
      commentId: "comment-1",
      content: "Updated content",
    });
    vi.mocked(getComments).mockResolvedValue([
      {
        location: null,
        comments: [
          {
            commentId: "comment-1",
            authorArn: "arn:aws:iam::123456789012:user/taro",
            content: "Updated content",
          },
        ],
      },
    ]);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 10; i++) {
      stdin.write("j");
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro");
    });
    stdin.write("e");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Edit Comment:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(updateComment).toHaveBeenCalledWith({
        commentId: "comment-1",
        content: "Original content",
      });
    });
  });

  it("shows updateComment error for CommentNotCreatedByCallerException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "dest1",
            sourceCommit: "src1",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "LGTM",
            },
          ],
        },
      ],
    });
    const err = new Error("not your comment");
    err.name = "CommentNotCreatedByCallerException";
    vi.mocked(updateComment).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 10; i++) {
      stdin.write("j");
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro");
    });
    stdin.write("e");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Edit Comment:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("You can only edit your own comments.");
    });
  });

  it("calls deleteComment and reloads comments on successful delete", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "dest1",
            sourceCommit: "src1",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "Delete me",
            },
          ],
        },
      ],
    });
    vi.mocked(deleteComment).mockResolvedValue({
      commentId: "comment-1",
      content: "",
      deleted: true,
    });
    vi.mocked(getComments).mockResolvedValue([]);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 10; i++) {
      stdin.write("j");
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro");
    });
    stdin.write("d");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Delete this comment?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(deleteComment).toHaveBeenCalledWith({
        commentId: "comment-1",
      });
    });
  });

  it("shows deleteComment error for CommentDeletedException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "dest1",
            sourceCommit: "src1",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "LGTM",
            },
          ],
        },
      ],
    });
    const err = new Error("already deleted");
    err.name = "CommentDeletedException";
    vi.mocked(deleteComment).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 10; i++) {
      stdin.write("j");
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro");
    });
    stdin.write("d");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Delete this comment?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Comment has already been deleted.");
    });
  });

  it("shows edit error for CommentContentSizeLimitExceededException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "dest1",
            sourceCommit: "src1",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "LGTM",
            },
          ],
        },
      ],
    });
    const err = new Error("too long");
    err.name = "CommentContentSizeLimitExceededException";
    vi.mocked(updateComment).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 10; i++) {
      stdin.write("j");
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro");
    });
    stdin.write("e");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Edit Comment:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("The comment is over CodeCommit's 10,240 character limit.");
    });
  });

  it("shows edit error for CommentDeletedException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "dest1",
            sourceCommit: "src1",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "LGTM",
            },
          ],
        },
      ],
    });
    const err = new Error("deleted");
    err.name = "CommentDeletedException";
    vi.mocked(updateComment).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 10; i++) {
      stdin.write("j");
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro");
    });
    stdin.write("e");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Edit Comment:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Comment has already been deleted.");
    });
  });

  it("shows edit error for CommentDoesNotExistException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "dest1",
            sourceCommit: "src1",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "LGTM",
            },
          ],
        },
      ],
    });
    const err = new Error("not found");
    err.name = "CommentDoesNotExistException";
    vi.mocked(updateComment).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 10; i++) {
      stdin.write("j");
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro");
    });
    stdin.write("e");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Edit Comment:");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Comment no longer exists.");
    });
  });

  it("shows delete error for CommentDoesNotExistException", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationCommit: "dest1",
            sourceCommit: "src1",
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature",
          },
        ],
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "LGTM",
            },
          ],
        },
      ],
    });
    const err = new Error("not found");
    err.name = "CommentDoesNotExistException";
    vi.mocked(deleteComment).mockRejectedValue(err);

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 10; i++) {
      stdin.write("j");
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro");
    });
    stdin.write("d");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Delete this comment?");
    });
    stdin.write("y");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Comment no longer exists.");
    });
  });

  // v0.8: Status filter integration tests
  it("changes filter to CLOSED and reloads PRs", async () => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "35",
          title: "fix: typos",
          authorArn: "arn:aws:iam::123456789012:user/hanako",
          creationDate: new Date("2026-02-09T10:00:00Z"),
          status: "CLOSED" as const,
        },
      ],
    });

    stdin.write("f"); // filter to CLOSED
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: typos");
    });
    expect(vi.mocked(listPullRequests)).toHaveBeenLastCalledWith("my-service", undefined, "CLOSED");
  });

  it("changes filter to MERGED and filters client-side", async () => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    // First f: OPEN→CLOSED
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "35",
          title: "fix: typos",
          authorArn: "arn:aws:iam::123456789012:user/hanako",
          creationDate: new Date("2026-02-09T10:00:00Z"),
          status: "CLOSED" as const,
        },
      ],
    });
    stdin.write("f");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Closed]");
    });

    // Second f: CLOSED→MERGED, API returns CLOSED but client filters to MERGED
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "40",
          title: "feat: auth",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-11T10:00:00Z"),
          status: "MERGED" as const,
        },
        {
          pullRequestId: "35",
          title: "fix: typos",
          authorArn: "arn:aws:iam::123456789012:user/hanako",
          creationDate: new Date("2026-02-09T10:00:00Z"),
          status: "CLOSED" as const,
        },
      ],
    });
    stdin.write("f");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Merged]");
      expect(lastFrame()).toContain("feat: auth");
      expect(lastFrame()).not.toContain("fix: typos");
    });
  });

  it("fills MERGED results from later CLOSED pages", async () => {
    const openPage = {
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    };
    const closedPage = {
      pullRequests: [
        {
          pullRequestId: "35",
          title: "fix: typos",
          authorArn: "arn:aws:iam::123456789012:user/hanako",
          creationDate: new Date("2026-02-09T10:00:00Z"),
          status: "CLOSED" as const,
        },
      ],
      nextToken: "page-2",
    };
    const mergedPage = {
      pullRequests: [
        {
          pullRequestId: "40",
          title: "feat: auth",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-11T10:00:00Z"),
          status: "MERGED" as const,
        },
      ],
    };
    let phase: "initial" | "closed-filter" | "merged-filter" = "initial";

    vi.mocked(listPullRequests).mockImplementation(async (_repo, token, apiStatus) => {
      if (apiStatus === "OPEN") {
        return openPage;
      }
      if (phase === "closed-filter") {
        phase = "merged-filter";
        return closedPage;
      }
      if (phase === "merged-filter" && token === undefined) {
        return closedPage;
      }
      if (phase === "merged-filter" && token === "page-2") {
        return mergedPage;
      }
      return { pullRequests: [] };
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    phase = "closed-filter";
    stdin.write("f");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Closed]");
    });

    stdin.write("f");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("[Merged]");
      expect(lastFrame()).toContain("feat: auth");
      expect(lastFrame()).not.toContain("fix: typos");
    });
    expect(
      vi
        .mocked(listPullRequests)
        .mock.calls.some(
          ([repoName, pageToken, apiStatus]) =>
            repoName === "my-service" && pageToken === "page-2" && apiStatus === "CLOSED",
        ),
    ).toBe(true);
  });

  it("pages MERGED results 25 at a time, keeping the rest of a CLOSED page for the next", async () => {
    const merged = Array.from({ length: 30 }, (_, i) => ({
      pullRequestId: String(100 + i),
      title: `merged ${String(i + 1).padStart(2, "0")}`,
      authorArn: "arn:aws:iam::123456789012:user/watany",
      creationDate: new Date("2026-02-11T10:00:00Z"),
      status: "MERGED" as const,
    }));
    vi.mocked(listPullRequests).mockImplementation(async (_repo, _token, apiStatus) =>
      apiStatus === "OPEN" ? { pullRequests: [] } : { pullRequests: merged },
    );
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("Page 1"));
    stdin.write("f");
    await vi.waitFor(() => expect(lastFrame()).toContain("[Closed]"));
    stdin.write("f");
    await vi.waitFor(() => expect(lastFrame()).toContain("merged 01"));
    expect(lastFrame()).toMatch(/Page 1[^\n]*\. next/);
    const calls = vi.mocked(listPullRequests).mock.calls.length;
    stdin.write("n");
    await vi.waitFor(() => expect(lastFrame()).toContain("Page 2"));
    await vi.waitFor(() => expect(lastFrame()).toContain("merged 26"));
    expect(lastFrame()).toContain("merged 30");
    expect(lastFrame()).not.toContain("merged 25");
    expect(lastFrame()).not.toMatch(/Page 2[^\n]*\. next/);
    // The rest came from the first CLOSED page: no new request.
    expect(vi.mocked(listPullRequests)).toHaveBeenCalledTimes(calls);
  });

  // v0.8: Pagination integration tests
  it("navigates to next page with n key", async () => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: "token-A",
    });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
      expect(lastFrame()).toContain(". next");
    });

    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "50",
          title: "feat: search",
          authorArn: "arn:aws:iam::123456789012:user/taro",
          creationDate: new Date("2026-02-10T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });

    stdin.write("n");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("feat: search");
      expect(lastFrame()).toContain("Page 2");
    });
    expect(vi.mocked(listPullRequests)).toHaveBeenLastCalledWith("my-service", "token-A", "OPEN");
  });

  it("navigates to previous page with p key", async () => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: "token-A",
    });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "50",
          title: "feat: search",
          authorArn: "arn:aws:iam::123456789012:user/taro",
          creationDate: new Date("2026-02-10T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: "token-B",
    });
    stdin.write("n");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Page 2");
    });

    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: "token-A",
    });
    stdin.write("p");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Page 1");
      expect(lastFrame()).toContain("fix: login");
    });
  });

  it("resets pagination on filter change", async () => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: "token-A",
    });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "50",
          title: "feat: search",
          authorArn: "arn:aws:iam::123456789012:user/taro",
          creationDate: new Date("2026-02-10T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    stdin.write("n");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Page 2");
    });

    // Change filter -> should reset to page 1
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "35",
          title: "fix: typos",
          authorArn: "arn:aws:iam::123456789012:user/hanako",
          creationDate: new Date("2026-02-09T10:00:00Z"),
          status: "CLOSED" as const,
        },
      ],
    });
    stdin.write("f");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Page 1");
      expect(lastFrame()).toContain("fix: typos");
    });
  });

  it("handles InvalidContinuationTokenException by resetting to page 1", async () => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
      nextToken: "token-A",
    });
    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    const tokenError = new Error("Invalid token");
    tokenError.name = "InvalidContinuationTokenException";
    vi.mocked(listPullRequests).mockRejectedValueOnce(tokenError);

    stdin.write("n");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Page token expired");
    });
  });

  // v0.2.0: Reaction integration test
  it("loads reactions with PR detail and calls putReaction on g key", async () => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValueOnce({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature/login",
            sourceCommit: "src1",
            destinationCommit: "dst1",
            mergeBase: "base1",
          },
        ],
        revisionId: "rev1",
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            {
              commentId: "comment-1",
              authorArn: "arn:aws:iam::123456789012:user/taro",
              content: "LGTM",
            },
          ],
        },
      ],
    });
    vi.mocked(getReactionsForComments).mockResolvedValueOnce(
      new Map([["comment-1", [{ emoji: "👍", shortCode: ":thumbsup:", count: 1, userArns: [] }]]]),
    );

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });

    // Select the PR
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    // Verify reactions loaded (badge displayed)
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("👍×1");
    });

    expect(vi.mocked(getReactionsForComments)).toHaveBeenCalledWith(["comment-1"]);
  });

  it("submits reaction successfully and reloads reactions", async () => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValueOnce({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature/login",
            sourceCommit: "src1",
            destinationCommit: "dst1",
            mergeBase: "base1",
          },
        ],
        revisionId: "rev1",
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            { commentId: "c1", authorArn: "arn:aws:iam::123456789012:user/taro", content: "OK" },
          ],
        },
      ],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 5; i++) stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro: OK");
    });
    stdin.write("g");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("React to comment:");
    });

    vi.mocked(putReaction).mockResolvedValueOnce(undefined);
    vi.mocked(getReactionsForComments).mockResolvedValueOnce(
      new Map([["c1", [{ emoji: "👍", shortCode: ":thumbsup:", count: 1, userArns: [] }]]]),
    );

    stdin.write("\r"); // submit reaction
    await vi.waitFor(() => {
      expect(vi.mocked(putReaction)).toHaveBeenCalledWith({
        commentId: "c1",
        reactionValue: ":thumbsup:",
      });
    });
    // Badge should appear after reactions reload
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("👍×1");
    });
  });

  describe("reactions read only for comments CodeCommit counts reactions on (#101)", () => {
    const openPr = async (comments: object[]) => {
      vi.mocked(listPullRequests).mockResolvedValueOnce({
        pullRequests: [
          {
            pullRequestId: "42",
            title: "fix: login",
            authorArn: "arn:aws:iam::123456789012:user/watany",
            creationDate: new Date("2026-02-13T10:00:00Z"),
            status: "OPEN" as const,
          },
        ],
      });
      vi.mocked(getPullRequestDetail).mockResolvedValueOnce({
        pullRequest: {
          pullRequestId: "42",
          title: "fix: login",
          pullRequestTargets: [
            {
              destinationReference: "refs/heads/main",
              sourceReference: "refs/heads/feature/login",
              sourceCommit: "src1",
              destinationCommit: "dst1",
              mergeBase: "base1",
            },
          ],
          revisionId: "rev1",
        },
        differences: [],
        commentThreads: [{ location: null, comments }],
      } as any);
      const r = render(<App service={svc} repository="my-service" start={null} />);
      await vi.waitFor(() => expect(r.lastFrame()).toContain("fix: login"));
      r.stdin.write("\r");
      await vi.waitFor(() => expect(r.lastFrame()).toContain("PR #42"));
      return r;
    };
    const taro = "arn:aws:iam::123456789012:user/taro";

    it("reads none when no comment has a reaction", async () => {
      const { lastFrame } = await openPr([
        { commentId: "c1", authorArn: taro, content: "first", reactionCounts: {} },
        { commentId: "c2", authorArn: taro, content: "second", reactionCounts: {} },
      ]);
      await vi.waitFor(() => expect(lastFrame()).toContain("taro: second"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(vi.mocked(getReactionsForComments)).not.toHaveBeenCalled();
    });

    it("reads only the comments with a reaction", async () => {
      vi.mocked(getReactionsForComments).mockResolvedValueOnce(
        new Map([["c2", [{ emoji: "👍", shortCode: ":thumbsup:", count: 1, userArns: [] }]]]),
      );
      const { lastFrame } = await openPr([
        { commentId: "c1", authorArn: taro, content: "first", reactionCounts: {} },
        { commentId: "c2", authorArn: taro, content: "second", reactionCounts: { "👍": 1 } },
      ]);
      await vi.waitFor(() => expect(lastFrame()).toContain("👍×1"));
      expect(vi.mocked(getReactionsForComments)).toHaveBeenCalledWith(["c2"]);
    });

    it("re-reads only the reacted comment and keeps the others' badges", async () => {
      vi.mocked(getReactionsForComments).mockResolvedValueOnce(
        new Map([["c2", [{ emoji: "🎉", shortCode: ":hooray:", count: 2, userArns: [] }]]]),
      );
      const { lastFrame, stdin } = await openPr([
        { commentId: "c1", authorArn: taro, content: "first", reactionCounts: {} },
        { commentId: "c2", authorArn: taro, content: "second", reactionCounts: { "🎉": 2 } },
      ]);
      await vi.waitFor(() => expect(lastFrame()).toContain("🎉×2"));
      for (let i = 0; i < 6; i++) stdin.write("j");
      stdin.write("k");
      await vi.waitFor(() => expect(lastFrame()).toContain(">  taro: first"));
      stdin.write("g");
      await vi.waitFor(() => expect(lastFrame()).toContain("React to comment:"));
      vi.mocked(putReaction).mockResolvedValueOnce(undefined);
      vi.mocked(getReactionsForComments).mockResolvedValueOnce(
        new Map([["c1", [{ emoji: "👍", shortCode: ":thumbsup:", count: 1, userArns: [] }]]]),
      );
      stdin.write("\r");
      await vi.waitFor(() => expect(lastFrame()).toContain("👍×1"));
      expect(vi.mocked(getReactionsForComments)).toHaveBeenLastCalledWith(["c1"]);
      expect(lastFrame()).toContain("🎉×2");
    });

    it("drops a comment's badge when its last reaction is taken back", async () => {
      vi.mocked(getReactionsForComments).mockResolvedValueOnce(
        new Map([["c1", [{ emoji: "👍", shortCode: ":thumbsup:", count: 1, userArns: [] }]]]),
      );
      const { lastFrame, stdin } = await openPr([
        { commentId: "c1", authorArn: taro, content: "first", reactionCounts: { "👍": 1 } },
      ]);
      await vi.waitFor(() => expect(lastFrame()).toContain("👍×1"));
      for (let i = 0; i < 6; i++) stdin.write("j");
      await vi.waitFor(() => expect(lastFrame()).toContain(">  taro: first"));
      stdin.write("g");
      await vi.waitFor(() => expect(lastFrame()).toContain("React to comment:"));
      vi.mocked(putReaction).mockResolvedValueOnce(undefined);
      vi.mocked(getReactionsForComments).mockResolvedValueOnce(new Map());
      stdin.write("\r");
      await vi.waitFor(() => expect(lastFrame()).not.toContain("👍×1"));
    });
  });

  it("shows reaction error when putReaction fails with CommentDeletedException", async () => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValueOnce({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature/login",
            sourceCommit: "src1",
            destinationCommit: "dst1",
            mergeBase: "base1",
          },
        ],
        revisionId: "rev1",
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            { commentId: "c1", authorArn: "arn:aws:iam::123456789012:user/taro", content: "OK" },
          ],
        },
      ],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });

    for (let i = 0; i < 5; i++) stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro: OK");
    });

    stdin.write("g");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("React to comment:");
    });

    // Make putReaction fail
    const error = new Error("deleted");
    error.name = "CommentDeletedException";
    vi.mocked(putReaction).mockRejectedValueOnce(error);

    stdin.write("\r"); // submit reaction
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Comment has already been deleted.");
    });
  });

  it.each([
    { errorName: "CommentDoesNotExistException", expected: "Comment no longer exists." },
    { errorName: "ReactionValueRequiredException", expected: "Reaction value is required." },
    { errorName: "InvalidReactionValueException", expected: "Invalid reaction value." },
  ])("shows $expected for $errorName", async ({ errorName, expected }) => {
    vi.mocked(listPullRequests).mockResolvedValueOnce({
      pullRequests: [
        {
          pullRequestId: "42",
          title: "fix: login",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    });
    vi.mocked(getPullRequestDetail).mockResolvedValueOnce({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/feature/login",
            sourceCommit: "src1",
            destinationCommit: "dst1",
            mergeBase: "base1",
          },
        ],
        revisionId: "rev1",
      },
      differences: [],
      commentThreads: [
        {
          location: null,
          comments: [
            { commentId: "c1", authorArn: "arn:aws:iam::123456789012:user/taro", content: "OK" },
          ],
        },
      ],
    });

    const { lastFrame, stdin } = render(<App service={svc} repository="my-service" start={null} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("fix: login");
    });
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("PR #42");
    });
    for (let i = 0; i < 5; i++) stdin.write("j");
    stdin.write("j");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(">  taro: OK");
    });
    stdin.write("g");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("React to comment:");
    });

    const error = new Error("fail");
    error.name = errorName;
    vi.mocked(putReaction).mockRejectedValueOnce(error);
    stdin.write("\r");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(expected);
    });
  });

  // Activity timeline tests
  describe("Activity timeline", () => {
    function setupPRListAndDetail() {
      vi.mocked(listPullRequests).mockResolvedValue({
        pullRequests: [
          {
            pullRequestId: "42",
            title: "fix: login timeout",
            authorArn: "arn:aws:iam::123456789012:user/watany",
            creationDate: new Date("2026-02-13T10:00:00Z"),
            status: "OPEN" as const,
          },
        ],
      });
      vi.mocked(getPullRequestDetail).mockResolvedValue({
        pullRequest: {
          pullRequestId: "42",
          title: "fix: login timeout",
          pullRequestTargets: [],
        },
        differences: [],
        commentThreads: [],
      });
    }

    it("pressing A shows activity screen with events", async () => {
      setupPRListAndDetail();
      vi.mocked(getPullRequestActivity).mockResolvedValue({
        events: [
          {
            eventDate: new Date("2026-02-13T10:00:00Z"),
            eventType: "PULL_REQUEST_CREATED",
            actorArn: "arn:aws:iam::123456789012:user/watany",
            description: "created this PR",
          },
        ],
        nextToken: undefined,
      });

      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={null} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("fix: login timeout");
      });

      stdin.write("\r");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });

      stdin.write("A");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Activity:");
        expect(lastFrame()).toContain("created this PR");
      });
    });

    it("pressing A calls getPullRequestActivity with PR id", async () => {
      setupPRListAndDetail();
      vi.mocked(getPullRequestActivity).mockResolvedValue({ events: [], nextToken: undefined });

      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={null} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("fix: login timeout");
      });

      stdin.write("\r");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });

      stdin.write("A");
      await vi.waitFor(() => {
        expect(getPullRequestActivity).toHaveBeenCalledWith(
          expect.objectContaining({ pullRequestId: "42" }),
        );
      });
    });

    it("shows error message when getPullRequestActivity fails", async () => {
      setupPRListAndDetail();
      const err = new Error("denied");
      err.name = "AccessDeniedException";
      vi.mocked(getPullRequestActivity).mockRejectedValue(err);

      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={null} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("fix: login timeout");
      });

      stdin.write("\r");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });

      stdin.write("A");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Failed to load activity:");
      });
    });

    it("pressing q on activity screen returns to detail", async () => {
      setupPRListAndDetail();
      vi.mocked(getPullRequestActivity).mockResolvedValue({ events: [], nextToken: undefined });

      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={null} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("fix: login timeout");
      });

      stdin.write("\r");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });

      stdin.write("A");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Activity:");
      });

      stdin.write("\u001B");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });
    });

    it("pressing n loads next page of activity", async () => {
      setupPRListAndDetail();
      vi.mocked(getPullRequestActivity)
        .mockResolvedValueOnce({
          events: [
            {
              eventDate: new Date("2026-02-13T10:00:00Z"),
              eventType: "PULL_REQUEST_CREATED",
              actorArn: "arn:aws:iam::123456789012:user/watany",
              description: "created this PR",
            },
          ],
          nextToken: "token123",
        })
        .mockResolvedValueOnce({
          events: [
            {
              eventDate: new Date("2026-02-14T10:00:00Z"),
              eventType: "PULL_REQUEST_APPROVAL_STATE_CHANGED",
              actorArn: "arn:aws:iam::123456789012:user/taro",
              description: "approved this PR",
            },
          ],
          nextToken: undefined,
        });

      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={null} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("fix: login timeout");
      });

      stdin.write("\r");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });

      stdin.write("A");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("created this PR");
        expect(lastFrame()).toContain("n next page");
      });

      stdin.write("n");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("approved this PR");
      });

      expect(getPullRequestActivity).toHaveBeenCalledTimes(2);
      expect(getPullRequestActivity).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ pullRequestId: "42", nextToken: "token123" }),
      );
    });

    it("retries activity from the start when continuation token is stale", async () => {
      setupPRListAndDetail();
      const tokenError = new Error("Invalid token");
      tokenError.name = "InvalidContinuationTokenException";
      vi.mocked(getPullRequestActivity)
        .mockResolvedValueOnce({
          events: [
            {
              eventDate: new Date("2026-02-13T10:00:00Z"),
              eventType: "PULL_REQUEST_CREATED",
              actorArn: "arn:aws:iam::123456789012:user/watany",
              description: "created this PR",
            },
          ],
          nextToken: "stale-token",
        })
        .mockRejectedValueOnce(tokenError)
        .mockResolvedValueOnce({
          events: [
            {
              eventDate: new Date("2026-02-15T10:00:00Z"),
              eventType: "PULL_REQUEST_STATUS_CHANGED",
              actorArn: "arn:aws:iam::123456789012:user/hanako",
              description: "closed this PR",
            },
          ],
          nextToken: undefined,
        });

      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={null} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("fix: login timeout");
      });

      stdin.write("\r");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });

      stdin.write("A");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("created this PR");
        expect(lastFrame()).toContain("n next page");
      });

      stdin.write("n");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("closed this PR");
      });

      expect(lastFrame()).not.toContain("Failed to load activity:");
      expect(lastFrame()).not.toContain("created this PR");
      expect(getPullRequestActivity).toHaveBeenCalledTimes(3);
      expect(getPullRequestActivity).toHaveBeenNthCalledWith(3, {
        pullRequestId: "42",
        maxResults: 50,
      });
    });

    it("shows activity error when stale-token retry fails", async () => {
      setupPRListAndDetail();
      const tokenError = new Error("Invalid token");
      tokenError.name = "InvalidContinuationTokenException";
      const denied = new Error("denied");
      denied.name = "AccessDeniedException";
      vi.mocked(getPullRequestActivity)
        .mockResolvedValueOnce({
          events: [
            {
              eventDate: new Date("2026-02-13T10:00:00Z"),
              eventType: "PULL_REQUEST_CREATED",
              actorArn: "arn:aws:iam::123456789012:user/watany",
              description: "created this PR",
            },
          ],
          nextToken: "stale-token",
        })
        .mockRejectedValueOnce(tokenError)
        .mockRejectedValueOnce(denied);

      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={null} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("fix: login timeout");
      });

      stdin.write("\r");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });

      stdin.write("A");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("created this PR");
        expect(lastFrame()).toContain("n next page");
      });

      stdin.write("n");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Failed to load activity:");
        expect(lastFrame()).toContain("Access denied. Check your IAM policy.");
      });
    });

    it("shows PR not found error for PullRequestDoesNotExistException", async () => {
      setupPRListAndDetail();
      const err = new Error("not found");
      err.name = "PullRequestDoesNotExistException";
      vi.mocked(getPullRequestActivity).mockRejectedValue(err);

      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={null} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("fix: login timeout");
      });

      stdin.write("\r");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });

      stdin.write("A");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Pull request not found.");
      });
    });
    it("keeps a slow activity load of the PR left before from replacing the next PR's", async () => {
      const pr = (id: string) => ({
        pullRequestId: id,
        title: `PR title ${id}`,
        authorArn: "arn:aws:iam::123456789012:user/watany",
        creationDate: new Date("2026-02-13T10:00:00Z"),
        status: "OPEN" as const,
      });
      vi.mocked(listPullRequests).mockResolvedValue({ pullRequests: [pr("42"), pr("43")] });
      vi.mocked(getPullRequestDetail).mockImplementation(async (id: string) => ({
        pullRequest: { pullRequestId: id, title: `PR title ${id}`, pullRequestTargets: [] },
        differences: [],
        commentThreads: [],
      }));
      const event = (description: string) => ({
        eventDate: new Date("2026-02-13T10:00:00Z"),
        eventType: "PULL_REQUEST_CREATED",
        actorArn: "arn:aws:iam::123456789012:user/watany",
        description,
      });
      const slow = createDeferred<{ events: ReturnType<typeof event>[] }>();
      vi.mocked(getPullRequestActivity).mockImplementation(async ({ pullRequestId }) =>
        pullRequestId === "42" ? slow.promise : { events: [event("event of 43")] },
      );

      const screen = render(<App service={svc} repository="my-service" start={null} />);
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("PR title 43"));
      await press(screen, "\r");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("PR #42"));
      await press(screen, "A", "\u001B", "\u001B", "j", "\r");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("PR #43"));
      await press(screen, "A");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("event of 43"));

      slow.resolve({ events: [event("event of 42")] });
      await settle();
      expect(screen.lastFrame()).toContain("Activity: PR title 43");
      expect(screen.lastFrame()).toContain("event of 43");
      expect(screen.lastFrame()).not.toContain("event of 42");
    });
    it.each([
      ["answered", (d: ReturnType<typeof createDeferred<unknown>>) => d.resolve({ events: [] })],
      ["refused", (d: ReturnType<typeof createDeferred<unknown>>) => d.reject(new Error("late"))],
    ])("drops a next page %s after the timeline was opened again", async (_, settleSlow) => {
      setupPRListAndDetail();
      const event = (description: string) => ({
        eventDate: new Date("2026-02-13T10:00:00Z"),
        eventType: "PULL_REQUEST_CREATED",
        actorArn: "arn:aws:iam::123456789012:user/watany",
        description,
      });
      const slow = createDeferred<unknown>();
      let firstPages = 0;
      vi.mocked(getPullRequestActivity).mockImplementation(async ({ nextToken }) => {
        if (nextToken === "t1") {
          await slow.promise;
          return { events: [event("stale page two")] };
        }
        firstPages++;
        return { events: [event(`first page ${firstPages}`)], nextToken: "t1" };
      });

      const screen = render(<App service={svc} repository="my-service" start={null} />);
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("fix: login timeout"));
      await press(screen, "\r");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("PR #42"));
      await press(screen, "A");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("first page 1"));
      await press(screen, "n", "\u001B", "A");
      await vi.waitFor(() => expect(screen.lastFrame()).toContain("first page 2"));

      settleSlow(slow);
      await settle();
      expect(screen.lastFrame()).toContain("first page 2");
      expect(screen.lastFrame()).not.toContain("stale page two");
      expect(screen.lastFrame()).not.toContain("Failed to load activity");
    });
  });

  describe("starting on one pull request", () => {
    const detail = {
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        pullRequestTargets: [
          {
            destinationReference: "refs/heads/main",
            sourceReference: "refs/heads/fix",
            destinationCommit: "def456",
            sourceCommit: "abc123",
          },
        ],
      },
      differences: [],
      commentThreads: [],
    };
    const listed = {
      pullRequests: [
        {
          pullRequestId: "7",
          title: "other work",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-13T10:00:00Z"),
          status: "OPEN" as const,
        },
      ],
    };

    it("opens the PR without loading the list, and q exits", async () => {
      vi.mocked(getPullRequestDetail).mockResolvedValue(detail as any);
      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={{ pullRequestId: "42" }} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });
      expect(getPullRequestDetail).toHaveBeenCalledWith("42", "my-service");
      expect(listPullRequests).not.toHaveBeenCalled();
      stdin.write("q");
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalled();
      });
    });

    it("shows the freshly loaded list after a close, and q from a PR then returns to it", async () => {
      vi.mocked(getPullRequestDetail).mockResolvedValue(detail as any);
      vi.mocked(closePullRequest).mockResolvedValue({} as any);
      vi.mocked(listPullRequests).mockResolvedValue(listed);
      const { lastFrame, stdin } = render(
        <App service={svc} repository="my-service" start={{ pullRequestId: "42" }} />,
      );
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });
      stdin.write("x");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("(Enter/y, Esc/n)");
      });
      stdin.write("y");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("other work");
      });
      expect(listPullRequests).toHaveBeenCalledWith("my-service", undefined, "OPEN");
      stdin.write("\r");
      await vi.waitFor(() => {
        expect(getPullRequestDetail).toHaveBeenCalledWith("7", "my-service");
      });
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("PR #42");
      });
      stdin.write("\u001B");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("other work");
      });
      expect(exit).not.toHaveBeenCalled();
    });
  });

  it("goes back to the parent screen from an error with Esc", async () => {
    vi.mocked(getPullRequestDetail).mockRejectedValue(new Error("boom"));
    const onExit = vi.fn();
    const { lastFrame, stdin } = render(
      <App service={svc} repository="my-service" start={{ pullRequestId: "42" }} onExit={onExit} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("Esc back, q quit"));
    stdin.write("\u001B");
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
    expect(exit).not.toHaveBeenCalled();
  });

  it("returns to the parent screen after a close when it has one", async () => {
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: { pullRequestId: "42", title: "fix: login", pullRequestTargets: [] },
      differences: [],
      commentThreads: [],
    } as any);
    vi.mocked(closePullRequest).mockResolvedValue({} as any);
    const onExit = vi.fn();
    const { lastFrame, stdin } = render(
      <App service={svc} repository="my-service" start={{ pullRequestId: "42" }} onExit={onExit} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("PR #42"));
    stdin.write("x");
    await vi.waitFor(() => expect(lastFrame()).toContain("(Enter/y, Esc/n)"));
    stdin.write("y");
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
    expect(listPullRequests).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("marks the PR read when it opens and again when it is left", async () => {
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        authorArn: "arn:aws:iam::111122223333:user/a",
        pullRequestTargets: [],
      },
      differences: [],
      commentThreads: [],
    } as any);
    const markSeen = vi.fn();
    const onExit = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <App
        service={{ ...svc, markSeen }}
        repository="my-service"
        start={{ pullRequestId: "42" }}
        onExit={onExit}
      />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("PR #42"));
    // With the author, whose ARN names the account: PR ids repeat across accounts.
    expect(markSeen).toHaveBeenCalledWith({
      id: "42",
      authorArn: "arn:aws:iam::111122223333:user/a",
    });
    stdin.write("\u001B");
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
    unmount();
    expect(markSeen).toHaveBeenCalledTimes(2);
  });

  it("marks the PR being opened, not the one opened before it", async () => {
    vi.mocked(listPullRequests).mockResolvedValue({
      pullRequests: [
        {
          pullRequestId: "1",
          title: "first",
          authorArn: "a",
          creationDate: new Date(),
          status: "OPEN",
        },
        {
          pullRequestId: "2",
          title: "second",
          authorArn: "a",
          creationDate: new Date(),
          status: "OPEN",
        },
      ],
    } as any);
    vi.mocked(getPullRequestDetail).mockImplementation(
      async (id: string) =>
        ({
          pullRequest: { pullRequestId: id, title: `pr ${id}`, pullRequestTargets: [] },
          differences: [],
          commentThreads: [],
        }) as any,
    );
    const markSeen = vi.fn();
    const { lastFrame, stdin } = render(
      <App service={{ ...svc, markSeen }} repository="my-service" start={null} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("second"));
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("PR #1"));
    stdin.write("\u001B");
    await vi.waitFor(() => expect(lastFrame()).toContain("second"));
    await settle();
    await press(stdin, "j", "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("PR #2"));
    expect(markSeen.mock.calls.map(([pr]) => pr.id)).toEqual(["1", "1", "2"]);
  });
});

describe("CI results on the review screen (ADR 0010)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getReactionsForComments).mockResolvedValue(new Map());
    vi.mocked(getCommitsForPR).mockResolvedValue([]);
    vi.mocked(getApprovalStates).mockResolvedValue([]);
    vi.mocked(evaluateApprovalRules).mockResolvedValue(null);
    vi.mocked(getPullRequestDetail).mockResolvedValue({
      pullRequest: {
        pullRequestId: "42",
        title: "fix: login",
        revisionId: "rev-1",
        pullRequestTargets: [{ sourceCommit: "abc1234def", destinationCommit: "d" }],
      },
      differences: [],
      commentThreads: [],
    } as any);
  });

  it("shows each project and pipeline under the overall state", async () => {
    const checks = vi.fn(async () => ({
      state: "fail" as const,
      commit: "abc1234def",
      runs: [
        {
          provider: "codebuild" as const,
          name: "check",
          state: "fail" as const,
          status: "FAILED",
          id: "check:1",
          startedAt: null,
          endedAt: null,
          url: "https://console/check:1",
        },
        {
          provider: "codepipeline" as const,
          name: "release",
          state: "none" as const,
          status: null,
          id: null,
          startedAt: null,
          endedAt: null,
          url: null,
        },
        {
          provider: "codepipeline" as const,
          name: "locked",
          state: "error" as const,
          status: null,
          id: null,
          startedAt: null,
          endedAt: null,
          url: null,
          message: "Access denied: \u001b[31mx",
        },
      ],
    }));
    const { lastFrame } = render(
      <App service={{ ...svc, checks }} repository="my-service" start={{ pullRequestId: "42" }} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("CI: ✗ fail"));
    expect(checks).toHaveBeenCalledWith({ repository: "my-service", sourceCommit: "abc1234def" });
    expect(lastFrame()).toContain("✗ codebuild check FAILED https://console/check:1");
    expect(lastFrame()).toContain("· codepipeline release no run on abc1234 among the newest 20");
    expect(lastFrame()).toContain("! codepipeline locked Access denied: ^[[31mx");
  });

  it("shows a run's name, status and URL as text, not terminal escapes", async () => {
    const checks = vi.fn(async () => ({
      state: "pass" as const,
      commit: "abc1234def",
      runs: [
        {
          provider: "codebuild" as const,
          name: "a\u001b]52;c;eA==\u0007b",
          state: "pass" as const,
          status: "OK\u009b2J",
          id: "x:1",
          startedAt: null,
          endedAt: null,
          url: "https://console/\u001b[2Jx",
        },
      ],
    }));
    const { lastFrame } = render(
      <App service={{ ...svc, checks }} repository="my-service" start={{ pullRequestId: "42" }} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("CI: ✓ pass"));
    expect(lastFrame()).toContain("codebuild a^[]52;c;eA==^Gb OK^[[2J https://console/^[[2Jx");
  });

  it("leaves the CI line out when nothing is configured or the lookup fails", async () => {
    const none = render(
      <App
        service={{ ...svc, checks: async () => null }}
        repository="my-service"
        start={{ pullRequestId: "42" }}
      />,
    );
    await vi.waitFor(() => expect(none.lastFrame()).toContain("PR #42"));
    const failed = render(
      <App
        service={{
          ...svc,
          checks: async () => {
            throw new Error("chunk");
          },
        }}
        repository="my-service"
        start={{ pullRequestId: "42" }}
      />,
    );
    await vi.waitFor(() => expect(failed.lastFrame()).toContain("PR #42"));
    await new Promise((r) => setTimeout(r, 30));
    expect(none.lastFrame()).not.toContain("CI:");
    expect(failed.lastFrame()).not.toContain("CI:");
  });
});
