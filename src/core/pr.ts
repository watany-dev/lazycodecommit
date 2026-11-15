import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  CodeCommitApi,
  PullRequest,
  PullRequestStatus,
  RuleEvaluation,
} from "../aws/codecommit.js";
import type { Git } from "../git/git.js";
import type { Config } from "../state/config.js";
import type { RepoContext } from "./context.js";
import {
  type Draft,
  draftFromCommits,
  fromEditorText,
  toEditorText,
  withTemplate,
} from "./draft.js";
import { UsageError, UserError } from "./errors.js";

const DEFAULT_TEMPLATE = ".codecommit/pull_request_template.md";
const DEFAULT_CONCURRENCY = 8;
/** How many open PRs to scan when looking one up by branch. */
const OPEN_SCAN_LIMIT = 1000;

export interface PrDeps {
  readonly git: Git;
  readonly api: CodeCommitApi;
  readonly ctx: RepoContext;
  readonly config: Config;
  /** stdin and stdout are a terminal, so we may prompt and open an editor. */
  readonly interactive: boolean;
  confirm(question: string): Promise<boolean>;
  edit(text: string): Promise<string>;
  /** File contents, or null when the file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Progress for the user, on stderr. */
  note(line: string): void;
}

export function consoleUrl(region: string | undefined, repository: string, id: string): string {
  const r = region ?? "us-east-1";
  return `https://${r}.console.aws.amazon.com/codesuite/codecommit/repositories/${encodeURIComponent(repository)}/pull-requests/${id}/details?region=${r}`;
}

function concurrency(config: Config): number {
  return config.concurrency ?? DEFAULT_CONCURRENCY;
}

/** The most recently active open PR from `head` (into `base`, when given). */
async function findOpenPullRequest(
  deps: Pick<PrDeps, "api" | "ctx" | "config">,
  head: string,
  base?: string,
): Promise<PullRequest | undefined> {
  const ids = await deps.api.listPullRequestIds(deps.ctx.repository, "OPEN", OPEN_SCAN_LIMIT);
  const prs = await deps.api.getPullRequests(ids, concurrency(deps.config));
  return prs
    .filter(
      (pr) => pr.sourceBranch === head && (base === undefined || pr.destinationBranch === base),
    )
    .toSorted((a, b) => b.lastActivityDate.getTime() - a.lastActivityDate.getTime())[0];
}

// ---------------------------------------------------------------- pr create

export interface CreateOptions {
  readonly base?: string;
  readonly head?: string;
  readonly title?: string;
  readonly body?: string;
  readonly bodyFile?: string;
  readonly fill: boolean;
  readonly push: boolean;
  readonly noPush: boolean;
  readonly dryRun: boolean;
}

export type CreateResult =
  | { readonly kind: "created"; readonly pr: PullRequest }
  | { readonly kind: "exists"; readonly pr: PullRequest }
  | {
      readonly kind: "dry-run";
      readonly repository: string;
      readonly head: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
      readonly wouldPush: boolean;
    };

export async function createPullRequest(opts: CreateOptions, deps: PrDeps): Promise<CreateResult> {
  const { git, api, ctx } = deps;
  if (opts.push && opts.noPush)
    throw new UsageError("--push and --no-push cannot be used together");
  if (opts.body !== undefined && opts.bodyFile !== undefined) {
    throw new UsageError("--body and --body-file cannot be used together");
  }
  const explicitBody =
    opts.bodyFile !== undefined ? await readBodyFile(opts.bodyFile, deps) : opts.body;
  const useEditor = !opts.fill && (opts.title === undefined || explicitBody === undefined);
  if (useEditor && !deps.interactive) {
    throw new UsageError(
      "Not a terminal: pass --fill, or both --title and --body, to create without an editor",
    );
  }

  const clone = ctx.clone;
  let head = opts.head;
  if (head === undefined) {
    if (!clone) throw new UsageError("--head is required outside a clone of the repository");
    const current = await git.currentBranch();
    if (current === null)
      throw new UserError("HEAD is detached. Switch to a branch, or pass --head.");
    head = current;
  }

  const base = opts.base ?? (await api.defaultBranch(ctx.repository));
  if (!base) throw new UserError(`${ctx.repository} has no default branch. Pass --base.`);
  if (base === head) {
    throw new UserError(
      `The head branch is the base branch (${base}). Switch to a work branch, or pass --head.`,
    );
  }

  const existing = await findOpenPullRequest(deps, head, base);
  if (existing) return { kind: "exists", pr: existing };

  let draft: Draft;
  let wouldPush = false;
  let sourceCommit: string;
  if (clone) {
    const headCommit = await git.resolveCommit(`refs/heads/${head}`);
    if (headCommit === null) throw new UserError(`No local branch named ${head}.`);
    sourceCommit = headCommit;
    const baseRef = await localBaseRef(git, base);
    const commits = await git.commits(baseRef, `refs/heads/${head}`);
    if (commits.length === 0)
      throw new UserError(`${head} has no commits that ${baseRef} does not have.`);

    const unpushed = await git.unpushedCount(head);
    if (unpushed === null || unpushed > 0) {
      wouldPush = true;
      if (!opts.dryRun) await pushIfAllowed(head, unpushed, opts, deps);
    }
    draft = withTemplate(draftFromCommits(head, commits), await readTemplate(clone.root, deps));
  } else {
    const remoteCommit = await api.branchCommit(ctx.repository, head);
    if (remoteCommit === undefined)
      throw new UserError(`${ctx.repository} has no branch named ${head}.`);
    sourceCommit = remoteCommit;
    draft = { title: head, body: "" };
  }

  draft = { title: opts.title ?? draft.title, body: explicitBody ?? draft.body };
  if (useEditor) draft = fromEditorText(await deps.edit(toEditorText(draft)));
  if (draft.title.trim() === "") throw new UserError("Aborted: the title is empty.");

  if (opts.dryRun) {
    return {
      kind: "dry-run",
      repository: ctx.repository,
      head,
      base,
      title: draft.title,
      body: draft.body,
      wouldPush,
    };
  }
  const pr = await api.createPullRequest({
    repository: ctx.repository,
    title: draft.title,
    description: draft.body,
    sourceBranch: head,
    destinationBranch: base,
    clientRequestToken: requestToken(ctx.repository, head, base, sourceCommit, draft),
  });
  return { kind: "created", pr };
}

/**
 * Same branch tip and same text give the same token, so a rerun after a lost
 * response returns the PR that was already made instead of a second one.
 */
export function requestToken(
  repository: string,
  head: string,
  base: string,
  commit: string,
  draft: Draft,
): string {
  return createHash("sha256")
    .update([repository, head, base, commit, draft.title, draft.body].join("\0"))
    .digest("hex");
}

async function readBodyFile(path: string, deps: PrDeps): Promise<string> {
  const text = await deps.readFile(path);
  if (text === null) throw new UserError(`--body-file: ${path} does not exist`);
  return text.trim();
}

async function readTemplate(root: string, deps: PrDeps): Promise<string | undefined> {
  const path = deps.config.pr?.template ?? DEFAULT_TEMPLATE;
  return (await deps.readFile(isAbsolute(path) ? path : join(root, path))) ?? undefined;
}

/** Prefer origin/<base>: the local base branch is often behind or absent. */
async function localBaseRef(git: Git, base: string): Promise<string> {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    if ((await git.resolveCommit(ref)) !== null) return ref.replace(/^refs\/(remotes|heads)\//, "");
  }
  throw new UserError(
    `The base branch ${base} is not in this clone. Run \`git fetch origin ${base}\`.`,
  );
}

async function pushIfAllowed(
  head: string,
  unpushed: number | null,
  opts: CreateOptions,
  deps: PrDeps,
): Promise<void> {
  const why =
    unpushed === null ? `${head} has no upstream` : `${head} has ${unpushed} unpushed commit(s)`;
  if (opts.noPush) throw new UserError(`${why}, and --no-push was given.`);
  if (!opts.push) {
    if (!deps.interactive) throw new UserError(`${why}. Pass --push to push it to origin.`);
    if (!(await deps.confirm(`${why}. Push it to origin?`)))
      throw new UserError("Aborted: the branch was not pushed.");
  }
  deps.note(`Pushing ${head} to origin...`);
  try {
    await deps.git.push(head);
  } catch (error) {
    // git has already printed its own error on stderr.
    throw new UserError(`git push failed: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------- pr list / view / status

export async function listPullRequests(
  opts: { readonly state: PullRequestStatus; readonly limit: number },
  deps: Pick<PrDeps, "api" | "ctx" | "config">,
): Promise<PullRequest[]> {
  const ids = await deps.api.listPullRequestIds(deps.ctx.repository, opts.state, opts.limit);
  const prs = await deps.api.getPullRequests(ids, concurrency(deps.config));
  return prs.toSorted((a, b) => b.lastActivityDate.getTime() - a.lastActivityDate.getTime());
}

/** The PR by id, or the open PR of the current branch when `id` is omitted. */
export async function resolvePullRequest(
  id: string | undefined,
  deps: Pick<PrDeps, "api" | "ctx" | "config" | "git">,
): Promise<PullRequest> {
  if (id !== undefined) {
    if (!/^\d+$/.test(id)) throw new UsageError(`Not a pull request id: ${id}`);
    const [pr] = await deps.api.getPullRequests([id], 1);
    return pr as PullRequest;
  }
  const branch = await currentBranchOfClone(deps);
  const pr = await findOpenPullRequest(deps, branch);
  if (!pr) throw new UserError(`No open pull request from ${branch} in ${deps.ctx.repository}.`);
  return pr;
}

async function currentBranchOfClone(deps: Pick<PrDeps, "ctx" | "git">): Promise<string> {
  if (!deps.ctx.clone)
    throw new UsageError("Not in a clone of the repository: pass a pull request id");
  const branch = await deps.git.currentBranch();
  if (branch === null)
    throw new UserError("HEAD is detached. Switch to a branch, or pass a pull request id.");
  return branch;
}

export interface PrStatus {
  readonly branch: string;
  readonly pr?: PullRequest;
  readonly approvers?: readonly string[];
  readonly rules?: RuleEvaluation;
  readonly mergeable?: boolean;
}

export async function pullRequestStatus(
  deps: Pick<PrDeps, "api" | "ctx" | "config" | "git">,
): Promise<PrStatus> {
  if (!deps.ctx.clone) throw new UsageError("pr status works inside a clone of the repository");
  const branch = await currentBranchOfClone(deps);
  const pr = await findOpenPullRequest(deps, branch);
  if (!pr) return { branch };
  const [approvers, rules, mergeable] = await Promise.all([
    deps.api.approvers(pr),
    deps.api.evaluateApprovalRules(pr),
    deps.api.mergeable(pr),
  ]);
  return { branch, pr, approvers, rules, mergeable };
}
