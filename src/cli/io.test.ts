import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// null is Ctrl-D: readline closes and the question never settles, as in Node.
const answers: (string | null)[] = [];
const asked: string[] = [];
const closes = { count: 0 };
vi.mock("node:readline/promises", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    createInterface: () => {
      const rl = Object.assign(new Emitter(), {
        question: (q: string): Promise<string> => {
          asked.push(q);
          const answer = answers.shift();
          if (answer !== null) return Promise.resolve(answer ?? "");
          setImmediate(() => rl.emit("close"));
          return new Promise(() => {});
        },
        close: () => {
          closes.count++;
        },
      });
      return rl;
    },
  };
});

const { exitOnClosedPipe, processIo } = await import("./io.js");

let dir: string;
const saved = { ...process.env };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lazycc-io-"));
});
afterEach(async () => {
  process.env = { ...saved };
  await rm(dir, { recursive: true, force: true });
});

function interactiveWith(stdin: boolean | undefined, stdout: boolean | undefined) {
  Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
  return processIo().interactive;
}

describe("processIo", () => {
  it("reads files and returns null for missing ones", async () => {
    await writeFile(join(dir, "a"), "hello");
    const io = processIo();
    expect(await io.readFile(join(dir, "a"))).toBe("hello");
    expect(await io.readFile(join(dir, "missing"))).toBeNull();
    await expect(io.readFile(dir)).rejects.toThrow();
  });

  it("refuses a file that resolves outside `within`, such as a symlink a repository ships", async () => {
    const root = join(dir, "clone");
    await mkdir(join(root, ".codecommit"), { recursive: true });
    await writeFile(join(dir, "secret"), "AWS_SECRET_ACCESS_KEY=x");
    await writeFile(join(root, "inside.md"), "ok");
    await symlink(join(dir, "secret"), join(root, ".codecommit", "abs.md"));
    await symlink("../../secret", join(root, ".codecommit", "rel.md"));
    await symlink("../inside.md", join(root, ".codecommit", "inside.md"));
    const io = processIo();
    for (const name of ["abs.md", "rel.md"]) {
      await expect(io.readFile(join(root, ".codecommit", name), root)).rejects.toThrow("outside");
    }
    expect(await io.readFile(join(root, ".codecommit", "inside.md"), root)).toBe("ok");
    expect(await io.readFile(join(root, "missing.md"), root)).toBeNull();
    expect(await io.readFile(join(dir, "secret"))).toBe("AWS_SECRET_ACCESS_KEY=x");
  });

  it("returns what the editor saved", async () => {
    process.env["VISUAL"] = "";
    process.env["EDITOR"] = "sed -i.bak -e 's/Draft/Edited/'";
    expect(await processIo().edit("Draft title\n\nbody\n")).toBe("Edited title\n\nbody\n");
  });

  it("aborts when the editor fails", async () => {
    process.env["VISUAL"] = "false";
    await expect(processIo().edit("x")).rejects.toThrow("the editor (false) exited with status 1");
  });

  it.each([
    ["", true],
    ["y", true],
    ["YES", true],
    ["n", false],
    ["nope", false],
  ])("confirm reads %j as %s", async (answer, want) => {
    answers.push(answer);
    expect(await processIo().confirm("Push?")).toBe(want);
  });

  it("asks with the default shown, ignores spaces around the answer, and closes the prompt", async () => {
    asked.length = 0;
    closes.count = 0;
    answers.push(" y ");
    expect(await processIo().confirm("Push?")).toBe(true);
    expect(asked).toEqual(["Push? [Y/n] "]);
    expect(closes.count).toBe(1);
  });

  it("is interactive only when both stdin and stdout are terminals", () => {
    const was = [process.stdin.isTTY, process.stdout.isTTY];
    try {
      expect(interactiveWith(true, true)).toBe(true);
      expect(interactiveWith(true, false)).toBe(false);
      expect(interactiveWith(false, true)).toBe(false);
    } finally {
      interactiveWith(was[0], was[1]);
    }
  });

  it("edits a file named like git's in its own temporary folder, removed afterwards", async () => {
    process.env["VISUAL"] = "";
    process.env["EDITOR"] = `f() { printf %s "$1" > "$1"; }; f`;
    const path = await processIo().edit("x");
    expect(basename(path)).toBe("PULL_REQUEST_EDITMSG.md");
    expect(basename(dirname(path))).toMatch(/^lazycc-/);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("takes Ctrl-D at the prompt as no, instead of waiting forever", async () => {
    answers.push(null);
    expect(await processIo().confirm("Push?")).toBe(false);
  });

  it("writes lines to stdout and stderr", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const io = processIo();
    io.out("o");
    io.err("e");
    expect(out).toHaveBeenCalledWith("o\n");
    expect(err).toHaveBeenCalledWith("e\n");
    out.mockRestore();
    err.mockRestore();
  });
});

describe("exitOnClosedPipe", () => {
  // `lazycc pr list | head -1`: the reader closes the pipe and the next write fails.
  it("exits quietly with 0 when the reader closed the pipe", () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    exitOnClosedPipe(stream, exit);
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("rethrows any other stream error", () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    exitOnClosedPipe(stream, exit);
    expect(() => stream.emit("error", Object.assign(new Error("EIO"), { code: "EIO" }))).toThrow(
      "EIO",
    );
    expect(exit).not.toHaveBeenCalled();
  });
});
