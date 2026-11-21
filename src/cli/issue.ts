import type { CodeCommitApi } from "../aws/codecommit.js";
import { UsageError, UserError } from "../core/errors.js";
import {
  commentOnIssue,
  createIssue,
  type Issue,
  type IssueComment,
  type IssueDeps,
  isUnreadable,
  listIssues,
  type StateFilter,
  setIssueState,
  type UnreadableIssue,
  viewIssue,
} from "../core/issues.js";
import { printable, shortArn } from "../core/text.js";
import type { Config } from "../state/config.js";
import { align } from "./format.js";

/** The flags of the issue commands, for main's table (ADR 0011). */
export const ISSUE_COMMANDS = {
  "issue list": {
    positionals: 0,
    options: {
      state: { type: "string", short: "s" },
      limit: { type: "string", short: "L" },
    },
  },
  "issue view": { positionals: 1, options: {} },
  "issue create": {
    positionals: 0,
    options: {
      title: { type: "string", short: "t" },
      body: { type: "string", short: "b" },
      "body-file": { type: "string", short: "F" },
      label: { type: "string", short: "l", multiple: true },
    },
  },
  "issue comment": {
    positionals: 1,
    options: {
      body: { type: "string", short: "b" },
      "body-file": { type: "string", short: "F" },
    },
  },
  "issue close": { positionals: 1, options: {} },
  "issue reopen": { positionals: 1, options: {} },
} as const;

export const ISSUE_USAGE = `  lazycc issue list [--state open|closed|all] [-L limit]
  lazycc issue view <number>
  lazycc issue create [-t title] [-b body | -F file] [-l label]...
  lazycc issue comment <number> [-b body | -F file]
  lazycc issue close <number>
  lazycc issue reopen <number>`;

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

interface IssueIo {
  out(line: string): void;
  err(line: string): void;
  readonly interactive: boolean;
  edit(text: string): Promise<string>;
  readFile(path: string): Promise<string | null>;
  readStdin(): Promise<string>;
}

export interface IssueRun {
  readonly io: IssueIo;
  readonly api: CodeCommitApi;
  readonly repository: string;
  readonly config: Config;
  readonly json: boolean;
  print(value: unknown): void;
  now?: () => Date;
}

const str = (v: Values, key: string) =>
  typeof v[key] === "string" ? (v[key] as string) : undefined;

function issueNumber(text: string | undefined): number {
  if (text === undefined) throw new UsageError("Pass an issue number");
  const n = Number(text.replace(/^#/, ""));
  if (/^#?[1-9][0-9]*$/.test(text) && Number.isSafeInteger(n)) return n;
  throw new UsageError(`Not an issue number: ${text}`);
}

/** -b, -F (- is stdin), or undefined when neither was given. */
async function givenBody(values: Values, io: IssueIo): Promise<string | undefined> {
  const body = str(values, "body");
  const file = str(values, "body-file");
  if (body !== undefined && file !== undefined)
    throw new UsageError("--body and --body-file cannot be used together");
  if (file === undefined) return body;
  const text = file === "-" ? await io.readStdin() : await io.readFile(file);
  if (text === null) throw new UserError(`--body-file: ${file} does not exist`);
  return text;
}

const EDIT_HINT =
  "\n\n# The first line is the title, the rest is the body. Lines starting with # are dropped.\n";

/** Title on the first line, then the body, as in a commit message. */
function splitEdited(text: string): { title: string; body: string } {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !l.startsWith("#"));
  const [title = "", ...rest] = lines;
  return { title: title.trim(), body: rest.join("\n").trim() };
}

function labels(values: Values): string[] {
  const v = values["label"];
  const all = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return all.flatMap((l) => String(l).split(","));
}

function issueJson(issue: Issue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.author,
    createdAt: issue.created,
    closedAt: issue.closed ?? null,
    labels: issue.labels,
    body: issue.body,
  };
}

function unreadableJson(issue: UnreadableIssue) {
  return { number: issue.number, unreadable: issue.problem, path: issue.path };
}

function listLines(issues: readonly (Issue | UnreadableIssue)[]): string[] {
  return align(
    issues.map((i) =>
      isUnreadable(i)
        ? [`#${i.number}`, "?", "(unreadable)", "", `${i.path}: ${i.problem}`]
        : [
            `#${i.number}`,
            i.state,
            printable(i.title),
            printable(i.labels.join(", ")),
            shortArn(printable(i.author)),
          ],
    ),
  );
}

function viewLines(issue: Issue, comments: readonly IssueComment[]): string[] {
  const lines = [
    `#${issue.number} ${printable(issue.title)}`,
    `${issue.state} · ${shortArn(printable(issue.author))} opened ${issue.created}${issue.closed ? ` · closed ${issue.closed}` : ""}`,
  ];
  if (issue.labels.length > 0) lines.push(`labels: ${printable(issue.labels.join(", "))}`);
  lines.push("", issue.body ? printable(issue.body, true) : "(no description)");
  for (const c of comments) {
    lines.push("", `── ${shortArn(printable(c.author)) || "?"} ${printable(c.created)}`);
    lines.push(printable(c.body, true));
  }
  return lines;
}

/** `lazycc issue <verb>` (ADR 0011). */
export async function runIssue(
  command: string,
  values: Values,
  positionals: readonly string[],
  run: IssueRun,
): Promise<number> {
  const { io, json, print } = run;
  const deps: IssueDeps = {
    api: run.api,
    repository: run.repository,
    config: run.config,
    now: run.now ?? (() => new Date()),
  };
  switch (command) {
    case "issue list": {
      const state = (str(values, "state") ?? "open") as StateFilter;
      if (!["open", "closed", "all"].includes(state))
        throw new UsageError("--state must be open, closed or all");
      const limitText = str(values, "limit") ?? "30";
      if (!/^\d+$/.test(limitText) || Number(limitText) < 1)
        throw new UsageError(`--limit must be a positive integer: ${limitText}`);
      const { branch, issues } = await listIssues(deps, { state, limit: Number(limitText) });
      if (json) print(issues.map((i) => (isUnreadable(i) ? unreadableJson(i) : issueJson(i))));
      else if (issues.length === 0)
        io.err(
          `No ${state === "all" ? "" : `${state} `}issues in ${run.repository} (branch ${branch}).`,
        );
      else for (const line of listLines(issues)) io.out(line);
      return 0;
    }
    case "issue view": {
      const { issue, comments } = await viewIssue(deps, issueNumber(positionals[0]));
      if (json) print({ ...issueJson(issue), comments });
      else for (const line of viewLines(issue, comments)) io.out(line);
      return 0;
    }
    case "issue create": {
      let title = str(values, "title");
      let body = await givenBody(values, io);
      if (title === undefined || body === undefined) {
        if (!io.interactive)
          throw new UsageError("Not a terminal: pass both --title and --body to create an issue");
        if (title === undefined) {
          const edited = splitEdited(await io.edit(`${body ?? ""}${EDIT_HINT}`));
          if (!edited.title) throw new UserError("Aborted: the title is empty.");
          title = edited.title;
          body = edited.body;
        } else body = (await io.edit("")).trim();
      }
      const issue = await createIssue(deps, { title, body: body.trim(), labels: labels(values) });
      if (json) print(issueJson(issue));
      else io.out(`Created issue #${issue.number}: ${printable(issue.title)}`);
      return 0;
    }
    case "issue comment": {
      const number = issueNumber(positionals[0]);
      let body = await givenBody(values, io);
      if (body === undefined) {
        if (!io.interactive) throw new UsageError("Not a terminal: pass --body or --body-file");
        body = await io.edit("");
      }
      if (!body.trim()) throw new UserError("Aborted: the comment is empty.");
      const comment = await commentOnIssue(deps, number, body.trim());
      if (json) print({ number, comment });
      else io.out(`Commented on issue #${number}`);
      return 0;
    }
    default: {
      const state = command === "issue close" ? "closed" : "open";
      const { issue, changed } = await setIssueState(deps, issueNumber(positionals[0]), state);
      if (json) print({ ...issueJson(issue), changed });
      else if (!changed) io.err(`Issue #${issue.number} is already ${state}.`);
      else
        io.out(
          `${state === "closed" ? "Closed" : "Reopened"} issue #${issue.number}: ${printable(issue.title)}`,
        );
      return 0;
    }
  }
}
