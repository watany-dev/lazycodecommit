import type { CodeCommitApi, PullRequest } from "../aws/codecommit.js";
import { type Config, saveRepos } from "../state/config.js";
import { type LocalState, markSeen, type SeenPr } from "../state/local.js";
import {
  fetchInbox,
  fromCache,
  type Inbox,
  type InboxItem,
  loadDetails,
  toCache,
  withUnread,
} from "./inbox.js";
import { concurrency, consoleUrl } from "./pr.js";

/** What the home screen does (spec: ホーム), bound to one account and region. */
export interface HomeActions {
  readonly region: string;
  readonly me: string;
  readonly concurrency: number;
  /** The repositories to start on; undefined opens the repository picker. */
  readonly initial: readonly string[] | undefined;
  /** The config's repos as last loaded or saved. */
  watched(): readonly string[];
  /** The last result for exactly these repositories, with fresh unread marks. */
  cached(repositories: readonly string[]): Promise<Inbox | undefined>;
  fetch(repositories: readonly string[]): Promise<Inbox>;
  details(item: InboxItem): Promise<InboxItem>;
  /** Saves a complete inbox (details loaded) for the next start. */
  save(inbox: Inbox): Promise<void>;
  /** Re-reads seen.json and returns what re-marks an inbox: back from a review. */
  unreadMarker(): Promise<(inbox: Inbox) => Inbox>;
  /** Marks a PR read now (spec: レビュー画面を開いた時点で既読). */
  markSeen(pr: SeenPr): void;
  listRepositories(): Promise<string[]>;
  /** Adds or removes `repository` in the config's repos; returns the new list. */
  toggleWatch(repository: string): Promise<readonly string[]>;
  consoleUrl(pr: PullRequest): string;
}

export interface HomeDeps {
  readonly api: CodeCommitApi;
  readonly state: LocalState;
  readonly config: Config;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly region: string;
  readonly me: string;
  readonly initial: readonly string[] | undefined;
}

export function homeActions(deps: HomeDeps): HomeActions {
  const { api, state, region, me } = deps;
  const limit = concurrency(deps.config);
  let watched: readonly string[] = deps.config.repos ?? [];
  // The picker opens often and a region can hold hundreds of repositories.
  let listing: Promise<string[]> | undefined;
  return {
    region,
    me,
    concurrency: limit,
    initial: deps.initial,
    watched: () => watched,
    async cached(repositories) {
      const inbox = fromCache(await state.cache.get("home"), me, region, repositories);
      return inbox && withUnread(inbox, region, await state.seen.all());
    },
    async fetch(repositories) {
      return fetchInbox(repositories, {
        api,
        me,
        region,
        seen: await state.seen.all(),
        concurrency: limit,
      });
    },
    details: (item) => loadDetails(item, api),
    // Only a faster next start depends on the cache.
    save: (inbox) => state.cache.set("home", toCache(inbox, region)).catch(() => {}),
    async unreadMarker() {
      const seen = await state.seen.all();
      return (inbox) => withUnread(inbox, region, seen);
    },
    markSeen(pr) {
      // Losing one mark only leaves a PR marked unread.
      markSeen(state, region, pr, new Date()).catch(() => {});
    },
    listRepositories() {
      listing ??= api.listRepositories();
      // A failed listing is retried on the next open.
      listing.catch(() => {
        listing = undefined;
      });
      return listing;
    },
    async toggleWatch(repository) {
      const next = watched.includes(repository)
        ? watched.filter((r) => r !== repository)
        : [...watched, repository];
      await saveRepos(deps.env, next);
      watched = next;
      return next;
    },
    consoleUrl: (pr) => consoleUrl(region, pr.repository, pr.id),
  };
}
