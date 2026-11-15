import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withLock } from "./lock.js";

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, stat: vi.fn(real.stat) };
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "lazycc-lock-"));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe("withLock", () => {
  it("runs one holder at a time and removes the lock, even when the work throws", async () => {
    const path = join(dir, "x.json");
    const order: string[] = [];
    const hold = (name: string) =>
      withLock(path, async () => {
        order.push(`${name} in`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${name} out`);
      });
    await Promise.all([hold("a"), hold("b")]);
    // Whoever goes first, the other waits until it is out.
    expect(order.map((o) => o.slice(2))).toEqual(["in", "out", "in", "out"]);
    expect(order[0]?.[0]).toBe(order[1]?.[0]);
    await expect(
      withLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("tries again when the lock goes away before its age is read", async () => {
    const path = join(dir, "x.json");
    await fs.writeFile(`${path}.lock`, "");
    vi.mocked(fs.stat).mockImplementationOnce(async () => {
      await fs.rm(`${path}.lock`);
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    const work = vi.fn(async () => {});
    await withLock(path, work);
    expect(work).toHaveBeenCalledOnce();
  });

  it("passes on an error other than a held lock", async () => {
    await expect(withLock(join(dir, "x".repeat(300)), async () => {})).rejects.toThrow(
      /ENAMETOOLONG/,
    );
  });
});
