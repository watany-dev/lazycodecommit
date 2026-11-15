import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, GitError } from "./git.js";

let dir: string;
let work: string;
let bare: string;

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function commit(message: string, file = "f.txt") {
  await writeFile(join(work, file), `${message}\n${Math.random()}\n`);
  sh(work, "add", ".");
  sh(work, "commit", "-q", "-m", message);
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "lazycc-git-")));
  work = join(dir, "work");
  bare = join(dir, "remote.git");
  sh(dir, "init", "-q", "--bare", "-b", "main", bare);
  sh(dir, "init", "-q", "-b", "main", work);
  sh(work, "config", "user.name", "t");
  sh(work, "config", "user.email", "t@example.com");
  sh(work, "config", "commit.gpgsign", "false");
  sh(work, "remote", "add", "origin", bare);
  await commit("initial");
  sh(work, "push", "-q", "-u", "origin", "main");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createGit", () => {
  it("finds the top level, branch and remote", async () => {
    const git = createGit(work);
    expect(await git.topLevel()).toBe(work);
    expect(await git.currentBranch()).toBe("main");
    expect(await git.remoteUrl("origin")).toBe(bare);
    expect(await git.remoteUrl("nope")).toBeNull();
  });

  it("returns null outside a work tree", async () => {
    const git = createGit(dir);
    expect(await git.topLevel()).toBeNull();
    expect(await git.remoteUrl("origin")).toBeNull();
  });

  it("returns null on a detached HEAD", async () => {
    sh(work, "checkout", "-q", "--detach");
    expect(await createGit(work).currentBranch()).toBeNull();
  });

  it("resolves commits", async () => {
    const git = createGit(work);
    expect(await git.resolveCommit("refs/heads/main")).toBe(sh(work, "rev-parse", "HEAD"));
    expect(await git.resolveCommit("refs/heads/missing")).toBeNull();
  });

  it("counts unpushed commits, or null without an upstream", async () => {
    const git = createGit(work);
    expect(await git.unpushedCount("main")).toBe(0);
    await commit("second");
    expect(await git.unpushedCount("main")).toBe(1);
    sh(work, "switch", "-q", "-c", "topic");
    expect(await git.unpushedCount("topic")).toBeNull();
  });

  it("compares with origin/<branch>, not with a differently named upstream", async () => {
    sh(work, "switch", "-q", "-c", "topic", "--track", "origin/main");
    expect(await createGit(work).unpushedCount("topic")).toBeNull();
  });

  it("lists commits oldest first with bodies", async () => {
    sh(work, "switch", "-q", "-c", "topic");
    await commit("first change");
    await writeFile(join(work, "g.txt"), "x");
    sh(work, "add", ".");
    sh(work, "commit", "-q", "-m", "second change", "-m", "Why it matters.\n\nMore detail.");
    expect(await createGit(work).commits("main", "topic")).toEqual([
      { subject: "first change", body: "" },
      { subject: "second change", body: "Why it matters.\n\nMore detail." },
    ]);
    expect(await createGit(work).commits("topic", "main")).toEqual([]);
  });

  it("throws GitError with git's message on a bad range", async () => {
    const err = await createGit(work)
      .commits("nope", "main")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toMatch(/nope/);
  });

  it("pushes and sets the upstream", async () => {
    sh(work, "switch", "-q", "-c", "topic");
    await commit("topic work");
    const git = createGit(work);
    await git.push("topic");
    expect(sh(bare, "rev-parse", "topic")).toBe(sh(work, "rev-parse", "topic"));
    expect(await git.unpushedCount("topic")).toBe(0);
  });

  it("rejects when push fails", async () => {
    sh(work, "remote", "set-url", "origin", join(dir, "missing.git"));
    await expect(createGit(work).push("main")).rejects.toBeInstanceOf(GitError);
  });

  it("fetches a branch into its remote-tracking ref", async () => {
    sh(work, "switch", "-q", "-c", "topic");
    await commit("topic work");
    sh(work, "push", "-q", "origin", "topic");
    const tip = sh(work, "rev-parse", "topic");
    sh(work, "switch", "-q", "main");
    sh(work, "branch", "-q", "-D", "topic");
    sh(work, "update-ref", "-d", "refs/remotes/origin/topic");
    const git = createGit(work);
    await git.fetch(["+refs/heads/topic:refs/remotes/origin/topic"]);
    expect(await git.resolveCommit("refs/remotes/origin/topic")).toBe(tip);
    await expect(git.fetch(["refs/heads/nope:refs/remotes/origin/nope"])).rejects.toBeInstanceOf(
      GitError,
    );
  });

  it("creates a tracking branch, switches, and fast-forwards", async () => {
    sh(work, "switch", "-q", "-c", "topic");
    await commit("one");
    sh(work, "push", "-q", "-u", "origin", "topic");
    sh(work, "switch", "-q", "main");
    sh(work, "branch", "-q", "-D", "topic");
    const git = createGit(work);
    await git.switchBranch("topic", { track: "origin/topic" });
    expect(await git.currentBranch()).toBe("topic");
    expect(sh(work, "rev-parse", "--abbrev-ref", "topic@{upstream}")).toBe("origin/topic");

    sh(work, "reset", "-q", "--hard", "HEAD~1");
    await git.switchBranch("main");
    await git.switchBranch("topic");
    await git.fastForward("origin/topic");
    expect(sh(work, "rev-parse", "topic")).toBe(sh(work, "rev-parse", "origin/topic"));

    await expect(git.switchBranch("nope")).rejects.toBeInstanceOf(GitError);
  });

  it("refuses a fast-forward when the branches diverged", async () => {
    sh(work, "switch", "-q", "-c", "topic");
    await commit("mine");
    sh(work, "switch", "-q", "main");
    await commit("theirs");
    sh(work, "switch", "-q", "topic");
    await expect(createGit(work).fastForward("main")).rejects.toBeInstanceOf(GitError);
  });

  it("clones into a directory", async () => {
    const git = createGit(dir);
    await git.clone(bare, ["copy"]);
    expect(sh(join(dir, "copy"), "rev-parse", "HEAD")).toBe(sh(work, "rev-parse", "HEAD"));
    await expect(git.clone(join(dir, "missing.git"), [])).rejects.toBeInstanceOf(GitError);
  });

  it("rejects when git cannot start", async () => {
    await expect(createGit(join(dir, "gone")).topLevel()).rejects.toThrow();
    await expect(createGit(join(dir, "gone")).push("main")).rejects.toThrow();
  });
});
