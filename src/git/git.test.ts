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

/**
 * A clone made with --depth 1 fetches only the default branch: remote.origin.fetch
 * does not cover refs/heads/topic, so git itself never maps it to origin/topic.
 */
async function singleBranchClone(): Promise<string> {
  sh(work, "switch", "-q", "-c", "topic");
  await commit("topic work");
  sh(work, "push", "-q", "origin", "topic");
  sh(dir, "clone", "-q", "--depth", "1", `file://${bare}`, "shallow");
  const clone = join(dir, "shallow");
  sh(clone, "config", "user.name", "t");
  sh(clone, "config", "user.email", "t@example.com");
  return clone;
}

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
    sh(work, "update-ref", "-d", "refs/remotes/origin/topic");
    await git.fetch(["+refs/heads/topic:refs/remotes/origin/topic"], { quiet: true });
    expect(await git.resolveCommit("refs/remotes/origin/topic")).toBe(tip);
    await expect(git.fetch(["refs/heads/nope:x"], { quiet: true })).rejects.toThrow(/nope/);
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

  describe("in a single-branch clone (git clone --depth 1 or --single-branch)", () => {
    it("creates a branch from origin/<branch> that tracks it", async () => {
      const clone = await singleBranchClone();
      const git = createGit(clone);
      await git.fetch(["+refs/heads/topic:refs/remotes/origin/topic"], { quiet: true });
      for (const quiet of [true, false]) {
        await git.switchBranch("topic", { track: "refs/remotes/origin/topic", quiet });
        expect(await git.currentBranch()).toBe("topic");
        expect(sh(clone, "rev-parse", "topic")).toBe(sh(work, "rev-parse", "topic"));
        expect(sh(clone, "config", "branch.topic.remote")).toBe("origin");
        expect(sh(clone, "config", "branch.topic.merge")).toBe("refs/heads/topic");
        sh(clone, "switch", "-q", "main");
        sh(clone, "branch", "-q", "-D", "topic");
      }
    });

    it("sets the upstream up as --track would under branch.autoSetupRebase", async () => {
      const clone = await singleBranchClone();
      const git = createGit(clone);
      await git.fetch(["+refs/heads/topic:refs/remotes/origin/topic"], { quiet: true });
      for (const [setting, rebase] of [
        ["always", "true"],
        ["remote", "true"],
        ["local", ""],
        ["never", ""],
      ] as const) {
        sh(clone, "config", "branch.autoSetupRebase", setting);
        await git.switchBranch("topic", { track: "refs/remotes/origin/topic", quiet: true });
        expect(sh(clone, "config", "--default", "", "branch.topic.rebase")).toBe(rebase);
        sh(clone, "switch", "-q", "main");
        sh(clone, "branch", "-q", "-D", "topic");
      }
    });

    it("knows a pushed branch is on origin", async () => {
      const clone = await singleBranchClone();
      sh(clone, "switch", "-q", "-c", "mine");
      await writeFile(join(clone, "g.txt"), "x\n");
      sh(clone, "add", ".");
      sh(clone, "commit", "-q", "-m", "mine");
      const git = createGit(clone);
      expect(await git.unpushedCount("mine")).toBeNull();
      await git.push("mine");
      expect(await git.unpushedCount("mine")).toBe(0);
    });
  });

  it("reads a branch name starting with a dash as a name, not an option", async () => {
    // Git accepts such ref names, so anyone who can push can create one.
    sh(work, "push", "-q", "origin", "HEAD:refs/heads/--orphan=pwn");
    sh(work, "fetch", "-q", "origin");
    const git = createGit(work);
    for (const quiet of [true, false]) {
      await expect(git.switchBranch("--orphan=pwn", { quiet })).rejects.toBeInstanceOf(GitError);
      expect(await git.currentBranch()).toBe("main");
    }
    await expect(git.fastForward("--no-ff")).rejects.toBeInstanceOf(GitError);
    expect(sh(work, "ls-files")).toBe("f.txt");
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

  it("lists changed blobs between two commits, without rename detection", async () => {
    await writeFile(join(work, "keep.txt"), "same\n");
    await writeFile(join(work, "gone.txt"), "bye\n");
    sh(work, "add", ".");
    sh(work, "commit", "-q", "-m", "base");
    const base = sh(work, "rev-parse", "HEAD");
    await writeFile(join(work, "keep.txt"), "changed\n");
    sh(work, "mv", "gone.txt", "moved.txt");
    await writeFile(join(work, "new file.txt"), "hi\n");
    sh(work, "add", ".");
    sh(work, "commit", "-q", "-m", "change");
    const head = sh(work, "rev-parse", "HEAD");
    const blob = (rev: string) => sh(work, "rev-parse", rev);
    const changes = await createGit(work).diffTree(base, head);
    expect(changes).toEqual([
      { status: "D", path: "gone.txt", before: blob(`${base}:gone.txt`) },
      {
        status: "M",
        path: "keep.txt",
        before: blob(`${base}:keep.txt`),
        after: blob(`${head}:keep.txt`),
      },
      { status: "A", path: "moved.txt", after: blob(`${head}:moved.txt`) },
      { status: "A", path: "new file.txt", after: blob(`${head}:new file.txt`) },
    ]);
    expect(await createGit(work).diffTree(head, head)).toEqual([]);
    await expect(createGit(work).diffTree("nope", head)).rejects.toBeInstanceOf(GitError);
  });

  it("reads a blob as bytes", async () => {
    await writeFile(join(work, "bin"), Buffer.from([0, 1, 2, 255]));
    sh(work, "add", ".");
    sh(work, "commit", "-q", "-m", "bin");
    const git = createGit(work);
    expect([...(await git.blob(sh(work, "rev-parse", "HEAD:bin")))]).toEqual([0, 1, 2, 255]);
    await expect(git.blob("0".repeat(40))).rejects.toBeInstanceOf(GitError);
  });

  it("finds the merge base and walks first parents newest last", async () => {
    const base = sh(work, "rev-parse", "HEAD");
    sh(work, "switch", "-q", "-c", "topic");
    await commit("one");
    await commit("two\n\nbody");
    sh(work, "switch", "-q", "main");
    await commit("main moves");
    const git = createGit(work);
    expect(await git.mergeBase("main", "topic")).toBe(base);
    expect(await git.mergeBase("main", "nope")).toBeNull();
    const log = await git.firstParentLog(base, "topic", 100);
    expect(log.map((c) => c.subject)).toEqual(["one", "two"]);
    expect(log[0]).toMatchObject({
      id: sh(work, "rev-parse", "topic~1"),
      parents: [base],
      author: "t",
    });
    expect(log[0]?.date).toBeInstanceOf(Date);
    expect((await git.firstParentLog(base, "topic", 1)).map((c) => c.subject)).toEqual(["two"]);
    await expect(git.firstParentLog("nope", "topic", 1)).rejects.toBeInstanceOf(GitError);
  });

  it("lists origin's branches with their last commit, and counts ahead/behind", async () => {
    sh(work, "switch", "-q", "-c", "topic");
    await commit("one");
    await commit("two");
    sh(work, "push", "-q", "origin", "topic");
    sh(work, "switch", "-q", "main");
    await commit("main moves");
    sh(work, "push", "-q", "origin", "main");
    sh(work, "remote", "set-head", "origin", "main");
    const git = createGit(work);
    const branches = await git.remoteBranches();
    expect(branches.map((b) => b.name)).toEqual(["main", "topic"]);
    expect(branches[1]).toMatchObject({ tip: sh(work, "rev-parse", "origin/topic"), author: "t" });
    expect(branches[1]?.date).toBeInstanceOf(Date);
    expect(await git.aheadBehind("origin/main", "origin/topic")).toEqual({ ahead: 2, behind: 1 });
    await expect(git.aheadBehind("origin/main", "origin/nope")).rejects.toBeInstanceOf(GitError);
  });

  it("reads an author name holding the ASCII unit separator", async () => {
    sh(work, "switch", "-q", "-c", "odd");
    await writeFile(join(work, "f.txt"), "odd\n");
    sh(work, "-c", "user.name=a\x1fb", "commit", "-q", "-am", "odd");
    sh(work, "push", "-q", "origin", "odd");
    const odd = (await createGit(work).remoteBranches()).find((b) => b.name === "odd");
    expect(odd).toMatchObject({ author: "a\x1fb", tip: sh(work, "rev-parse", "origin/odd") });
    expect(odd?.date.getTime()).not.toBeNaN();
  });

  it("switches quietly when asked", async () => {
    sh(work, "switch", "-q", "-c", "topic");
    sh(work, "push", "-q", "origin", "topic");
    sh(work, "switch", "-q", "main");
    sh(work, "branch", "-q", "-D", "topic");
    const git = createGit(work);
    await git.switchBranch("topic", { quiet: true });
    expect(await git.currentBranch()).toBe("topic");
    await expect(git.switchBranch("nope", { quiet: true })).rejects.toThrow(/nope/);
  });

  it("names the branch even when a tag has the same name", async () => {
    sh(work, "switch", "-q", "-c", "topic");
    sh(work, "tag", "topic");
    expect(await createGit(work).currentBranch()).toBe("topic");
  });

  it("pushes the branch when a tag has the same name", async () => {
    sh(work, "switch", "-q", "-c", "topic");
    await commit("topic work");
    sh(work, "tag", "topic", "main");
    const git = createGit(work);
    await git.push("topic");
    expect(sh(bare, "rev-parse", "refs/heads/topic")).toBe(
      sh(work, "rev-parse", "refs/heads/topic"),
    );
    expect(await git.unpushedCount("topic")).toBe(0);
  });

  it("keeps signature checks out of the parsed log with log.showSignature", async () => {
    // A commit with a signature gpg cannot verify: with log.showSignature on,
    // git prints the result of the check into the log output.
    const parent = sh(work, "rev-parse", "HEAD");
    const tree = sh(work, "rev-parse", "HEAD^{tree}");
    const object = join(dir, "signed.txt");
    await writeFile(
      object,
      [
        `tree ${tree}`,
        `parent ${parent}`,
        "author t <t@example.com> 1700000000 +0000",
        "committer t <t@example.com> 1700000000 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " ",
        " AAAA",
        " -----END PGP SIGNATURE-----",
        "",
        "signed subject",
        "",
        "signed body",
        "",
      ].join("\n"),
    );
    const signed = sh(work, "hash-object", "-t", "commit", "-w", object);
    sh(work, "update-ref", "refs/heads/signed", signed);
    sh(work, "config", "log.showSignature", "true");
    const git = createGit(work);
    expect(await git.commits(parent, "signed")).toEqual([
      { subject: "signed subject", body: "signed body" },
    ]);
    const [logged] = await git.firstParentLog(parent, "signed", 5);
    expect(logged).toMatchObject({ id: signed, parents: [parent], subject: "signed subject" });
  });

  it("reads the log as UTF-8 whatever i18n.logOutputEncoding says", async () => {
    const base = sh(work, "rev-parse", "HEAD");
    sh(work, "switch", "-q", "-c", "topic");
    await commit("café");
    sh(work, "config", "i18n.logOutputEncoding", "ISO-8859-1");
    const git = createGit(work);
    expect(await git.commits(base, "topic")).toEqual([{ subject: "café", body: "" }]);
    expect((await git.firstParentLog(base, "topic", 5))[0]?.subject).toBe("café");
  });

  it("rejects when git cannot start", async () => {
    await expect(createGit(join(dir, "gone")).topLevel()).rejects.toThrow();
    await expect(createGit(join(dir, "gone")).push("main")).rejects.toThrow();
  });
});
