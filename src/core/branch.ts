import type { CodeCommitApi, RuleEvaluation } from "../aws/codecommit.js";
import { mapLimit } from "../aws/mapLimit.js";
import type { Git } from "../git/git.js";
import type { Config } from "../state/config.js";
import type { RepoContext } from "./context.js";
import { UserError } from "./errors.js";
import {
  concurrency as concurrencyOf,
  listPullRequests,
  OPEN_SCAN_LIMIT,
  repositoryConsoleUrl,
} from "./pr.js";

const DEFAULT_CLOSED_LOOKBACK = 100;

/** spec: 状態の判定. */
type BranchState = "open" | "merged" | "none";

export interface BranchRow {
  readonly name: string;
  readonly isDefault: boolean;
  readonly tip: string;
  readonly state: BranchState;
  /** The open PR, or for a merged branch the PR that merged it. */
  readonly pr?: { readonly id: string; readonly title: string };
  /** Approval rules of the open PR. */
  readonly rules?: RuleEvaluation;
  /** Against the default branch; clone only. */
  readonly ahead?: number;
  readonly behind?: number;
  /** Clone only. */
  readonly lastCommit?: { readonly date: Date; readonly author: string };
}

export interface BranchTable {
  readonly repository: string;
  readonly defaultBranch?: string;
  readonly rows: readonly BranchRow[];
}

export interface BranchDeps {
  readonly api: CodeCommitApi;
  readonly git: Git;
  readonly ctx: RepoContext;
  readonly config: Config;
}

interface Branch {
  readonly name: string;
  readonly tip: string;
  readonly lastCommit?: { readonly date: Date; readonly author: string };
}

/**
 * The branch × PR table (spec: ブランチ×PR 対応表). Inside a clone the branches,
 * tips and dates come from origin's remote-tracking refs; outside, from the API.
 */
export async function loadBranchTable(deps: BranchDeps): Promise<BranchTable> {
  const { api, git, ctx, config } = deps;
  const concurrency = concurrencyOf(config);
  const [defaultBranch, branches, open, closed] = await Promise.all([
    api.defaultBranch(ctx.repository),
    listBranches(deps, concurrency),
    listPullRequests({ state: "OPEN", limit: OPEN_SCAN_LIMIT }, deps),
    listPullRequests(
      { state: "CLOSED", limit: config.branch?.closedPrLookback ?? DEFAULT_CLOSED_LOOKBACK },
      deps,
    ),
  ]);

  const rows = await mapLimit(branches, concurrency, async (b): Promise<BranchRow> => {
    const isDefault = b.name === defaultBranch;
    const openPr = open.find((pr) => pr.sourceBranch === b.name);
    // By PR data, not `git branch --merged`, which misses squash merges. A
    // branch that gained commits after its merge counts as having no PR again.
    const merged = openPr
      ? undefined
      : closed.find((pr) => pr.isMerged && pr.sourceBranch === b.name && pr.sourceCommit === b.tip);
    const pr = openPr ?? merged;
    const [rules, counts] = await Promise.all([
      openPr ? api.evaluateApprovalRules(openPr) : undefined,
      ctx.clone && defaultBranch && !isDefault
        ? git
            .aheadBehind(`refs/remotes/origin/${defaultBranch}`, `refs/remotes/origin/${b.name}`)
            // The default branch is not fetched into this clone: leave the column empty.
            .catch(() => undefined)
        : undefined,
    ]);
    return {
      name: b.name,
      isDefault,
      tip: b.tip,
      state: openPr ? "open" : merged ? "merged" : "none",
      ...(pr ? { pr: { id: pr.id, title: pr.title } } : {}),
      ...(rules ? { rules } : {}),
      ...counts,
      ...(b.lastCommit ? { lastCommit: b.lastCommit } : {}),
    };
  });

  rows.sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      (b.lastCommit?.date.getTime() ?? 0) - (a.lastCommit?.date.getTime() ?? 0) ||
      a.name.localeCompare(b.name),
  );
  return {
    repository: ctx.repository,
    ...(defaultBranch ? { defaultBranch } : {}),
    rows,
  };
}

async function listBranches(deps: BranchDeps, concurrency: number): Promise<Branch[]> {
  if (deps.ctx.clone) {
    return (await deps.git.remoteBranches()).map((b) => ({
      name: b.name,
      tip: b.tip,
      lastCommit: { date: b.date, author: b.author },
    }));
  }
  const names = await deps.api.listBranches(deps.ctx.repository);
  const tips = await mapLimit(names, concurrency, (name) =>
    deps.api.branchCommit(deps.ctx.repository, name),
  );
  // A branch deleted between the two calls has no tip; drop it.
  return names.flatMap((name, i) => (tips[i] ? [{ name, tip: tips[i] }] : []));
}

/** Deletes the branch on CodeCommit only; local branches are left alone (spec: 操作). */
export async function deleteRemoteBranch(row: BranchRow, deps: BranchDeps): Promise<void> {
  if (row.isDefault) throw new UserError(`${row.name} is the default branch.`);
  if (row.state === "open") {
    throw new UserError(`${row.name} has an open pull request (#${row.pr?.id}).`);
  }
  // The row can be minutes old: re-read the branch so the delete never drops
  // commits pushed since, or the source of a PR opened since.
  const { api, ctx } = deps;
  const tip = await api.branchCommit(ctx.repository, row.name);
  if (tip === undefined) throw new UserError(`${row.name} no longer exists on CodeCommit.`);
  if (tip !== row.tip) {
    throw new UserError(
      `${row.name} has moved since it was listed (now ${tip.slice(0, 7)}). Refresh and try again.`,
    );
  }
  const open = await listPullRequests({ state: "OPEN", limit: OPEN_SCAN_LIMIT }, deps);
  const pr = open.find((p) => p.sourceBranch === row.name);
  if (pr) throw new UserError(`${row.name} has an open pull request (#${pr.id}).`);
  await api.deleteBranch(ctx.repository, row.name);
  if (deps.ctx.clone) {
    // Drop origin/<branch> too, or the table keeps showing it. Best effort: the
    // branch is already gone, and the next fetch would prune it anyway.
    await deps.git.fetch(["--prune"], { quiet: true }).catch(() => undefined);
  }
}

export function branchConsoleUrl(region: string, repository: string, branch: string): string {
  const path = branch.split("/").map(encodeURIComponent).join("/");
  return repositoryConsoleUrl(region, repository, `browse/refs/heads/${path}`);
}

export const STATE_LABEL: Record<BranchState, string> = {
  open: "PR",
  merged: "merged",
  none: "-",
};

/** The approval rules of a row's PR in a few characters, "" when it has none. */
export function rulesSummary(rules: RuleEvaluation | undefined): string {
  if (!rules) return "";
  if (rules.overridden) return "rules overridden";
  const total = rules.satisfied.length + rules.notSatisfied.length;
  if (total === 0) return "";
  return `${rules.approved ? "✓" : "✗"} ${rules.satisfied.length}/${total} rules`;
}

/** What the branch screen does, bound to one repository. */
export interface BranchActions {
  readonly repository: string;
  /** `fetch` first runs `git fetch --prune origin` inside a clone (Ctrl+r). */
  load(opts: { readonly fetch: boolean }): Promise<BranchTable>;
  deleteBranch(row: BranchRow): Promise<void>;
  /** `git switch`; inside a clone only. */
  readonly switchBranch?: (row: BranchRow) => Promise<void>;
  consoleUrl(branch: string): string;
}

export function branchActions(deps: BranchDeps, region: string): BranchActions {
  const { git, ctx } = deps;
  return {
    repository: ctx.repository,
    async load({ fetch }) {
      if (fetch && ctx.clone) await git.fetch(["--prune"], { quiet: true });
      return loadBranchTable(deps);
    },
    deleteBranch: (row) => deleteRemoteBranch(row, deps),
    ...(ctx.clone
      ? {
          async switchBranch(row: BranchRow) {
            // A branch only on origin is named outright: git's guess refuses
            // when another remote has a branch of the same name.
            const local = (await git.resolveCommit(`refs/heads/${row.name}`)) !== null;
            await git.switchBranch(
              row.name,
              local ? { quiet: true } : { track: `refs/remotes/origin/${row.name}`, quiet: true },
            );
          },
        }
      : {}),
    consoleUrl: (branch) => branchConsoleUrl(region, ctx.repository, branch),
  };
}
