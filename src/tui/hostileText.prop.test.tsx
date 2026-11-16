import {
  CodeCommitClient,
  DescribePullRequestEventsCommand,
  EvaluatePullRequestApprovalRulesCommand,
  GetBlobCommand,
  GetCommentReactionsCommand,
  GetCommentsForPullRequestCommand,
  GetCommitCommand,
  GetDifferencesCommand,
  GetMergeConflictsCommand,
  GetPullRequestApprovalStatesCommand,
  GetPullRequestCommand,
  ListPullRequestsCommand,
} from "@aws-sdk/client-codecommit";
import { mockClient } from "aws-sdk-client-mock";
import * as fc from "fast-check";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewApi } from "../aws/review.js";
import { createReviewService } from "../core/review.js";
import { press, render, settle } from "../testing/keys.js";

vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  useApp: () => ({ exit: vi.fn() }),
}));

import { App } from "./ReviewApp.js";

const cc = mockClient(CodeCommitClient);
afterEach(() => cc.reset());

const SRC = "a".repeat(40);
const DST = "b".repeat(40);

/**
 * CodeCommit as an attacker with write access to one repository could make it
 * answer: every free-text field they control holds `h`. Names CodeCommit
 * validates (ARNs, ids) stay plain.
 */
function hostileCodeCommit(h: string) {
  const pr = {
    pullRequestId: "7",
    title: `title ${h}`,
    description: `line one ${h}\nline two ${h}`,
    pullRequestStatus: "OPEN" as const,
    authorArn: "arn:aws:iam::123456789012:user/mallory",
    creationDate: new Date("2026-11-01T00:00:00Z"),
    lastActivityDate: new Date("2026-11-02T00:00:00Z"),
    revisionId: "rev1",
    pullRequestTargets: [
      {
        repositoryName: "demo",
        sourceReference: `refs/heads/topic${h}`,
        destinationReference: `refs/heads/main${h}`,
        sourceCommit: SRC,
        destinationCommit: DST,
        mergeBase: DST,
        mergeMetadata: { isMerged: false },
      },
    ],
    approvalRules: [{ approvalRuleName: `rule ${h}`, approvalRuleContent: "{}" }],
  };
  cc.on(ListPullRequestsCommand).resolves({ pullRequestIds: ["7"] });
  cc.on(GetPullRequestCommand).resolves({ pullRequest: pr });
  cc.on(GetDifferencesCommand).resolves({
    differences: [
      {
        changeType: "M",
        beforeBlob: { blobId: "b1", path: `src/file${h}.ts` },
        afterBlob: { blobId: "b2", path: `src/file${h}.ts` },
      },
    ],
  });
  cc.on(GetBlobCommand, { blobId: "b1" }).resolves({
    content: new TextEncoder().encode(`old ${h}\nsame\n`),
  });
  cc.on(GetBlobCommand, { blobId: "b2" }).resolves({
    content: new TextEncoder().encode(`new ${h}\nsame\n`),
  });
  cc.on(GetCommentsForPullRequestCommand).resolves({
    commentsForPullRequestData: [
      {
        beforeCommitId: DST,
        afterCommitId: SRC,
        location: { filePath: `src/file${h}.ts`, filePosition: 1, relativeFileVersion: "AFTER" },
        comments: [
          {
            commentId: "c1",
            content: `inline ${h}`,
            authorArn: "arn:aws:iam::123456789012:user/mallory",
            creationDate: new Date("2026-11-01T01:00:00Z"),
            reactionCounts: { ":+1:": 1 },
          },
        ],
      },
      {
        beforeCommitId: DST,
        afterCommitId: SRC,
        comments: [
          {
            commentId: "c2",
            content: `general ${h}`,
            authorArn: "arn:aws:iam::123456789012:user/mallory",
            creationDate: new Date("2026-11-01T02:00:00Z"),
          },
        ],
      },
    ],
  });
  // Reactions come from CodeCommit's fixed set (PutCommentReaction refuses others).
  cc.on(GetCommentReactionsCommand).resolves({
    reactionsForComment: [
      {
        reaction: { emoji: "👍", shortCode: ":thumbsup:", unicode: "U+1F44D" },
        reactionUsers: ["arn:aws:iam::123456789012:user/mallory"],
      },
    ],
  });
  cc.on(GetCommitCommand).resolves({
    commit: {
      commitId: SRC,
      parents: [DST],
      message: `subject ${h}\n\nbody ${h}`,
      author: { name: `Mallory ${h}`, email: "m@example.com", date: "1762000000 +0000" },
    },
  });
  cc.on(GetPullRequestApprovalStatesCommand).resolves({
    approvals: [{ userArn: "arn:aws:iam::123456789012:user/mallory", approvalState: "APPROVE" }],
  });
  cc.on(EvaluatePullRequestApprovalRulesCommand).resolves({
    evaluation: {
      approved: false,
      overridden: false,
      approvalRulesSatisfied: [`rule ${h}`],
      approvalRulesNotSatisfied: [`other rule ${h}`],
    },
  });
  cc.on(GetMergeConflictsCommand).resolves({
    mergeable: false,
    conflictMetadataList: [{ filePath: `conflict${h}.ts` }],
  });
  cc.on(DescribePullRequestEventsCommand).resolves({
    pullRequestEvents: [
      {
        pullRequestId: "7",
        eventDate: new Date("2026-11-01T03:00:00Z"),
        pullRequestEventType: "PULL_REQUEST_APPROVAL_RULE_CREATED",
        actorArn: "arn:aws:iam::123456789012:user/mallory",
        approvalRuleEventMetadata: { approvalRuleName: `rule ${h}` },
      },
      {
        pullRequestId: "7",
        eventDate: new Date("2026-11-01T04:00:00Z"),
        pullRequestEventType: `FUTURE_EVENT${h}` as never,
        actorArn: "arn:aws:iam::123456789012:user/mallory",
      },
    ],
  });
}

// What may reach the terminal from text: printable characters and line breaks, nothing
// that moves the cursor, rewrites the screen or the clipboard (ESC, CSI, OSC, BEL, C1).
// oxlint-disable-next-line no-control-regex -- finding them is the point
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

const hostile = fc
  .array(
    fc.constantFrom(
      "\u001b[2J",
      "\u001b]52;c;aGk=\u0007",
      "\u009b31m",
      "\r",
      "\b",
      "\u001bc",
      "\u0085",
      "\u007f",
      "\t",
    ),
    { minLength: 1, maxLength: 3 },
  )
  .map((parts) => parts.join("x"));

describe("the review screen, on text an attacker wrote", () => {
  it("never draws a control character from it, on any of its views", async () => {
    await fc.assert(
      fc.asyncProperty(hostile, async (h) => {
        hostileCodeCommit(h);
        const service = createReviewService(
          createReviewApi(new CodeCommitClient({ region: "us-west-2" })),
        );
        const screen = render(<App service={service} repository="demo" start={null} />);
        const frames: [string, string][] = [];
        const look = (view: string) => frames.push([view, screen.lastFrame() ?? ""]);
        try {
          await vi.waitFor(() => expect(screen.lastFrame()).toContain("#7"));
          look("list");
          await press(screen, "\r");
          await vi.waitFor(() => expect(screen.lastFrame()).toContain("general"));
          await settle();
          look("detail");
          await press(screen, "G");
          look("detail end");
          await press(screen, "f");
          look("file list");
          await press(screen, "\u001b");
          await press(screen, "A");
          await vi.waitFor(() => expect(screen.lastFrame()).toContain("FUTURE_EVENT"));
          look("activity");
          await press(screen, "\u001b");
          await press(screen, "\t");
          await settle();
          look("commit view");
          await press(screen, "\u001b[Z");
          await press(screen, "m");
          await settle();
          look("merge");
          await press(screen, "\u001b");
          await press(screen, "D");
          look("drafts");
        } finally {
          screen.unmount();
          cc.reset();
        }
        for (const [view, frame] of frames) {
          const bad = frame.split("\n").find((l) => CONTROL.test(l));
          expect(bad === undefined ? view : `${view}: ${JSON.stringify(bad)}`).toBe(view);
        }
      }),
      { numRuns: 8 },
    );
  }, 120_000);
});
