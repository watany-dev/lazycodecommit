import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGit } from "./git.js";

let dir: string;
const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "lazycc-git-prop-")));
  sh("init", "-q", "-b", "main");
  sh("config", "user.name", "t");
  sh("config", "user.email", "t@example.com");
  sh("config", "commit.gpgsign", "false");
  sh("commit", "-q", "--allow-empty", "-m", "initial");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

// Messages built from the characters that matter to parsing: line breaks,
// blank lines, comment markers, the ASCII separators, non-ASCII.
const message = fc.string({
  unit: fc.constantFrom(
    "a",
    "Z",
    " ",
    "\n",
    "\n\n",
    "\r",
    "\t",
    "#",
    "-",
    "é",
    "日",
    "\x1e",
    "\x1f",
  ),
  minLength: 1,
  maxLength: 30,
});

describe("Git.commits on a real repository", () => {
  it("returns each commit's subject and body as git itself reads them", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(message, { minLength: 1, maxLength: 3 }), async (messages) => {
        const base = sh("rev-parse", "HEAD").trim();
        const want = [];
        for (const m of messages) {
          await writeFile(join(dir, "MSG"), m);
          sh("commit", "-q", "--allow-empty", "--allow-empty-message", "-F", join(dir, "MSG"));
          want.push({
            subject: sh("log", "-1", "--format=%s").replace(/\n$/, ""),
            body: sh("log", "-1", "--format=%b").trim(),
          });
        }
        expect(await createGit(dir).commits(base, "HEAD")).toEqual(want);
      }),
      { numRuns: 40 },
    );
  }, 60_000);
});
