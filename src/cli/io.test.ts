import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: string[] = [];
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: async () => answers.shift() ?? "", close: () => {} }),
}));

const { processIo } = await import("./io.js");

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
