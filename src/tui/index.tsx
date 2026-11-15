import { render } from "ink";
import { openReviewService } from "../core/review.js";
import type { Git } from "../git/git.js";
import { App, type ReviewStart } from "./ReviewApp.js";

export interface ReviewRequest {
  readonly repository: string;
  readonly start: ReviewStart;
  readonly region?: string;
  readonly profile?: string;
  /** Set inside a clone of the repository: diffs then come from git. */
  readonly git?: Git;
}

/** Loaded with a dynamic import, so CLI subcommands never load Ink or React. */
export async function openReview(request: ReviewRequest): Promise<void> {
  const service = openReviewService(
    {
      ...(request.region ? { region: request.region } : {}),
      ...(request.profile ? { profile: request.profile } : {}),
    },
    request.git,
  );
  const app = render(
    <App service={service} repository={request.repository} start={request.start} />,
  );
  await app.waitUntilExit();
}
