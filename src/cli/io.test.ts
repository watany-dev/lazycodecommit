import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: string[] = [];
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: async () => answers.shift() ?? "", close: () => {} }),
}));

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
