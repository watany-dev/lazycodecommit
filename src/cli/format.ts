import type { PullRequest } from "../aws/codecommit.js";
import { type BranchTable, rulesSummary, STATE_LABEL } from "../core/branch.js";
import type { PrStatus } from "../core/pr.js";
import { consoleUrl } from "../core/pr.js";

/**
 * Other people's text (titles, descriptions, rule names) with control
 * characters shown in caret notation, so an escape sequence in a title cannot
 * rewrite the user's screen or clipboard. A description keeps \n and \t.
 */
export function printable(text: string, multiline = false): string {
  const s = multiline ? text.replace(/\r\n?/g, "\n") : text;
  // oxlint-disable-next-line no-control-regex -- finding them is the point
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => {
    if (multiline && (c === "\n" || c === "\t")) return c;
    const code = c.charCodeAt(0);
    if (code === 0x7f) return "^?";
    // C1 controls are ESC + (code - 64): CSI (0x9b) reads as ^[[.
    return code < 0x20
      ? `^${String.fromCharCode(code + 64)}`
      : `^[${String.fromCharCode(code - 64)}`;
  });
}

// East Asian wide and fullwidth ranges: these take two terminal cells.
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;

function cells(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

/** "arn:aws:iam::1:user/alice" → "alice"; "arn:aws:sts::1:assumed-role/Dev/bob" → "Dev/bob". */
function shortArn(arn: string): string {
  const resource = arn.split(":").slice(5).join(":");
  if (!resource) return arn;
  const slash = resource.indexOf("/");
  return slash === -1 ? resource : resource.slice(slash + 1);
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
  if (prs.length === 0) return [];
  const rows = prs.map((pr) => [
    `#${pr.id}`,
    printable(pr.title),
    `${pr.sourceBranch} → ${pr.destinationBranch}`,
    shortArn(pr.authorArn),
    date(pr.lastActivityDate),
  ]);
  return align(rows);
}

/** Pads every column but the last to its widest cell. */
function align(rows: readonly string[][]): string[] {
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
