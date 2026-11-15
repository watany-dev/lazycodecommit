import { randomUUID } from "node:crypto";
import { explainAwsError, isCredentialError } from "../aws/errors.js";
import { type LocalState, seenKey } from "../state/local.js";

/** The commits a comment is posted against: the PR's destination and source tips. */
export interface Commits {
  readonly beforeCommitId: string;
  readonly afterCommitId: string;
}

export interface DraftLocation {
  readonly filePath: string;
  readonly filePosition: number;
  readonly relativeFileVersion: "BEFORE" | "AFTER";
  /** The line as it read when the draft was written, to notice that it moved. */
  readonly lineText: string;
}

export type DraftTarget =
  | { readonly kind: "general" }
  | { readonly kind: "inline"; readonly location: DraftLocation }
  | {
      readonly kind: "reply";
      readonly inReplyTo: string;
      /** For the draft list only: who and what is being answered. */
      readonly replyTo: { readonly author: string; readonly excerpt: string };
    };

/**
 * failed: CodeCommit refused it, so it was not posted. unknown: no answer came
 * back, so it may have been posted; only a retry with the same token and
 * commits tells. moved: the PR's tip moved and the commented line is no
 * longer where the draft points.
 */
export interface DraftProblem {
  readonly kind: "failed" | "unknown" | "moved";
  readonly message: string;
}

export interface CommentDraft extends Commits {
  readonly id: string;
  /** clientRequestToken: the same token and parameters return the first post. */
  readonly token: string;
  readonly content: string;
  readonly createdAt: string;
  readonly target: DraftTarget;
  /** The commits the token was last sent with. */
  readonly sent?: Commits;
  readonly problem?: DraftProblem;
}

export function newDraft(
  content: string,
  target: DraftTarget,
  commits: Commits,
  now: Date = new Date(),
): CommentDraft {
  return {
    id: randomUUID(),
    token: randomUUID(),
    content,
    createdAt: now.toISOString(),
    target,
    beforeCommitId: commits.beforeCommitId,
    afterCommitId: commits.afterCommitId,
  };
}

/** A draft whose last send got no answer cannot change until a retry settles it. */
export function canEdit(draft: CommentDraft): boolean {
  return draft.problem?.kind !== "unknown";
}

/** New content, new token: the old token may have been sent with the old content. */
export function editDraft(draft: CommentDraft, content: string): CommentDraft {
  if (!canEdit(draft)) throw new Error("This draft may already be posted. Submit it again first.");
  const { sent: _sent, problem: _problem, ...rest } = draft;
  return { ...rest, content, token: randomUUID() };
}

/** The user saw the moved line and wants it posted at the same position anyway. */
export function postAnyway(draft: CommentDraft, tip: Commits): CommentDraft {
  if (draft.problem?.kind !== "moved") return draft;
  const { problem: _problem, ...rest } = draft;
  return { ...rest, ...tip };
}

const sameCommits = (a: Commits, b: Commits) =>
  a.beforeCommitId === b.beforeCommitId && a.afterCommitId === b.afterCommitId;

/**
 * Moves drafts written on an older tip onto `tip`. CodeCommit posts against
 * the current tip only (afterCommitId), so an inline draft whose line no
 * longer reads the same at its position is marked moved rather than posted on
 * whatever line is there now. `lineAt` reads a position on the new tip.
 */
export function reanchor(
  drafts: readonly CommentDraft[],
  tip: Commits,
  lineAt: (location: DraftLocation) => string | undefined,
): CommentDraft[] {
  return drafts.map((d) => {
    if (sameCommits(d, tip) || d.problem?.kind === "unknown" || d.problem?.kind === "moved") {
      return d;
    }
    if (d.target.kind === "inline" && lineAt(d.target.location) !== d.target.location.lineText) {
      return {
        ...d,
        problem: {
          kind: "moved",
          message: "The pull request has new commits and this line changed.",
        },
      };
    }
    return { ...d, ...tip };
  });
}

type Blob = { readonly blobId?: string | undefined; readonly path?: string | undefined };
interface ChangedFile {
  readonly beforeBlob?: Blob | undefined;
  readonly afterBlob?: Blob | undefined;
}

/**
 * For reanchor: reads, on the new tip, the files that inline drafts written on
 * an older tip point at. A file the PR no longer changes reads as gone, so its
 * drafts are marked moved. Each blob is read once.
 */
export async function lineReader(
  drafts: readonly CommentDraft[],
  tip: Commits,
  files: readonly ChangedFile[],
  readBlob: (blobId: string) => Promise<string>,
): Promise<(location: DraftLocation) => string | undefined> {
  const blobOf = (l: DraftLocation) => {
    const side = (f: ChangedFile) =>
      l.relativeFileVersion === "BEFORE" ? f.beforeBlob : f.afterBlob;
    return files.map(side).find((b) => b?.path === l.filePath)?.blobId;
  };
  const texts = new Map<string, string[]>();
  for (const d of drafts) {
    if (d.target.kind !== "inline" || sameCommits(d, tip)) continue;
    const blobId = blobOf(d.target.location);
    if (blobId && !texts.has(blobId)) texts.set(blobId, (await readBlob(blobId)).split("\n"));
  }
  return (l) => {
    const blobId = blobOf(l);
    return blobId ? texts.get(blobId)?.[l.filePosition - 1] : undefined;
  };
}

/** Posts one draft: PostCommentForPullRequest, or PostCommentReply for a reply. */
type PostDraft = (draft: CommentDraft, commits: Commits, token: string) => Promise<void>;

export interface SubmitDeps {
  readonly post: PostDraft;
  /** Persists what is left; called before and after every post. */
  readonly save: (drafts: readonly CommentDraft[]) => Promise<void>;
  readonly progress?: (done: number, total: number) => void;
}

export interface SubmitResult {
  readonly remaining: readonly CommentDraft[];
  readonly posted: number;
  /** The draft that stopped the run, with its problem set. */
  readonly stopped?: CommentDraft;
}

/**
 * Posts the drafts one at a time in order, as CodeCommit has no call that
 * posts several. Each posted draft leaves the list at once, so a crash never
 * posts it again; the first failure stops the run (the same credentials,
 * permissions or throttling would fail the rest). Moved drafts are skipped.
 */
export async function submitDrafts(
  drafts: readonly CommentDraft[],
  deps: SubmitDeps,
): Promise<SubmitResult> {
  let remaining = [...drafts];
  const queue = drafts.filter((d) => d.problem?.kind !== "moved");
  let posted = 0;
  for (const original of queue) {
    deps.progress?.(posted, queue.length);
    let draft = original;
    // A token is only reused with the commits it was sent with: an unsettled
    // send is retried as it was; otherwise new commits take a new token.
    const retry = draft.sent && draft.problem?.kind === "unknown";
    const from = retry ? draft.sent! : draft;
    const commits: Commits = {
      beforeCommitId: from.beforeCommitId,
      afterCommitId: from.afterCommitId,
    };
    const token =
      draft.sent && !retry && !sameCommits(draft.sent, draft) ? randomUUID() : draft.token;
    draft = {
      ...draft,
      token,
      sent: commits,
    };
    remaining = replace(remaining, draft);
    await deps.save(remaining);
    try {
      await deps.post(draft, commits, token);
    } catch (error) {
      const stopped: CommentDraft = { ...draft, problem: describeFailure(error) };
      remaining = replace(remaining, stopped);
      await deps.save(remaining);
      return { remaining, posted, stopped };
    }
    posted++;
    remaining = remaining.filter((d) => d.id !== draft.id);
    await deps.save(remaining);
  }
  deps.progress?.(posted, queue.length);
  return { remaining, posted };
}

function replace(list: readonly CommentDraft[], draft: CommentDraft): CommentDraft[] {
  return list.map((d) => (d.id === draft.id ? draft : d));
}

/**
 * An answer from CodeCommit below 500, or no credentials to sign with, means
 * it was not posted. Anything else (a timeout, a dropped connection, a server
 * error) may have posted it.
 */
export function describeFailure(error: unknown): DraftProblem {
  const message =
    explainAwsError(error, undefined) ?? (error instanceof Error ? error.message : String(error));
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
    ?.httpStatusCode;
  const refused =
    (typeof status === "number" && status < 500) ||
    (error instanceof Error && isCredentialError(error));
  return refused ? { kind: "failed", message } : { kind: "unknown", message };
}

/**
 * Drafts as read from drafts.json. The file is ours but could be edited or
 * truncated, so anything that is not a whole draft is dropped, not guessed at.
 */
export function parseDrafts(raw: unknown): CommentDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    const d = asDraft(item);
    return d ? [d] : [];
  });
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function asCommits(v: unknown): Commits | undefined {
  if (!isObj(v) || !isStr(v["beforeCommitId"]) || !isStr(v["afterCommitId"])) return undefined;
  return { beforeCommitId: v["beforeCommitId"], afterCommitId: v["afterCommitId"] };
}

function asTarget(v: unknown): DraftTarget | undefined {
  if (!isObj(v)) return undefined;
  if (v["kind"] === "general") return { kind: "general" };
  if (v["kind"] === "inline") {
    const l = v["location"];
    if (
      !isObj(l) ||
      !isStr(l["filePath"]) ||
      !Number.isInteger(l["filePosition"]) ||
      (l["relativeFileVersion"] !== "BEFORE" && l["relativeFileVersion"] !== "AFTER") ||
      typeof l["lineText"] !== "string"
    ) {
      return undefined;
    }
    return {
      kind: "inline",
      location: {
        filePath: l["filePath"],
        filePosition: l["filePosition"] as number,
        relativeFileVersion: l["relativeFileVersion"],
        lineText: l["lineText"],
      },
    };
  }
  if (v["kind"] === "reply") {
    const r = v["replyTo"];
    if (!isStr(v["inReplyTo"]) || !isObj(r)) return undefined;
    if (typeof r["author"] !== "string" || typeof r["excerpt"] !== "string") return undefined;
    return {
      kind: "reply",
      inReplyTo: v["inReplyTo"],
      replyTo: { author: r["author"], excerpt: r["excerpt"] },
    };
  }
  return undefined;
}

function asProblem(v: unknown): DraftProblem | undefined {
  if (!isObj(v) || typeof v["message"] !== "string") return undefined;
  const kind = v["kind"];
  if (kind !== "failed" && kind !== "unknown" && kind !== "moved") return undefined;
  return { kind, message: v["message"] };
}

function asDraft(v: unknown): CommentDraft | undefined {
  if (!isObj(v)) return undefined;
  const commits = asCommits(v);
  const target = asTarget(v["target"]);
  const { id, token, content, createdAt } = v;
  if (!commits || !target || !isStr(id) || !isStr(token) || !isStr(content) || !isStr(createdAt)) {
    return undefined;
  }
  const sent = v["sent"] === undefined ? undefined : asCommits(v["sent"]);
  const problem = v["problem"] === undefined ? undefined : asProblem(v["problem"]);
  if (sent === undefined && v["sent"] !== undefined) return undefined;
  if (problem === undefined && v["problem"] !== undefined) return undefined;
  return {
    id,
    token,
    content,
    createdAt,
    target,
    ...commits,
    ...(sent ? { sent } : {}),
    ...(problem ? { problem } : {}),
  };
}

/** A PR's drafts on disk, by draftKey, for the review screen. */
export interface DraftStorage {
  load(key: string): Promise<CommentDraft[]>;
  save(key: string, drafts: readonly CommentDraft[]): Promise<void>;
}

/**
 * What a PR's drafts are kept under, besides the region. PR ids are unique per
 * account and region only, so without the account a user who reviews in two
 * accounts would be offered, and could post, one PR's drafts on another's.
 * The author's ARN names the account that owns the PR.
 */
export function draftKey(pr: {
  readonly pullRequestId?: string | undefined;
  readonly authorArn?: string | undefined;
}): string {
  const account = pr.authorArn?.split(":")[4] || "unknown";
  return `${account}/${pr.pullRequestId ?? ""}`;
}

/** drafts.json, keyed like seen.json: PR ids are unique per region. */
export function draftStorage(store: LocalState["drafts"], region: string): DraftStorage {
  return {
    load: async (key) => parseDrafts(await store.get(seenKey(region, key))),
    save: (key, drafts) => store.set(seenKey(region, key), drafts),
  };
}
