import { describe, expect, it } from "vitest";
import type { FileChange } from "../aws/codecommit.js";
import { GitError } from "../git/git.js";
import { fakeApi, fakeGit, pullRequest } from "../testing/fakes.js";
import { pullRequestDiff } from "./diff.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** An API whose GetDifferences answers `changes` and whose GetBlob reads `blobs` by id. */
function apiWith(changes: FileChange[], blobs: Record<string, string | Uint8Array>) {
  const calls: string[] = [];
  const api = fakeApi([], {
    differences: async (repo, before, after) => {
      calls.push(`differences ${repo} ${before} ${after}`);
      return changes;
    },
    blob: async (_repo, id) => {
      const b = blobs[id];
      if (b === undefined) throw new Error(`no blob ${id}`);
      return typeof b === "string" ? enc(b) : b;
    },
  });
  return { api, calls };
}

const side = (id: string, mode = "100644") => ({ id, mode });

describe("pullRequestDiff from the API", () => {
  it("diffs from the merge base, as git diff base..source would", async () => {
    const { api, calls } = apiWith([], {});
    const pr = pullRequest({ mergeBase: "mb", destinationCommit: "d1", sourceCommit: "s1" });
    expect(await pullRequestDiff(pr, { api })).toBe("");
    expect(calls).toEqual(["differences demo mb s1"]);
  });

  it("falls back to the destination tip when CodeCommit gives no merge base", async () => {
    const { api, calls } = apiWith([], {});
    await pullRequestDiff(pullRequest({ destinationCommit: "d1" }), { api });
    expect(calls).toEqual(["differences demo d1 s1"]);
  });

  it("writes a modified file as a unified diff with three lines of context", async () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
    const after = "1\n2\n3\n4\nfive\n6\n7\n8\n9\n10\n";
    const { api } = apiWith([{ path: "src/a.txt", before: side("b1"), after: side("b2") }], {
      b1: before,
      b2: after,
    });
    expect(await pullRequestDiff(pullRequest(), { api })).toBe(
      [
        "diff --git a/src/a.txt b/src/a.txt",
        "--- a/src/a.txt",
        "+++ b/src/a.txt",
        "@@ -2,7 +2,7 @@",
        " 2",
        " 3",
        " 4",
        "-5",
        "+five",
        " 6",
        " 7",
        " 8",
        "",
      ].join("\n"),
    );
  });

  it("splits changes more than six lines apart into hunks and joins closer ones", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${i + 1}`);
    const after = lines.map((l) => (l === "2" || l === "8" || l === "20" ? `${l}!` : l));
    const { api } = apiWith([{ path: "f", before: side("b1"), after: side("b2") }], {
      b1: `${lines.join("\n")}\n`,
      b2: `${after.join("\n")}\n`,
    });
    const out = await pullRequestDiff(pullRequest(), { api });
    expect(out.split("\n").filter((l) => l.startsWith("@@"))).toEqual([
      "@@ -1,11 +1,11 @@",
      "@@ -17,7 +17,7 @@",
    ]);
  });

  it("writes an added and a deleted file with their modes, as git apply needs", async () => {
    const { api } = apiWith(
      [
        { path: "new.sh", after: side("n", "100755") },
        { path: "old.txt", before: side("o") },
      ],
      { n: "#!/bin/sh\necho hi\n", o: "gone\n" },
    );
    expect(await pullRequestDiff(pullRequest(), { api })).toBe(
      [
        "diff --git a/new.sh b/new.sh",
        "new file mode 100755",
        "--- /dev/null",
        "+++ b/new.sh",
        "@@ -0,0 +1,2 @@",
        "+#!/bin/sh",
        "+echo hi",
        "diff --git a/old.txt b/old.txt",
        "deleted file mode 100644",
        "--- a/old.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
        "",
      ].join("\n"),
    );
  });

  it("writes an empty new file as its header alone", async () => {
    const { api } = apiWith([{ path: "e", after: side("n") }], { n: "" });
    expect(await pullRequestDiff(pullRequest(), { api })).toBe(
      "diff --git a/e b/e\nnew file mode 100644\n",
    );
  });

  it("marks a last line without a newline, as git does", async () => {
    const { api } = apiWith([{ path: "f", before: side("b1"), after: side("b2") }], {
      b1: "a\nb",
      b2: "a\nb\n",
    });
    expect(await pullRequestDiff(pullRequest(), { api })).toBe(
      [
        "diff --git a/f b/f",
        "--- a/f",
        "+++ b/f",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "\\ No newline at end of file",
        "+b",
        "",
      ].join("\n"),
    );
  });

  it("writes a mode change, and no hunk when the blob is the same", async () => {
    const { api } = apiWith([{ path: "run", before: side("x"), after: side("x", "100755") }], {});
    expect(await pullRequestDiff(pullRequest(), { api })).toBe(
      "diff --git a/run b/run\nold mode 100644\nnew mode 100755\n",
    );
  });

  it("says a binary file differs instead of diffing it", async () => {
    const { api } = apiWith(
      [
        { path: "img.png", before: side("p1"), after: side("p2") },
        { path: "new.bin", after: side("p3") },
      ],
      { p1: new Uint8Array([1, 0, 2]), p2: "now text\n", p3: new Uint8Array([0]) },
    );
    expect(await pullRequestDiff(pullRequest(), { api })).toBe(
      [
        "diff --git a/img.png b/img.png",
        "Binary files a/img.png and b/img.png differ",
        "diff --git a/new.bin b/new.bin",
        "new file mode 100644",
        "Binary files /dev/null and b/new.bin differ",
        "",
      ].join("\n"),
    );
  });

  it("orders files by path, as git diff does", async () => {
    const { api } = apiWith(
      [
        { path: "b", after: side("1") },
        { path: "a", after: side("1") },
      ],
      { "1": "x\n" },
    );
    const out = await pullRequestDiff(pullRequest(), { api });
    expect(out.split("\n").filter((l) => l.startsWith("diff --git"))).toEqual([
      "diff --git a/a b/a",
      "diff --git a/b b/b",
    ]);
  });

  it("fails when a blob cannot be read rather than leave a file out", async () => {
    const { api } = apiWith([{ path: "f", after: side("missing") }], {});
    await expect(pullRequestDiff(pullRequest(), { api })).rejects.toThrow("no blob missing");
  });
});

describe("pullRequestDiff in a clone", () => {
  it("prints git diff from the merge base to the source commit", async () => {
    const calls: string[] = [];
    const git = fakeGit({
      diff: async (before, after) => {
        calls.push(`${before}..${after}`);
        return "diff --git a/x b/x\n";
      },
    });
    const { api, calls: apiCalls } = apiWith([], {});
    const pr = pullRequest({ mergeBase: "mb" });
    expect(await pullRequestDiff(pr, { api, git })).toBe("diff --git a/x b/x\n");
    expect(calls).toEqual(["mb..s1"]);
    expect(apiCalls).toEqual([]);
  });

  it("asks the API when git does not have the commits", async () => {
    const git = fakeGit({
      diff: async () => {
        throw new GitError(["diff"], "fatal: bad object s1", 128);
      },
    });
    const { api, calls } = apiWith([{ path: "f", after: side("n") }], { n: "x\n" });
    const out = await pullRequestDiff(pullRequest(), { api, git });
    expect(calls).toEqual(["differences demo d1 s1"]);
    expect(out).toContain("+x");
  });
});
