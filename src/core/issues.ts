import { randomBytes } from "node:crypto";
import type { CodeCommitApi, FileChange } from "../aws/codecommit.js";
import type { Config } from "../state/config.js";
import { UserError } from "./errors.js";

/** Issues are files under issue/ on their own branch (ADR 0011). */
const ISSUE_ROOT = "issue";
const DEFAULT_BRANCH = "issues";
const ATTEMPTS = 3;

export type IssueState = "open" | "closed";

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly state: IssueState;
  readonly author: string;
  readonly created: string;
  readonly closed?: string;
  readonly labels: readonly string[];
  readonly body: string;
  /** Every front matter field as written, unknown keys too, so a rewrite keeps them. */
  readonly fields: readonly (readonly [string, string])[];
}

/** An issue.md lazycc cannot read: shown with its path and why, not dropped. */
export interface UnreadableIssue {
  readonly number: number;
  readonly path: string;
  readonly problem: string;
}

export interface IssueComment {
  readonly author: string;
  readonly created: string;
  readonly body: string;
}

export interface IssueDeps {
  readonly api: CodeCommitApi;
  readonly repository: string;
  readonly config: Config;
  readonly now: () => Date;
}

function issueBranch(config: Config): string {
  return config.issues?.branch ?? DEFAULT_BRANCH;
}

interface FrontMatter {
  readonly fields: readonly (readonly [string, string])[];
  readonly body: string;
}

/** `---`, `key: value` lines, `---`, then the body. Null when the text does not open with one. */
export function parseFrontMatter(text: string): FrontMatter | null {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const fields: [string, string][] = [];
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    fields.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

/** A value on one line: a newline would end the field and start a forged one. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export function formatFrontMatter(
  fields: readonly (readonly [string, string])[],
  body: string,
): string {
  const head = fields.map(([k, v]) => `${k}: ${oneLine(v)}`);
  const tail = body.endsWith("\n") || body === "" ? body : `${body}\n`;
  return ["---", ...head, "---", tail].join("\n");
}

function field(fields: FrontMatter["fields"], key: string): string | undefined {
  return fields.find(([k]) => k === key)?.[1];
}

function withField(fields: FrontMatter["fields"], key: string, value: string | undefined) {
  if (value === undefined) return fields.filter(([k]) => k !== key);
  const entry = [key, value] as const;
  return field(fields, key) === undefined
    ? [...fields, entry]
    : fields.map((f) => (f[0] === key ? entry : f));
}

export function parseIssue(number: number, path: string, text: string): Issue | UnreadableIssue {
  const parsed = parseFrontMatter(text);
  if (!parsed) return { number, path, problem: "no front matter" };
  const { fields, body } = parsed;
  const title = field(fields, "title");
  if (!title) return { number, path, problem: "no title" };
  const closed = field(fields, "closed");
  return {
    number,
    title,
    state: field(fields, "state") === "closed" ? "closed" : "open",
    author: field(fields, "author") ?? "",
    created: field(fields, "created") ?? "",
    ...(closed ? { closed } : {}),
    labels: (field(fields, "labels") ?? "")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
    body: body.replace(/\n+$/, ""),
    fields,
  };
}

export function isUnreadable(issue: Issue | UnreadableIssue): issue is UnreadableIssue {
  return "problem" in issue;
}

const decoder = new TextDecoder();
const issuePath = (n: number) => `${ISSUE_ROOT}/${n}/issue.md`;
const commentsPath = (n: number) => `${ISSUE_ROOT}/${n}/comments`;

async function issueNumbers(deps: IssueDeps, commit: string): Promise<number[]> {
  const entries = (await deps.api.getFolder(deps.repository, commit, ISSUE_ROOT)) ?? [];
  return entries
    .filter((e) => e.type === "folder" && /^[1-9][0-9]*$/.test(e.name))
    .map((e) => Number(e.name))
    .toSorted((a, b) => b - a);
}

async function readIssue(
  deps: IssueDeps,
  commit: string,
  number: number,
): Promise<Issue | UnreadableIssue | undefined> {
  const path = issuePath(number);
  const bytes = await deps.api.getFile(deps.repository, commit, path);
  return bytes && parseIssue(number, path, decoder.decode(bytes));
}

export type StateFilter = IssueState | "all";

export interface IssueList {
  readonly branch: string;
  readonly issues: readonly (Issue | UnreadableIssue)[];
}

/** Newest first. Unreadable issues are kept whatever the filter, so a broken file is seen. */
export async function listIssues(
  deps: IssueDeps,
  filter: { state: StateFilter; limit: number },
): Promise<IssueList> {
  const branch = issueBranch(deps.config);
  const commit = await deps.api.branchCommit(deps.repository, branch);
  if (!commit) return { branch, issues: [] };
  const numbers = await issueNumbers(deps, commit);
  const all = await Promise.all(numbers.map((n) => readIssue(deps, commit, n)));
  const issues = all
    .filter((i): i is Issue | UnreadableIssue => i !== undefined)
    .filter((i) => isUnreadable(i) || filter.state === "all" || i.state === filter.state)
    .slice(0, filter.limit);
  return { branch, issues };
}

function missing(number: number): UserError {
  return new UserError(`Issue #${number} does not exist`);
}

async function readableIssue(deps: IssueDeps, commit: string, number: number): Promise<Issue> {
  const issue = await readIssue(deps, commit, number);
  if (!issue) throw missing(number);
  if (isUnreadable(issue)) {
    throw new UserError(`Cannot read ${issue.path}: ${issue.problem}`);
  }
  return issue;
}

export async function viewIssue(
  deps: IssueDeps,
  number: number,
): Promise<{ issue: Issue; comments: IssueComment[] }> {
  const commit = await deps.api.branchCommit(deps.repository, issueBranch(deps.config));
  if (!commit) throw missing(number);
  const issue = await readableIssue(deps, commit, number);
  const files = (await deps.api.getFolder(deps.repository, commit, commentsPath(number))) ?? [];
  const names = files
    .filter((f) => f.type === "file" && f.name.endsWith(".md"))
    .map((f) => f.path)
    .toSorted();
  const comments = await Promise.all(
    names.map(async (path) => {
      const bytes = await deps.api.getFile(deps.repository, commit, path);
      const text = bytes ? decoder.decode(bytes) : "";
      const parsed = parseFrontMatter(text);
      return {
        author: (parsed && field(parsed.fields, "author")) ?? "",
        created: (parsed && field(parsed.fields, "created")) ?? "",
        body: (parsed ? parsed.body : text).replace(/\n+$/, ""),
      };
    }),
  );
  return { issue, comments };
}

/**
 * The issue branch's tip. Only creating an issue makes the branch, off the
 * default branch's tip (ADR 0011); anything else on a missing branch is
 * `notFound`, so a mistyped number leaves nothing behind.
 */
async function branchTip(deps: IssueDeps, branch: string, notFound?: UserError): Promise<string> {
  const { api, repository } = deps;
  const tip = await api.branchCommit(repository, branch);
  if (tip) return tip;
  if (notFound) throw notFound;
  const base = await api.defaultBranch(repository);
  const baseTip = base && (await api.branchCommit(repository, base));
  // A first commit would make the issue branch the repository's default branch.
  if (!baseTip)
    throw new UserError(
      `${repository} has no commits yet. Push a first commit before adding issues.`,
    );
  try {
    await api.createBranch(repository, branch, baseTip);
  } catch (error) {
    if ((error as Error).name !== "BranchNameExistsException") throw error;
    return branchTip(deps, branch, notFound);
  }
  return baseTip;
}

/** No files: nothing to write, and `result` is returned without a commit. */
interface Change<T> {
  readonly message: string;
  readonly files: readonly FileChange[];
  readonly result: T;
}

/**
 * Commits `change(tip)` on the issue branch with the tip as parent. When
 * someone else committed in between, CodeCommit refuses and this reads the
 * new tip and asks again, so nobody's write is lost (ADR 0011). The refusal
 * can also be the SDK retrying our own commit that landed, so each change
 * first checks whether the tip already has it.
 */
async function commitChange<T>(
  deps: IssueDeps,
  notFound: UserError | undefined,
  change: (tip: string) => Promise<Change<T>>,
): Promise<T> {
  const branch = issueBranch(deps.config);
  for (let attempt = 1; ; attempt++) {
    const tip = await branchTip(deps, branch, notFound);
    const { message, files, result } = await change(tip);
    if (files.length === 0) return result;
    try {
      await deps.api.createCommit({
        repository: deps.repository,
        branch,
        parent: tip,
        message,
        files,
      });
      return result;
    } catch (error) {
      const raced = (error as Error).name === "ParentCommitIdOutdatedException";
      if (!raced || attempt >= ATTEMPTS) throw error;
    }
  }
}

export interface NewIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export async function createIssue(deps: IssueDeps, input: NewIssue): Promise<Issue> {
  const title = oneLine(input.title);
  if (!title) throw new UserError("An issue needs a title");
  const author = await deps.api.callerArn();
  const created = deps.now().toISOString();
  let tried: number | undefined;
  return commitChange(deps, undefined, async (tip) => {
    if (tried !== undefined) {
      const landed = await readIssue(deps, tip, tried);
      if (landed && !isUnreadable(landed) && landed.created === created && landed.author === author)
        return { message: "", files: [], result: landed };
    }
    const number = ((await issueNumbers(deps, tip))[0] ?? 0) + 1;
    tried = number;
    const fields: [string, string][] = [
      ["title", title],
      ["state", "open"],
      ["author", author],
      ["created", created],
    ];
    const labels = input.labels.map(oneLine).filter(Boolean);
    if (labels.length > 0) fields.push(["labels", labels.join(", ")]);
    const text = formatFrontMatter(fields, input.body);
    return {
      message: `issue #${number}: create`,
      files: [{ path: issuePath(number), content: text }],
      result: parseIssue(number, issuePath(number), text) as Issue,
    };
  });
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export async function commentOnIssue(
  deps: IssueDeps,
  number: number,
  body: string,
): Promise<IssueComment> {
  if (!body.trim()) throw new UserError("The comment is empty");
  const author = await deps.api.callerArn();
  const now = deps.now();
  const created = now.toISOString();
  const path = `${commentsPath(number)}/${stamp(now)}-${randomBytes(3).toString("hex")}.md`;
  const result = { author, created, body: body.replace(/\n+$/, "") };
  return commitChange(deps, missing(number), async (tip) => {
    await readableIssue(deps, tip, number);
    if (await deps.api.getFile(deps.repository, tip, path))
      return { message: "", files: [], result };
    const content = formatFrontMatter(
      [
        ["author", author],
        ["created", created],
      ],
      body,
    );
    return { message: `issue #${number}: comment`, files: [{ path, content }], result };
  });
}

/** Already in that state: nothing is committed. */
export function setIssueState(
  deps: IssueDeps,
  number: number,
  state: IssueState,
): Promise<{ issue: Issue; changed: boolean }> {
  return commitChange<{ issue: Issue; changed: boolean }>(deps, missing(number), async (tip) => {
    const issue = await readableIssue(deps, tip, number);
    if (issue.state === state) return { message: "", files: [], result: { issue, changed: false } };
    let fields = withField(issue.fields, "state", state);
    fields = withField(fields, "closed", state === "closed" ? deps.now().toISOString() : undefined);
    const text = formatFrontMatter(fields, issue.body);
    return {
      message: `issue #${number}: ${state === "closed" ? "close" : "reopen"}`,
      files: [{ path: issuePath(number), content: text }],
      result: { issue: parseIssue(number, issuePath(number), text) as Issue, changed: true },
    };
  });
}
