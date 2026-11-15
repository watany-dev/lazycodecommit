import { execFile, spawn } from "node:child_process";

/** A git command exited non-zero. `stderr` is git's own message. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(stderr.trim() || `git ${args.join(" ")} failed`);
    this.name = "GitError";
  }
}

export interface Commit {
  readonly subject: string;
  readonly body: string;
}

/** One path in `git diff-tree`: blob ids before and after, absent on an add or delete. */
export interface TreeChange {
  readonly status: string;
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}

interface LoggedCommit {
  readonly id: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly date: Date;
  readonly subject: string;
}

interface RemoteBranch {
  readonly name: string;
  readonly tip: string;
  readonly date: Date;
  readonly author: string;
}

/** The only door to git (spec: "git を呼ぶのはこの層だけ"). */
export interface Git {
  /** Repository root, or null outside a work tree. */
  topLevel(): Promise<string | null>;
  /** Checked-out branch, or null on a detached HEAD. */
  currentBranch(): Promise<string | null>;
  /** URL of the remote, or null when it is not configured. */
  remoteUrl(remote: string): Promise<string | null>;
  /** Commit id the ref points to, or null when it does not resolve. */
  resolveCommit(ref: string): Promise<string | null>;
  /**
   * Commits `branch` has that origin/<branch> lacks, or null when origin has no
   * such branch. Compared with origin/<branch>, not the upstream: the PR is
   * opened from the branch of the same name, whatever the upstream is.
   */
  unpushedCount(branch: string): Promise<number | null>;
  /** Commits in `base..head`, oldest first. */
  commits(base: string, head: string): Promise<Commit[]>;
  /** `git push -u origin <branch>`, with git's output on stderr. */
  push(branch: string): Promise<void>;
  /** `git fetch origin <refspec>...`, with git's output on stderr unless `quiet` (under the TUI). */
  fetch(refspecs: readonly string[], opts?: { readonly quiet: boolean }): Promise<void>;
  /**
   * `git switch <branch>` (which creates a tracking branch for a branch only on
   * origin), or `git switch -c <branch> --track <track>`. `quiet` keeps git's
   * output off the terminal, for the TUI.
   */
  switchBranch(
    branch: string,
    opts?: { readonly track?: string; readonly quiet?: boolean },
  ): Promise<void>;
  /** `git merge --ff-only <ref>` into the checked-out branch. */
  fastForward(ref: string): Promise<void>;
  /** `git clone <url> [args...]` in the working directory. */
  clone(url: string, args: readonly string[]): Promise<void>;
  /** Best common ancestor, or null when there is none or a commit is missing. */
  mergeBase(a: string, b: string): Promise<string | null>;
  /** Changed files between two commits, like GetDifferences: no rename detection. */
  diffTree(before: string, after: string): Promise<TreeChange[]>;
  /** Contents of a blob. */
  blob(id: string): Promise<Buffer>;
  /** Up to `max` commits in `base..head` along first parents, oldest first. */
  firstParentLog(base: string, head: string, max: number): Promise<LoggedCommit[]>;
  /** The remote-tracking branches of origin, by name, without origin/HEAD. */
  remoteBranches(): Promise<RemoteBranch[]>;
  /** Commits `head` has that `base` lacks (ahead) and the reverse (behind). */
  aheadBehind(base: string, head: string): Promise<{ ahead: number; behind: number }>;
}

const NO_BLOB = /^0+$/;

export function createGit(cwd: string): Git {
  function git(
    args: string[],
  ): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            // git itself could not start (not installed, cwd gone).
            reject(error);
            return;
          }
          resolve({ ok: !error, stdout, stderr, code: error ? (error.code as number) : 0 });
        },
      );
    });
  }

  async function value(args: string[]): Promise<string | null> {
    const r = await git(args);
    return r.ok ? r.stdout.trim() : null;
  }

  async function required(args: string[]): Promise<string> {
    const r = await git(args);
    if (!r.ok) throw new GitError(args, r.stderr, r.code);
    return r.stdout;
  }

  /** For commands the user watches: git's progress and errors go straight to stderr, so stdout stays clean for --json. */
  function streamed(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", 2, 2] });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new GitError(args, "", code));
      });
    });
  }

  return {
    topLevel: () => value(["rev-parse", "--show-toplevel"]),
    currentBranch: () => value(["symbolic-ref", "--short", "-q", "HEAD"]),
    remoteUrl: (remote) => value(["remote", "get-url", remote]),
    resolveCommit: (ref) => value(["rev-parse", "--verify", "-q", `${ref}^{commit}`]),

    async unpushedCount(branch) {
      const remote = `refs/remotes/origin/${branch}`;
      if ((await value(["rev-parse", "--verify", "-q", remote])) === null) return null;
      const out = await required(["rev-list", "--count", `${remote}..refs/heads/${branch}`]);
      return Number(out.trim());
    },

    async commits(base, head) {
      // NUL between subject and body, and -z puts NUL between commits: a commit
      // message can hold any byte but NUL.
      const out = await required([
        "log",
        "-z",
        "--reverse",
        "--format=%s%x00%b",
        `${base}..${head}`,
        "--",
      ]);
      const fields = out.split("\0");
      const commits: Commit[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        commits.push({ subject: fields[i] as string, body: (fields[i + 1] as string).trim() });
      }
      return commits;
    },

    push: (branch) => streamed(["push", "-u", "origin", branch]),
    async fetch(refspecs, opts) {
      const args = ["fetch", "origin", ...refspecs];
      if (opts?.quiet) await required(["-c", "advice.fetchShowForcedUpdates=false", ...args]);
      else await streamed(args);
    },
    async switchBranch(branch, opts) {
      // Ref names may start with "-": --end-of-options keeps one someone pushed
      // (say "--orphan=x") from being read as an option.
      const args = opts?.track
        ? ["switch", "-c", branch, "--track", opts.track]
        : ["switch", "--end-of-options", branch];
      if (opts?.quiet) await required(args);
      else await streamed(args);
    },
    fastForward: (ref) => streamed(["merge", "--ff-only", "--end-of-options", ref]),
    clone: (url, args) => streamed(["clone", url, ...args]),
    mergeBase: (a, b) => value(["merge-base", a, b]),

    async diffTree(before, after) {
      const out = await required(["diff-tree", "-r", "-z", "--no-renames", before, after]);
      // -z: ":<mode> <mode> <blob> <blob> <status>\0<path>\0" per file.
      const parts = out.split("\0");
      const changes: TreeChange[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const [, , a = "", b = "", status = ""] = (parts[i] as string).split(" ");
        changes.push({
          status,
          path: parts[i + 1] as string,
          ...(NO_BLOB.test(a) ? {} : { before: a }),
          ...(NO_BLOB.test(b) ? {} : { after: b }),
        });
      }
      return changes;
    },

    blob(id) {
      const args = ["cat-file", "blob", id];
      return new Promise((resolve, reject) => {
        execFile(
          "git",
          args,
          { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) reject(new GitError(args, stderr.toString("utf8"), error.code as number));
            else resolve(stdout);
          },
        );
      });
    },

    async remoteBranches() {
      const out = await required([
        "for-each-ref",
        // NUL between fields: an author name can hold any byte but NUL and newline.
        "--format=%(refname:lstrip=3)%00%(objectname)%00%(committerdate:iso-strict)%00%(authorname)",
        "refs/remotes/origin",
      ]);
      return out
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [name = "", tip = "", date = "", author = ""] = line.split("\0");
          return { name, tip, date: new Date(date), author };
        })
        .filter((b) => b.name !== "HEAD");
    },

    async aheadBehind(base, head) {
      const out = await required(["rev-list", "--left-right", "--count", `${base}...${head}`]);
      const [behind = 0, ahead = 0] = out.trim().split(/\s+/).map(Number);
      return { ahead, behind };
    },

    async firstParentLog(base, head, max) {
      // NUL-separated like commits(): names and subjects can hold any byte but NUL.
      const out = await required([
        "log",
        "-z",
        "--first-parent",
        `--max-count=${max}`,
        "--format=%H%x00%P%x00%an%x00%aI%x00%s",
        `${base}..${head}`,
        "--",
      ]);
      const fields = out.split("\0");
      const commits: LoggedCommit[] = [];
      for (let i = 0; i + 4 < fields.length; i += 5) {
        const [id, parents, author, date, subject] = fields.slice(i, i + 5) as [
          string,
          string,
          string,
          string,
          string,
        ];
        commits.push({
          id,
          parents: parents ? parents.split(" ") : [],
          author,
          date: new Date(date),
          subject,
        });
      }
      return commits.toReversed();
    },
  };
}
