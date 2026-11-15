import { render } from "ink";
import type { BranchActions } from "../core/branch.js";
import type { BrowseActions } from "../core/browse.js";
import { openReviewService, type ReviewService } from "../core/review.js";
import type { Git } from "../git/git.js";
import { BranchesApp, type BranchesStart } from "./BranchesApp.js";
import { BrowseApp } from "./BrowseApp.js";
import { App, type ReviewStart } from "./ReviewApp.js";

// This module is loaded with a dynamic import, so CLI subcommands never load Ink or React.

interface ServiceRequest {
  readonly region?: string;
  readonly profile?: string;
  /** Set inside a clone of the repository: diffs then come from git. */
  readonly git?: Git;
}

export interface ReviewRequest extends ServiceRequest {
  readonly repository: string;
  readonly start: ReviewStart;
}

export interface BranchesRequest extends ServiceRequest {
  readonly actions: BranchActions;
  /**
   * Runs `pr create` for `head` in the plain terminal (editor, push prompt) while
   * the TUI is closed. Returns the PR to review, or why there is none.
   */
  createPullRequest(head: string): Promise<{ pullRequestId: string } | { message: string }>;
}

function service(request: ServiceRequest): ReviewService {
  return openReviewService(
    {
      ...(request.region ? { region: request.region } : {}),
      ...(request.profile ? { profile: request.profile } : {}),
    },
    request.git,
  );
}

export async function openReview(request: ReviewRequest): Promise<void> {
  const app = render(
    <App service={service(request)} repository={request.repository} start={request.start} />,
  );
  await app.waitUntilExit();
}

/** The branch table; leaves the TUI for `n` and comes back on the new PR (spec: PR 作成). */
export async function openBranches(request: BranchesRequest): Promise<void> {
  const reviews = service(request);
  let start: BranchesStart = null;
  for (;;) {
    let head: string | undefined;
    const app = render(
      <BranchesApp
        actions={request.actions}
        service={reviews}
        start={start}
        onCreate={(name) => {
          head = name;
        }}
      />,
    );
    await app.waitUntilExit();
    if (head === undefined) return;
    const outcome = await request.createPullRequest(head);
    start = "pullRequestId" in outcome ? { reviewPullRequestId: outcome.pullRequestId } : outcome;
  }
}

export interface BrowseRequest {
  readonly actions: BrowseActions;
  readonly path: string;
}

/** The remote tree and files through the API only (spec: clone なしブラウズ). */
export async function openBrowse(request: BrowseRequest): Promise<void> {
  const app = render(<BrowseApp actions={request.actions} path={request.path} />);
  await app.waitUntilExit();
}
