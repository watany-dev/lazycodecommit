import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalState, seenKey, stateDir } from "./local.js";

let home: string;
let dir: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lazycc-state-"));
  dir = join(home, ".local", "state", "lazycc");
});
afterEach(() => rm(home, { recursive: true, force: true }));

const state = () => createLocalState({ HOME: home });
const put = async (name: string, text: string) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), text);
};

describe("stateDir", () => {
  it("follows XDG_STATE_HOME, then HOME", () => {
    expect(stateDir({ XDG_STATE_HOME: "/x", HOME: "/h" })).toBe("/x/lazycc");
    expect(stateDir({ HOME: "/h" })).toBe("/h/.local/state/lazycc");
    expect(stateDir({})).toMatch(/\.local\/state\/lazycc$/);
  });
});

describe("identity", () => {
  it("round-trips per key and ignores what is not an ARN", async () => {
    const s = state();
    expect(await s.identity.get("dev")).toBeUndefined();
    await s.identity.set("dev", "arn:aws:iam::1:user/me");
    await s.identity.set("prod", "arn:aws:iam::2:user/me");
    expect(await s.identity.get("dev")).toBe("arn:aws:iam::1:user/me");
    await put("identity.json", '{"dev": 3, "x": "nope"}');
    expect(await s.identity.get("dev")).toBeUndefined();
    expect(await s.identity.get("x")).toBeUndefined();
  });
});

describe("seen", () => {
  it("keeps the latest time per PR", async () => {
    const s = state();
    const key = seenKey("us-east-1", "7");
    expect(key).toBe("us-east-1/7");
    await s.seen.mark(key, new Date("2026-11-02T00:00:00Z"));
    await s.seen.mark(key, new Date("2026-11-01T00:00:00Z"));
    expect((await s.seen.all()).get(key)).toEqual(new Date("2026-11-02T00:00:00Z"));
    await s.seen.mark(key, new Date("2026-11-03T00:00:00Z"));
    expect((await s.seen.all()).get(key)).toEqual(new Date("2026-11-03T00:00:00Z"));
  });

  it("drops entries that are not dates", async () => {
    await put("seen.json", '{"a/1": "2026-11-01T00:00:00Z", "a/2": "soon", "a/3": 5}');
    expect([...(await state().seen.all()).keys()]).toEqual(["a/1"]);
  });

  it("overwrites an entry that is not a date", async () => {
    await put("seen.json", '{"a/1": 5}');
    await state().seen.mark("a/1", new Date("2026-11-01T00:00:00Z"));
    expect((await state().seen.all()).get("a/1")).toEqual(new Date("2026-11-01T00:00:00Z"));
  });
});

describe("cache", () => {
  it("keeps sections apart", async () => {
    const s = state();
    await s.cache.set("home", { a: 1 });
    await s.cache.set("branch", [2]);
    expect(await s.cache.get("home")).toEqual({ a: 1 });
    expect(await s.cache.get("branch")).toEqual([2]);
    expect(await s.cache.get("browse")).toBeUndefined();
  });
});

describe("corrupt files", () => {
  it.each([["{not json"], ["[1,2]"], ["null"], ['"text"']])(
    "reads %s as empty and rewrites it on save",
    async (text) => {
      await put("cache.json", text);
      const s = state();
      expect(await s.cache.get("home")).toBeUndefined();
      await s.cache.set("home", 1);
      expect(JSON.parse(await readFile(join(dir, "cache.json"), "utf8"))).toEqual({ home: 1 });
    },
  );
});

describe("concurrent saves", () => {
  it("keeps every update made at once", async () => {
    const s = state();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.seen.mark(`r/${i}`, new Date(1000 + i))),
    );
    expect((await s.seen.all()).size).toBe(10);
  });

  it("keeps saving after a failed save", async () => {
    await mkdir(join(home, ".local", "state"), { recursive: true });
    await writeFile(dir, "a file where the directory should be");
    const s = state();
    await expect(s.cache.set("home", 1)).rejects.toThrow();
    await rm(dir);
    await s.cache.set("home", 2);
    expect(await s.cache.get("home")).toBe(2);
  });
});

describe("flush", () => {
  it("waits for saves in flight", async () => {
    const s = state();
    void s.cache.set("home", 1);
    await s.flush();
    expect(JSON.parse(await readFile(join(dir, "cache.json"), "utf8"))).toEqual({ home: 1 });
  });
});

describe("file modes", () => {
  it("keeps state readable by the user only: it holds private repositories' PR titles", async () => {
    const s = state();
    await s.cache.set("home", { title: "secret project" });
    await s.seen.mark(seenKey("us-east-1", "1"), new Date());
    await s.identity.set("dev", "arn:aws:iam::1:user/me");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const name of ["cache.json", "seen.json", "identity.json"]) {
      expect((await stat(join(dir, name))).mode & 0o777, name).toBe(0o600);
    }
  });
});

describe("drafts", () => {
  it("keeps each PR's list, removes an emptied one, and writes the file user-only", async () => {
    const s = state();
    expect(await s.drafts.get("r/1")).toBeUndefined();
    await s.drafts.set("r/1", [{ id: "a" }]);
    await s.drafts.set("r/2", [{ id: "b" }]);
    expect(await s.drafts.get("r/1")).toEqual([{ id: "a" }]);
    await s.drafts.set("r/1", []);
    expect(JSON.parse(await readFile(join(dir, "drafts.json"), "utf8"))).toEqual({
      "r/2": [{ id: "b" }],
    });
    expect((await stat(join(dir, "drafts.json"))).mode & 0o777).toBe(0o600);
  });

  it("reads a corrupt file as empty", async () => {
    await put("drafts.json", "{not json");
    expect(await state().drafts.get("r/1")).toBeUndefined();
  });
});
