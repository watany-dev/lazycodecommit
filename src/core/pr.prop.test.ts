import * as fc from "fast-check";
import { describe, it } from "vitest";
import { fakeApi, fakeGit, pullRequest } from "../testing/fakes.js";
import { UsageError, UserError } from "./errors.js";
import { type CreateOptions, createPullRequest, type PrDeps } from "./pr.js";

// Every input createPullRequest branches on, drawn together, so the safety
// rules of `pr create` are checked across their combinations rather than one
// hand-picked case at a time.
// Weighted towards the happy path so that most runs get as far as pushing
// and creating, where the rules that matter live.
const often = <T>(usual: T, ...rare: T[]) =>
  fc.oneof({ arbitrary: fc.constant(usual), weight: 3 }, fc.constantFrom(...rare));
const world = fc.record({
  base: often<string | undefined>(undefined, "main", "topic"),
  head: often<string | undefined>(undefined, "topic", "other"),
  title: often<string | undefined>("T", undefined, "", "  "),
  body: often("body", "none", "file", "missing-file", "both"),
  fill: fc.boolean(),
  push: fc.boolean(),
  noPush: often(false, true),
  dryRun: often(false, true),
  interactive: fc.boolean(),
  clone: often(true, false),
  current: often<string | null>("topic", null),
  defaultBranch: often<string | undefined>("main", undefined),
  existing: often(false, true),
  localBranch: often(true, false),
  baseRef: often("origin", "local", "none"),
  commits: often(1, 0, 2),
  unpushed: fc.constantFrom(null, 0, 2),
  remoteBranch: often(true, false),
  confirm: fc.boolean(),
  edited: often("keep", "New title\n\nbody", "\n\nno title", "abort"),
  pushFails: often(false, true),
});
type World = typeof world extends fc.Arbitrary<infer T> ? T : never;

async function runCreate(w: World) {
  const log: string[] = [];
  const opts: CreateOptions = {
    ...(w.base !== undefined ? { base: w.base } : {}),
    ...(w.head !== undefined ? { head: w.head } : {}),
    ...(w.title !== undefined ? { title: w.title } : {}),
    ...(w.body === "body" || w.body === "both" ? { body: "B" } : {}),
    ...(w.body === "file" || w.body === "both" ? { bodyFile: "/body.md" } : {}),
    ...(w.body === "missing-file" ? { bodyFile: "/missing.md" } : {}),
    fill: w.fill,
    push: w.push,
    noPush: w.noPush,
    dryRun: w.dryRun,
  };
  const git = fakeGit({
    currentBranch: async () => w.current,
    resolveCommit: async (ref) => {
      if (ref.startsWith("refs/heads/") && ref !== "refs/heads/main")
        return w.localBranch ? "c" : null;
      if (ref.startsWith("refs/remotes/origin/")) return w.baseRef === "origin" ? "c" : null;
      return w.baseRef === "local" ? "c" : null;
    },
    unpushedCount: async () => w.unpushed,
    commits: async () =>
      Array.from({ length: w.commits }, (_, i) => ({ subject: `s${i}`, body: "" })),
    push: async () => {
      log.push("push");
      if (w.pushFails) throw new Error("rejected");
    },
  });
  const open = pullRequest({
    sourceBranch: w.head ?? "topic",
    destinationBranch: w.base ?? "main",
  });
  const api = fakeApi(w.existing ? [open] : [], {
    defaultBranch: async () => w.defaultBranch,
    branchCommit: async () => (w.remoteBranch ? "c" : undefined),
  });
  const deps: PrDeps = {
    git,
    api,
    ctx: {
      repository: "demo",
      region: "ap-northeast-1",
      ...(w.clone ? { clone: { root: "/w" } } : {}),
    },
    config: {},
    interactive: w.interactive,
    confirm: async () => {
      log.push("confirm");
      return w.confirm;
    },
    edit: async (text) => {
      log.push("edit");
      if (w.edited === "abort") throw new UserError("editor failed");
      return w.edited === "keep" ? text : w.edited;
    },
    readFile: async (path) => (path === "/body.md" ? "file body\n" : null),
    note: () => {},
  };
  try {
    const result = await createPullRequest(opts, deps);
    return { log, result, created: api.created, error: undefined };
  } catch (error) {
    return { log, result: undefined, created: api.created, error };
  }
}

const check = (cond: boolean, why: string) => {
  if (!cond) throw new Error(why);
};

describe("pr create safety rules", () => {
  it("hold for every combination of flags and repository state", async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const { log, result, created, error } = await runCreate(w);
        const pushed = log.includes("push");
        check(created.length <= 1, "creates at most one PR");
        check(
          error === undefined || error instanceof UsageError || error instanceof UserError,
          `only user-facing errors escape: ${String(error)}`,
        );
        if (!w.interactive)
          check(
            !log.includes("edit") && !log.includes("confirm"),
            "never prompts without a terminal",
          );
        if (w.dryRun) check(!pushed && created.length === 0, "--dry-run writes nothing");
        if (w.noPush) check(!pushed, "--no-push never pushes");
        if (!w.clone) check(!pushed, "never pushes outside a clone");
        if (pushed) {
          check(
            w.push || (log.includes("confirm") && w.confirm),
            "pushes only with --push or a yes",
          );
          check(log.indexOf("edit") < log.indexOf("push"), "edits before pushing");
        }
        if (log.includes("edit")) check(!w.fill, "--fill never opens the editor");
        if (result?.kind === "exists")
          check(
            !pushed && created.length === 0 && !log.includes("edit"),
            "an open PR stops everything",
          );
        if (created.length === 1) {
          const c = created[0]!;
          check(c.title.trim() !== "", "never creates a PR without a title");
          check(c.sourceBranch !== c.destinationBranch, "head and base differ");
          if (w.clone && w.unpushed !== 0)
            check(pushed && !w.pushFails, "the branch is on origin before the PR");
          check(result?.kind === "created", "reports what it created");
        }
        if (w.push && w.noPush)
          check(error instanceof UsageError, "--push with --no-push is a usage error");
      }),
      { numRuns: 3000 },
    );
  });
});
