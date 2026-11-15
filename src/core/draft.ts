import type { Commit } from "../git/git.js";

export interface Draft {
  readonly title: string;
  readonly body: string;
}

/** "feature/add-login_page" → "Feature/add login page", like gh's --fill. */
export function humanizeBranch(branch: string): string {
  const words = branch.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One commit: its subject and body. Several: the branch name as the title and
 * the subjects as a bullet list (spec: PR 作成の手順).
 */
export function draftFromCommits(branch: string, commits: readonly Commit[]): Draft {
  const [only] = commits;
  if (commits.length === 1 && only) return { title: only.subject, body: only.body };
  return { title: humanizeBranch(branch), body: commits.map((c) => `- ${c.subject}`).join("\n") };
}

export function withTemplate(draft: Draft, template: string | undefined): Draft {
  const t = template?.trim();
  if (!t) return draft;
  return { title: draft.title, body: draft.body ? `${draft.body}\n\n${t}` : t };
}

/** The editor buffer: the title on line 1, a blank line, then the body. */
export function toEditorText(draft: Draft): string {
  return `${draft.title}\n\n${draft.body}\n`;
}

export function fromEditorText(text: string): Draft {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const title = (lines.shift() ?? "").trim();
  return { title, body: lines.join("\n").trim() };
}
