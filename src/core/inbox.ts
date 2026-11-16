import { createHash } from "node:crypto";
import type { CodeCommitApi, PullRequest, RuleEvaluation } from "../aws/codecommit.js";
import { mapLimit } from "../aws/mapLimit.js";
import type { Config } from "../state/config.js";
import { type IdentityStore, lastSeen } from "../state/local.js";
import { type CheckState, checksFor, type RepositoryRuns } from "./checks.js";
import { OPEN_SCAN_LIMIT } from "./pr.js";

export type Section = "awaiting" | "mine";

export interface InboxItem {
  readonly section: Section;
  readonly pr: PullRequest;
  readonly unread: boolean;
  /** Who approved this revision. Loaded after the list for "awaiting" items. */
  readonly approvedBy?: readonly string[];
  /** Loaded after the list for "mine" items. */
  readonly rules?: RuleEvaluation;
  readonly mergeable?: boolean;
  /** CI on the source commit, for "mine" items in a repository the config's ci lists (ADR 0010). */
  readonly checks?: CheckState;
  /** Why the details above could not be loaded. */
  readonly detailError?: string;
}

interface RepoError {
  readonly repository: string;
  readonly error: Error;
}

export interface Inbox {
  readonly me: string;
  readonly repositories: readonly string[];
  /** "awaiting" first, then "mine", each most recently active first. */
  readonly items: readonly InboxItem[];
  /** Repositories (or PRs in them) that could not be read; the rest still show. */
  readonly errors: readonly RepoError[];
  readonly fetchedAt: Date;
}

/**
 * Which repositories the inbox covers (spec: 監視対象): --repo, then the
 * config's repos, then the clone we are in. Undefined means "ask the user"
 * (the repository picker in the TUI, an error in `lazycc status`).
 */
export function watchedRepositories(
  flagRepo: string | undefined,
  config: Config,
  cloneRepo: string | undefined,
): readonly string[] | undefined {
  if (flagRepo) return [flagRepo];
  if (config.repos?.length) return config.repos;
  return cloneRepo ? [cloneRepo] : undefined;
}

/**
 * The caller's ARN, cached per set of credentials (spec: 認証): a profile whose
 * role or account changes gets new credentials, so it is asked again. The key
 * is a hash, so the state file never holds an access key ID.
 */
export async function resolveMe(
  api: Pick<CodeCommitApi, "callerArn" | "credentialId">,
  store: IdentityStore,
): Promise<string> {
  const id = await api.credentialId().catch(() => undefined);
  // Without credentials STS fails too, with the error worth showing.
  if (id === undefined) return api.callerArn();
  const key = `cred:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
  const cached = await store.get(key);
  if (cached) return cached;
  const arn = await api.callerArn();
  // A failed write only costs one more STS call next time.
  await store.set(key, arn).catch(() => {});
  return arn;
}

/**
 * `*` and `?` wildcard match without building a RegExp from the pattern: the
 * patterns come from other people's approval rules, and a regex of many `.*`
 * can backtrack for a long time. Greedy with one backtrack point, O(n·m) worst case.
 */
function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Whether `me` can count toward an approval pool member. Members are either
 * ARN patterns with * and ?, or `CodeCommitApprovers:<account>:<name>`, which
 * names an IAM user or a role session in that account. Unknown forms return
 * undefined so the caller can keep the PR (ADR 0005).
 */
function matchesMember(member: string, me: string): boolean | undefined {
  if (member.startsWith("arn:")) return globMatch(member, me);
  const short = /^CodeCommitApprovers:(\d+):(.+)$/.exec(member);
  if (!short) return undefined;
  const [, account, name] = short;
  const parts = me.split(":");
  if (parts[4] !== account) return false;
  // user/path/Name or assumed-role/Role/Session: compare the names after the type.
  return (parts.slice(5).join(":").split("/").slice(1) as string[]).includes(name as string);
}

/**
 * ADR 0005, condition 4: the PR has no approval rules, or `me` is in the pool
 * of at least one. A rule we cannot read keeps the PR: a spare row beats a
 * missed review.
 */
export function inApprovalPool(pr: PullRequest, me: string): boolean {
  if (pr.approvalRules.length === 0) return true;
  for (const rule of pr.approvalRules) {
    let statements: unknown;
    try {
      statements = (JSON.parse(rule.content) as { Statements?: unknown }).Statements;
    } catch {
      return true;
    }
    if (!Array.isArray(statements)) return true;
    for (const st of statements as { ApprovalPoolMembers?: unknown }[]) {
      const members = st?.ApprovalPoolMembers;
      // No pool means anyone with permission may approve; a pool we cannot read keeps the PR.
      if (!Array.isArray(members)) return true;
      for (const m of members) {
        if (typeof m !== "string") return true;
        if (matchesMember(m, me) !== false) return true;
      }
    }
  }
  return false;
}

/**
 * Unread when something happened after the user last opened the PR (ADR 0006).
 * A PR never opened is unread, except one's own: that one counts as seen when
 * it was created.
 */
export function isUnread(pr: PullRequest, seenAt: Date | undefined, me: string): boolean {
  const since = seenAt ?? (pr.authorArn === me ? pr.creationDate : undefined);
  return since === undefined || pr.lastActivityDate.getTime() > since.getTime();
}

/** ADR 0005, conditions 1, 2 and 4; condition 3 needs approvals, see `isPending`. */
export function classify(pr: PullRequest, me: string): Section | undefined {
  if (pr.status !== "OPEN") return undefined;
  if (pr.authorArn === me) return "mine";
  return inApprovalPool(pr, me) ? "awaiting" : undefined;
}

/** Whether the item still needs the user: an "awaiting" PR they approved drops out. */
export function isPending(item: InboxItem, me: string): boolean {
  return !(item.section === "awaiting" && item.approvedBy?.includes(me));
}

const rank = (s: Section) => (s === "awaiting" ? 0 : 1);

function sortItems(items: readonly InboxItem[]): InboxItem[] {
  return items.toSorted(
    (a, b) =>
      rank(a.section) - rank(b.section) ||
      b.pr.lastActivityDate.getTime() - a.pr.lastActivityDate.getTime(),
  );
}

export interface InboxDeps {
  readonly api: CodeCommitApi;
  readonly me: string;
  readonly region: string;
  readonly seen: ReadonlyMap<string, Date>;
  readonly concurrency: number;
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Lists open PRs across `repositories` and sorts them into the two sections,
 * without the per-PR details (`loadDetails`). A repository that fails is
 * reported in `errors`; if every one fails, the first error is thrown, since
 * that is almost always credentials or the region.
 */
export async function fetchInbox(watched: readonly string[], deps: InboxDeps): Promise<Inbox> {
  // A repository named twice in the config is still read once.
  const repositories = [...new Set(watched)];
  const errors: RepoError[] = [];
  const failed = new Set<string>();
  const fail = (repository: string, e: unknown) => {
    if (failed.has(repository)) return;
    failed.add(repository);
    errors.push({ repository, error: asError(e) });
  };
  const listed = await mapLimit(repositories, deps.concurrency, async (repository) => {
    try {
      const ids = await deps.api.listPullRequestIds(repository, "OPEN", OPEN_SCAN_LIMIT);
      return ids.map((id) => ({ repository, id }));
    } catch (e) {
      fail(repository, e);
      return [];
    }
  });
  if (repositories.length > 0 && failed.size === repositories.length) throw errors[0]?.error;
  // ListPullRequests returns ids only: one GetPullRequest each (spec: 取得とキャッシュ).
  const prs = await mapLimit(listed.flat(), deps.concurrency, async ({ repository, id }) => {
    try {
      return (await deps.api.getPullRequests([id], 1))[0];
    } catch (e) {
      // Merged or closed between the two calls: not an error worth showing.
      if ((e as Error).name !== "PullRequestDoesNotExistException") fail(repository, e);
      return undefined;
    }
  });
  const items: InboxItem[] = [];
  for (const pr of prs) {
    if (!pr) continue;
    const section = classify(pr, deps.me);
    if (!section) continue;
    items.push({
      section,
      pr,
      unread: isUnread(pr, lastSeen(deps.seen, deps.region, pr), deps.me),
    });
  }
  return {
    me: deps.me,
    repositories,
    items: sortItems(items),
    errors,
    fetchedAt: new Date(),
  };
}

/**
 * The calls each row needs beyond GetPullRequest: approvals for "awaiting"
 * (condition 3), rule evaluation, conflicts and CI for "mine".
 */
export async function loadDetails(
  item: InboxItem,
  api: Pick<CodeCommitApi, "approvers" | "evaluateApprovalRules" | "mergeable">,
  runs?: RepositoryRuns,
): Promise<InboxItem> {
  try {
    if (item.section === "awaiting") return { ...item, approvedBy: await api.approvers(item.pr) };
    const [rules, mergeable, ci] = await Promise.all([
      api.evaluateApprovalRules(item.pr),
      api.mergeable(item.pr),
      runs?.(item.pr.repository),
    ]);
    return {
      ...item,
      rules,
      mergeable,
      ...(ci ? { checks: checksFor(item.pr.sourceCommit, ci).state } : {}),
    };
  } catch (e) {
    return { ...item, detailError: asError(e).message };
  }
}

/** Loads every row's details, `limit` at a time, reporting each as it lands. */
export function loadAllDetails(
  items: readonly InboxItem[],
  load: (item: InboxItem) => Promise<InboxItem>,
  limit: number,
  onItem: (item: InboxItem) => void = () => {},
): Promise<InboxItem[]> {
  return mapLimit(items, limit, async (item) => {
    const loaded = await load(item);
    onItem(loaded);
    return loaded;
  });
}

// ---- Cache (cache.json, section "home") ----

/** The inbox is only reused for the same account, region and repositories. */
function cacheKey(me: string, region: string, repositories: readonly string[]): string {
  return JSON.stringify([me, region, [...new Set(repositories)].toSorted()]);
}

export function toCache(inbox: Inbox, region: string): unknown {
  return {
    key: cacheKey(inbox.me, region, inbox.repositories),
    fetchedAt: inbox.fetchedAt.toISOString(),
    items: inbox.items.map((item) => ({
      ...item,
      pr: {
        ...item.pr,
        creationDate: item.pr.creationDate.toISOString(),
        lastActivityDate: item.pr.lastActivityDate.toISOString(),
      },
    })),
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isRules(v: unknown): v is RuleEvaluation {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["approved"] === "boolean" &&
    typeof r["overridden"] === "boolean" &&
    isStringArray(r["satisfied"]) &&
    isStringArray(r["notSatisfied"])
  );
}

const CHECK_STATES = new Set<unknown>(["pass", "fail", "pending", "cancel", "none", "error"]);

function isCheckState(v: unknown): v is CheckState {
  return CHECK_STATES.has(v);
}

/** A saved date; anything but a string is an invalid date (new Date({toString: null}) throws). */
const dateOf = (v: unknown) => new Date(typeof v === "string" ? v : Number.NaN);

function parseItem(raw: unknown): InboxItem | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const pr = r["pr"] as Record<string, unknown> | undefined;
  if (r["section"] !== "awaiting" && r["section"] !== "mine") return undefined;
  if (typeof pr !== "object" || pr === null) return undefined;
  const creationDate = dateOf(pr["creationDate"]);
  const lastActivityDate = dateOf(pr["lastActivityDate"]);
  const strings = [
    "id",
    "title",
    "description",
    "status",
    "authorArn",
    "repository",
    "sourceBranch",
    "destinationBranch",
    "sourceCommit",
    "destinationCommit",
    "revisionId",
  ];
  if (
    strings.some((k) => typeof pr[k] !== "string") ||
    Number.isNaN(creationDate.getTime()) ||
    Number.isNaN(lastActivityDate.getTime()) ||
    !Array.isArray(pr["approvalRules"])
  )
    return undefined;
  const item: InboxItem = {
    section: r["section"],
    unread: r["unread"] === true,
    pr: { ...(pr as unknown as PullRequest), creationDate, lastActivityDate },
    ...(isStringArray(r["approvedBy"]) ? { approvedBy: r["approvedBy"] } : {}),
    ...(typeof r["mergeable"] === "boolean" ? { mergeable: r["mergeable"] } : {}),
    ...(isRules(r["rules"]) ? { rules: r["rules"] } : {}),
    ...(isCheckState(r["checks"]) ? { checks: r["checks"] } : {}),
  };
  return item;
}

/**
 * The cached inbox for `key`, or undefined when there is none, it is for other
 * repositories, or it does not parse (a bad cache is dropped, not an error).
 */
export function fromCache(
  raw: unknown,
  me: string,
  region: string,
  repositories: readonly string[],
): Inbox | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r["key"] !== cacheKey(me, region, repositories) || !Array.isArray(r["items"]))
    return undefined;
  const fetchedAt = dateOf(r["fetchedAt"]);
  if (Number.isNaN(fetchedAt.getTime())) return undefined;
  const items = r["items"].map(parseItem);
  if (items.some((i) => i === undefined)) return undefined;
  return { me, repositories, items: items as InboxItem[], errors: [], fetchedAt };
}

/** Recomputes the unread marks of a cached inbox against the current seen.json. */
export function withUnread(inbox: Inbox, region: string, seen: ReadonlyMap<string, Date>): Inbox {
  return {
    ...inbox,
    items: inbox.items.map((item) => ({
      ...item,
      unread: isUnread(item.pr, lastSeen(seen, region, item.pr), inbox.me),
    })),
  };
}
