import { type Instance, render } from "ink";
import type { ReactNode } from "react";
import type { BranchActions } from "../core/branch.js";
import type { BrowseActions } from "../core/browse.js";
import type { DraftStorage } from "../core/commentDrafts.js";
import type { HomeActions } from "../core/home.js";
import { type MergeStrategy, openReviewService, type ReviewService } from "../core/review.js";
import type { Git } from "../git/git.js";
import { BranchesApp, type BranchesStart } from "./BranchesApp.js";
import { BrowseApp } from "./BrowseApp.js";
import { HomeApp } from "./HomeApp.js";
import { PickScreen } from "./PickScreen.js";
import { App, type ReviewStart } from "./ReviewApp.js";
import type { TopSwitch, TopView } from "./top.js";

// This module is loaded with a dynamic import, so CLI subcommands never load Ink or React.

interface ServiceRequest {
  readonly region?: string;
  readonly profile?: string;
  /** Set inside a clone of the repository: diffs then come from git. */
  readonly git?: Git;
  /** Called when a PR is opened or left, for the home screen's unread marks. */
  readonly markSeen?: (pullRequestId: string) => void;
  /** The config's pr.mergeOption, preselected in the merge dialog. */
  readonly mergeStrategy?: MergeStrategy;
  /** drafts.json: unposted review comments survive leaving the screen. */
  readonly drafts?: DraftStorage;
}

export interface ReviewRequest extends ServiceRequest {
  readonly repository: string;
  readonly start: ReviewStart;
}

export interface BranchesView {
  readonly actions: BranchActions;
  /**
   * Runs `pr create` for `head` in the plain terminal (editor, push prompt) while
   * the TUI is closed. Returns the PR to review, or why there is none.
   */
  createPullRequest(head: string): Promise<{ pullRequestId: string } | { message: string }>;
}

/** Builds each view for a repository; cli/main.ts binds them to the account. */
export interface TopViews {
  home(): Promise<HomeActions>;
  branches(repository: string): BranchesView;
  browse(repository: string): Promise<BrowseActions>;
}

/** spec: 画面遷移. The three top-level views and the repository they show. */
export interface TopRequest extends ServiceRequest {
  readonly start: TopView;
  /**
   * The account home reads the config's repositories in, when it is not the
   * clone's (lazycc branch or browse in a clone of another region or profile).
   */
  readonly home?: Pick<ServiceRequest, "region" | "profile" | "markSeen">;
  /** The repository the branch table and browse show; picked with r when unset. */
  readonly repository?: string;
  /** The clone's repository: only its PRs take their diffs from `git`. */
  readonly cloneRepository?: string;
  /** Where browse opens the first time (--path). */
  readonly browsePath?: string;
  readonly views: TopViews;
}

function service(request: ServiceRequest): ReviewService {
  const s = openReviewService(
    {
      ...(request.region ? { region: request.region } : {}),
      ...(request.profile ? { profile: request.profile } : {}),
    },
    request.git,
  );
  return {
    ...s,
    ...(request.markSeen ? { markSeen: request.markSeen } : {}),
    ...(request.mergeStrategy ? { mergeStrategy: request.mergeStrategy } : {}),
    ...(request.drafts ? { drafts: request.drafts } : {}),
  };
}

export async function openReview(request: ReviewRequest): Promise<void> {
  const app = render(
    <App service={service(request)} repository={request.repository} start={request.start} />,
  );
  await app.waitUntilExit();
}

/**
 * Runs the top-level views one render at a time: a view that wants another
 * view, the picker, or the plain terminal (pr create) exits, and this loop
 * renders what comes next. The views keep no state across a switch; home
 * starts again from its cache.
 */
export async function openTop(request: TopRequest): Promise<void> {
  const { git, cloneRepository, views, home, ...rest } = request;
  const base = { ...rest };
  const withGit = git ? service({ ...base, git }) : undefined;
  const withoutGit = service(base);
  const reviewService = (repository: string) =>
    withGit && repository === cloneRepository ? withGit : withoutGit;
  const homeService =
    home &&
    service({ ...(rest.mergeStrategy ? { mergeStrategy: rest.mergeStrategy } : {}), ...home });
  const homeReviewService = homeService ? () => homeService : reviewService;

  let view = request.start;
  let repository = request.repository;
  let browsePath = request.browsePath ?? "";
  let branchesStart: BranchesStart = null;
  let note: string | null = null;
  /** Where q from the picker returns to; none means the picker was the start. */
  let previous: TopView | null = null;
  let screen: Instance | undefined;
  const run = async (node: ReactNode) => {
    screen = render(node);
    await screen.waitUntilExit();
  };
  // Ink leaves a view's last frame on exit; the next view replaces it instead.
  const clearScreen = () => screen?.clear();

  for (;;) {
    let next: TopSwitch | undefined;
    const onSwitch = (s: TopSwitch) => {
      next = s;
      clearScreen();
    };
    if (view !== "home" && repository === undefined) next = { pick: true };
    else if (view === "home") {
      const actions = await views.home();
      await run(
        <HomeApp
          actions={actions}
          reviewService={homeReviewService}
          note={note}
          onSwitch={onSwitch}
          onRepository={(r) => {
            repository = r;
          }}
        />,
      );
    } else if (view === "branches") {
      const branches = views.branches(repository as string);
      let head: string | undefined;
      await run(
        <BranchesApp
          actions={branches.actions}
          service={reviewService(repository as string)}
          start={branchesStart ?? (note ? { message: note } : null)}
          onCreate={(name) => {
            head = name;
          }}
          onSwitch={onSwitch}
        />,
      );
      branchesStart = null;
      if (head !== undefined) {
        const outcome = await branches.createPullRequest(head);
        branchesStart =
          "pullRequestId" in outcome ? { reviewPullRequestId: outcome.pullRequestId } : outcome;
        note = null;
        continue;
      }
    } else {
      let actions: BrowseActions;
      try {
        actions = await views.browse(repository as string);
      } catch (err) {
        // An empty repository has no default branch to open.
        if (previous === null && request.start === "browse") throw err;
        note = err instanceof Error ? err.message : String(err);
        view = previous ?? "home";
        continue;
      }
      const path = browsePath;
      browsePath = "";
      await run(<BrowseApp actions={actions} path={path} onSwitch={onSwitch} />);
    }
    note = null;
    const asked = next as TopSwitch | undefined;
    if (!asked) return;
    if ("view" in asked) {
      previous = view;
      view = asked.view;
      continue;
    }
    let picked: string | undefined;
    await run(
      <PickScreen
        actions={await views.home()}
        current={repository}
        reviewService={homeReviewService}
        onDone={(r) => {
          picked = r;
          clearScreen();
        }}
      />,
    );
    if (picked) repository = picked;
    else if (repository === undefined) {
      // q from a picker nothing was picked in: back where we came from, or out.
      if (previous === null) return;
      view = previous;
    }
  }
}
