import type { FolderEntry, NewCommit } from "../aws/codecommit.js";
import type { IssueDeps } from "../core/issues.js";
import { fakeApi } from "./fakes.js";

/** A repository in memory: branches point at snapshots of path → text. */
export function issueRepo(options: { files?: Record<string, string>; branches?: string[] } = {}) {
  const snapshots = new Map<string, Map<string, string>>();
  const tips = new Map<string, string>();
  let next = 0;
  const snapshot = (files: Map<string, string>) => {
    const id = `c${next++}`;
    snapshots.set(id, files);
    return id;
  };
  const base = snapshot(new Map([["README.md", "hi"]]));
  tips.set("main", base);
  for (const b of options.branches ?? []) tips.set(b, base);
  if (options.files) {
    tips.set("issues", snapshot(new Map(Object.entries(options.files))));
  }
  const commits: NewCommit[] = [];
  const encoder = new TextEncoder();
  /** Runs once before the next commit lands, as if someone else committed first. */
  let interloper: (() => void) | undefined;
  const api = fakeApi([], {
    branchCommit: async (_r, b) => tips.get(b),
    defaultBranch: async () => "main",
    createBranch: async (_r, b, commitId) => {
      if (tips.has(b))
        throw Object.assign(new Error("exists"), { name: "BranchNameExistsException" });
      tips.set(b, commitId);
    },
    getFolder: async (_r, ref, path) => {
      const files = snapshots.get(ref);
      if (!files) return undefined;
      const prefix = `${path}/`;
      const seen = new Map<string, FolderEntry>();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const [name = "", ...more] = p.slice(prefix.length).split("/");
        seen.set(name, {
          name,
          path: `${path}/${name}`,
          type: more.length > 0 ? "folder" : "file",
        });
      }
      return seen.size > 0 ? [...seen.values()] : undefined;
    },
    getFile: async (_r, ref, path) => {
      const text = snapshots.get(ref)?.get(path);
      return text === undefined ? undefined : encoder.encode(text);
    },
    createCommit: async (input) => {
      const run = interloper;
      interloper = undefined;
      run?.();
      const tip = tips.get(input.branch);
      if (tip !== input.parent)
        throw Object.assign(new Error("outdated"), { name: "ParentCommitIdOutdatedException" });
      const files = new Map(tip ? snapshots.get(tip) : []);
      for (const f of input.files) files.set(f.path, f.content);
      const id = snapshot(files);
      tips.set(input.branch, id);
      commits.push(input);
      return id;
    },
  });
  const deps: IssueDeps = {
    api,
    repository: "demo",
    config: {},
    now: () => new Date("2026-11-21T05:10:00.123Z"),
    nonce: () => "abc123",
  };
  const fileAt = (path: string) => snapshots.get(tips.get("issues") ?? "")?.get(path);
  return {
    deps,
    commits,
    tips,
    fileAt,
    raceOnce(change: () => void) {
      interloper = change;
    },
    /** Commits files to the issue branch directly, as another client would. */
    put(files: Record<string, string>) {
      const tip = tips.get("issues");
      const merged = new Map(tip ? snapshots.get(tip) : []);
      for (const [k, v] of Object.entries(files)) merged.set(k, v);
      tips.set("issues", snapshot(merged));
    },
  };
}
