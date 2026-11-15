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

  it("rejects when git cannot start", async () => {
    await expect(createGit(join(dir, "gone")).topLevel()).rejects.toThrow();
    await expect(createGit(join(dir, "gone")).push("main")).rejects.toThrow();
  });
});
