import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { UserError } from "../core/errors.js";
import type { Io } from "./main.js";

/** The real terminal. Prompts and the editor talk on stderr/tty so stdout stays data. */
export function processIo(): Io {
  const env = process.env;
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env,
    cwd: process.cwd(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),

    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
        return answer === "" || answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
    },

    async edit(text) {
      const dir = await mkdtemp(join(tmpdir(), "lazycc-"));
      const file = join(dir, "PULL_REQUEST_EDITMSG.md");
      try {
        await writeFile(file, text);
        const editor = env["VISUAL"] || env["EDITOR"] || "vi";
        // Through the shell, like git, so EDITOR="code --wait" works. The path
        // goes in as $1 so nothing in it is parsed by the shell.
        const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
        if (r.error || r.status !== 0) {
          throw new UserError(
            `Aborted: the editor (${editor}) exited with ${r.error?.message ?? `status ${r.status}`}`,
          );
        }
        return await readFile(file, "utf8");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async readFile(path, within) {
      try {
        if (within !== undefined) {
          const [real, root] = await Promise.all([realpath(path), realpath(within)]);
          if (!real.startsWith(root + sep)) {
            throw new UserError(`${path} resolves to ${real}, outside ${root}; not reading it`);
          }
        }
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
