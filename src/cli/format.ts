import type { PullRequest, RuleEvaluation } from "../aws/codecommit.js";
import { type BranchTable, rulesSummary, STATE_LABEL } from "../core/branch.js";
import type { Inbox, InboxItem } from "../core/inbox.js";
import type { PrStatus } from "../core/pr.js";
import { consoleUrl } from "../core/pr.js";
import { printable, shortArn } from "../core/text.js";

// East Asian wide and fullwidth ranges: these take two terminal cells.
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;

function cells(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

function date(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function prJson(pr: PullRequest, region: string) {
  return {
    id: pr.id,
    title: pr.title,
    description: pr.description,
    status: pr.isMerged ? "MERGED" : pr.status,
    author: pr.authorArn,
    repository: pr.repository,
    sourceBranch: pr.sourceBranch,
    destinationBranch: pr.destinationBranch,
    sourceCommit: pr.sourceCommit,
    destinationCommit: pr.destinationCommit,
    createdAt: date(pr.creationDate),
    updatedAt: date(pr.lastActivityDate),
    url: consoleUrl(region, pr.repository, pr.id),
  };
}

export function listLines(prs: readonly PullRequest[]): string[] {
  return align(
    prs.map((pr) => [
      `#${pr.id}`,
      printable(pr.title),
      `${pr.sourceBranch} → ${pr.destinationBranch}`,
      shortArn(pr.authorArn),
      date(pr.lastActivityDate),
    ]),
  );
}

/** Columns padded to their widest cell; the last column is not padded. */
function align(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => cells(r[i] as string)))) ?? [];
  return rows.map((r) =>
    r
      .map((cell, i) =>
        i === r.length - 1 ? cell : cell + " ".repeat((widths[i] as number) - cells(cell)),
      )
      .join("  ")
      .trimEnd(),
  );
}

/** spec: ブランチ×PR 対応表, as text: one line per branch, the default marked with *. */
export function branchLines(table: BranchTable): string[] {
  return align(
    table.rows.map((r) => [
      `${r.isDefault ? "*" : " "} ${printable(r.name)}`,
      STATE_LABEL[r.state],
      r.ahead === undefined ? "" : `↑${r.ahead} ↓${r.behind}`,
      r.lastCommit ? `${date(r.lastCommit.date)} ${printable(r.lastCommit.author)}` : "",
      [r.pr ? `#${r.pr.id} ${printable(r.pr.title)}` : "", rulesSummary(r.rules)]
        .filter(Boolean)
        .join("  "),
    ]),
  );
}

export function branchJson(table: BranchTable) {
  return {
    repository: table.repository,
    defaultBranch: table.defaultBranch ?? null,
    branches: table.rows.map((r) => ({
      name: r.name,
      default: r.isDefault,
      state: r.state,
      tip: r.tip,
      pullRequest: r.pr ?? null,
      approvalRules: r.rules ?? null,
      ahead: r.ahead ?? null,
      behind: r.behind ?? null,
      lastCommit: r.lastCommit
        ? { date: date(r.lastCommit.date), author: r.lastCommit.author }
        : null,
    })),
  };
}

export function viewLines(pr: PullRequest, region: string): string[] {
  const state = pr.isMerged ? "MERGED" : pr.status;
  return [
    `${printable(pr.title)} #${pr.id}`,
    `${state} · ${shortArn(pr.authorArn)} wants to merge ${pr.sourceBranch} into ${pr.destinationBranch}`,
    `created ${date(pr.creationDate)} · updated ${date(pr.lastActivityDate)}`,
    "",
    printable(pr.description.trim(), true) || "(no description)",
    "",
    consoleUrl(region, pr.repository, pr.id),
  ];
}

export function statusLines(s: PrStatus, region: string): string[] {
  const { pr, rules } = s;
  if (!pr) return [`No open pull request from ${s.branch}.`];
  let ruleLine: string;
  if (!rules || (rules.satisfied.length === 0 && rules.notSatisfied.length === 0))
    ruleLine = "no approval rules";
  else if (rules.overridden) ruleLine = "overridden";
  else {
    ruleLine = [
      ...rules.satisfied.map((r) => `✓ ${printable(r)}`),
      ...rules.notSatisfied.map((r) => `✗ ${printable(r)}`),
    ].join(", ");
  }
  const approvers = s.approvers?.length ? s.approvers.map(shortArn).join(", ") : "none";
  return [
    `${printable(pr.title)} #${pr.id} (${pr.sourceBranch} → ${pr.destinationBranch})`,
    `  approval rules: ${ruleLine}`,
    `  approved by:    ${approvers}`,
    `  conflicts:      ${s.mergeable ? "none" : "yes, cannot merge cleanly"}`,
    `  ${consoleUrl(region, pr.repository, pr.id)}`,
  ];
}

function rulesCell(rules: RuleEvaluation | undefined): string {
  return rules ? rulesSummary(rules) || "no rules" : "rules ?";
}

function conflictCell(mergeable: boolean | undefined): string {
  return mergeable === undefined ? "conflicts ?" : mergeable ? "no conflicts" : "conflicts";
}

function inboxSection(title: string, rows: string[][]): string[] {
  return [
    `${title} (${rows.length})`,
    ...(rows.length === 0 ? ["  none"] : align(rows).map((l) => `  ${l}`)),
  ];
}

const unreadMark = (i: InboxItem) => (i.unread ? "●" : " ");

/** `lazycc status`: the home screen's two sections as text. ● marks unread. */
export function inboxLines(items: readonly InboxItem[]): string[] {
  const awaiting = items.filter((i) => i.section === "awaiting");
  const mine = items.filter((i) => i.section === "mine");
  return [
    ...inboxSection(
      "Awaiting your approval",
      awaiting.map((i) => [
        unreadMark(i),
        printable(i.pr.repository),
        `#${i.pr.id}`,
        printable(i.pr.title),
        shortArn(i.pr.authorArn),
        date(i.pr.lastActivityDate),
      ]),
    ),
    "",
    ...inboxSection(
      "Your pull requests",
      mine.map((i) => [
        unreadMark(i),
        printable(i.pr.repository),
        `#${i.pr.id}`,
        printable(i.pr.title),
        rulesCell(i.rules),
        conflictCell(i.mergeable),
        date(i.pr.lastActivityDate),
      ]),
    ),
  ];
}

export function inboxJson(inbox: Inbox, items: readonly InboxItem[], region: string) {
  const row = (i: InboxItem) => ({
    ...prJson(i.pr, region),
    unread: i.unread,
    ...(i.section === "awaiting"
      ? { approvedBy: i.approvedBy ?? null }
      : { approvalRules: i.rules ?? null, mergeable: i.mergeable ?? null }),
    ...(i.detailError ? { detailError: i.detailError } : {}),
  });
  return {
    me: inbox.me,
    repositories: inbox.repositories,
    awaiting: items.filter((i) => i.section === "awaiting").map(row),
    mine: items.filter((i) => i.section === "mine").map(row),
    errors: inbox.errors.map((e) => ({ repository: e.repository, message: e.error.message })),
  };
}
