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
}

const FIELD = "\x1f";
const RECORD = "\x1e";

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
      const out = await required([
        "log",
        "--reverse",
        `--format=%s${FIELD}%b${RECORD}`,
        `${base}..${head}`,
        "--",
      ]);
      return out
        .split(RECORD)
        .map((record) => record.replace(/^\n/, ""))
        .filter((record) => record !== "")
        .map((record) => {
          const [subject = "", body = ""] = record.split(FIELD);
          return { subject, body: body.trim() };
        });
    },

    push(branch) {
      const args = ["push", "-u", "origin", branch];
      return new Promise((resolve, reject) => {
        // git's progress and errors go straight to the user's stderr; stdout
        // stays clean for --json.
        const child = spawn("git", args, { cwd, stdio: ["ignore", 2, 2] });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new GitError(args, "", code));
        });
      });
    },
  };
}
