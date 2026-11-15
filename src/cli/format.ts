import type { PullRequest } from "../aws/codecommit.js";
import type { PrStatus } from "../core/pr.js";
import { consoleUrl } from "../core/pr.js";

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

export function prJson(pr: PullRequest, region: string | undefined) {
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
    pr.title,
    `${pr.sourceBranch} → ${pr.destinationBranch}`,
    shortArn(pr.authorArn),
    date(pr.lastActivityDate),
  ]);
  const widths =
    rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] as string).length))) ?? [];
  return rows.map((r) =>
    r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] as number))).join("  "),
  );
}

export function viewLines(pr: PullRequest, region: string | undefined): string[] {
  const state = pr.isMerged ? "MERGED" : pr.status;
  return [
    `${pr.title} #${pr.id}`,
    `${state} · ${shortArn(pr.authorArn)} wants to merge ${pr.sourceBranch} into ${pr.destinationBranch}`,
    `created ${date(pr.creationDate)} · updated ${date(pr.lastActivityDate)}`,
    "",
    pr.description.trim() || "(no description)",
    "",
    consoleUrl(region, pr.repository, pr.id),
  ];
}

export function statusLines(s: PrStatus, region: string | undefined): string[] {
  const { pr, rules } = s;
  if (!pr) return [`No open pull request from ${s.branch}.`];
  let ruleLine: string;
  if (!rules || (rules.satisfied.length === 0 && rules.notSatisfied.length === 0))
    ruleLine = "no approval rules";
  else if (rules.overridden) ruleLine = "overridden";
  else {
    ruleLine = [
      ...rules.satisfied.map((r) => `✓ ${r}`),
      ...rules.notSatisfied.map((r) => `✗ ${r}`),
    ].join(", ");
  }
  const approvers = s.approvers?.length ? s.approvers.map(shortArn).join(", ") : "none";
  return [
    `${pr.title} #${pr.id} (${pr.sourceBranch} → ${pr.destinationBranch})`,
    `  approval rules: ${ruleLine}`,
    `  approved by:    ${approvers}`,
    `  conflicts:      ${s.mergeable ? "none" : "yes, cannot merge cleanly"}`,
    `  ${consoleUrl(region, pr.repository, pr.id)}`,
  ];
}
