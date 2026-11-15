import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, configPath, loadConfig, saveRepos } from "./config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lazycc-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(text: string) {
  await mkdir(join(dir, "lazycc"), { recursive: true });
  await writeFile(join(dir, "lazycc", "config.json"), text);
}

describe("configPath", () => {
  it("follows XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/lazycc/config.json");
  });
  it("falls back to ~/.config", () => {
    expect(configPath({ HOME: "/home/u" })).toBe("/home/u/.config/lazycc/config.json");
    // The XDG spec: a relative path is invalid and must be ignored.
    expect(configPath({ XDG_CONFIG_HOME: "rel", HOME: "/home/u" })).toBe(
      "/home/u/.config/lazycc/config.json",
    );
  });
  it("uses the OS home when HOME is unset", () => {
    expect(configPath({})).toMatch(/\.config\/lazycc\/config\.json$/);
  });
});

describe("loadConfig", () => {
  it("returns an empty config when the file is missing", async () => {
    expect(await loadConfig({ XDG_CONFIG_HOME: dir })).toEqual({});
  });

  it("reads the spec's example", async () => {
    const config = {
      profile: "dev",
      region: "ap-northeast-1",
      repos: ["my-service", "my-infra"],
      pr: { template: ".codecommit/pull_request_template.md", mergeOption: "squash" },
      branch: { closedPrLookback: 100 },
      concurrency: 8,
      ci: {
        "my-service": { codebuild: ["my-service-pr-check"], codepipeline: ["my-service-release"] },
      },
      future: true,
    };
    await write(JSON.stringify(config));
    expect(await loadConfig({ XDG_CONFIG_HOME: dir })).toEqual(config);
  });

  it("reads a file saved with a UTF-8 byte order mark", async () => {
    // Windows editors add one; JSON.parse rejects it.
    await write('\uFEFF{"region":"us-east-1"}');
    expect(await loadConfig({ XDG_CONFIG_HOME: dir })).toEqual({ region: "us-east-1" });
  });

  it("reports broken JSON with the path", async () => {
    await write("{ nope");
    await expect(loadConfig({ XDG_CONFIG_HOME: dir })).rejects.toThrow(
      new RegExp(`^${join(dir, "lazycc", "config.json")}: invalid JSON`),
    );
  });

  it("reports an unreadable file", async () => {
    await mkdir(join(dir, "lazycc", "config.json"), { recursive: true });
    await expect(loadConfig({ XDG_CONFIG_HOME: dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it.each([
    ["[]", '"(top level)" must be an object'],
    ['{"profile": 1}', '"profile" must be a non-empty string'],
    ['{"region": ""}', '"region" must be a non-empty string'],
    ['{"repos": "a"}', '"repos" must be an array of non-empty strings'],
    ['{"repos": ["a", 1]}', '"repos" must be an array of non-empty strings'],
    ['{"concurrency": 0}', '"concurrency" must be a positive integer'],
    ['{"concurrency": 1.5}', '"concurrency" must be a positive integer'],
    ['{"pr": []}', '"pr" must be an object'],
    ['{"pr": {"template": 3}}', '"pr.template" must be a non-empty string'],
    ['{"pr": {"mergeOption": "rebase"}}', '"pr.mergeOption" must be one of'],
    [
      '{"branch": {"closedPrLookback": -1}}',
      '"branch.closedPrLookback" must be a positive integer',
    ],
    ['{"ci": []}', '"ci" must be an object'],
    ['{"ci": {"a": []}}', '"ci.a" must be an object'],
    ['{"ci": {"a": {"codebuild": "p"}}}', '"ci.a.codebuild" must be an array of non-empty strings'],
    [
      '{"ci": {"a": {"codepipeline": [""]}}}',
      '"ci.a.codepipeline" must be an array of non-empty strings',
    ],
  ])("rejects %s", async (text, message) => {
    await write(text);
    await expect(loadConfig({ XDG_CONFIG_HOME: dir })).rejects.toThrow(message);
  });
});

const env = () => ({ XDG_CONFIG_HOME: dir });
const read = async () => JSON.parse(await readFile(join(dir, "lazycc", "config.json"), "utf8"));

describe("saveRepos", () => {
  it("creates the file when there is none", async () => {
    await saveRepos(env(), () => ["a"]);
    expect(await read()).toEqual({ repos: ["a"] });
  });

  it("keeps the other keys, including unknown ones, and drops an empty list", async () => {
    await write('{"region":"us-east-1","future":{"x":1},"repos":["a"]}');
    await saveRepos(env(), () => ["a", "b"]);
    expect(await read()).toEqual({ region: "us-east-1", future: { x: 1 }, repos: ["a", "b"] });
    await saveRepos(env(), () => []);
    expect(await read()).toEqual({ region: "us-east-1", future: { x: 1 } });
  });

  it("leaves a broken file alone", async () => {
    await write("{oops");
    await expect(saveRepos(env(), () => ["a"])).rejects.toThrow(ConfigError);
    expect(await readFile(join(dir, "lazycc", "config.json"), "utf8")).toBe("{oops");
  });

  it("saves from two lazycc at once one after the other, and leaves no lock", async () => {
    const { readdir } = await import("node:fs/promises");
    await write('{"region":"us-east-1"}');
    await Promise.all([saveRepos(env(), () => ["a"]), saveRepos(env(), () => ["b"])]);
    expect([["a"], ["b"]]).toContainEqual((await read())["repos"]);
    expect(await read()).toMatchObject({ region: "us-east-1" });
    expect(await readdir(join(dir, "lazycc"))).toEqual(["config.json"]);
  });

  it("writes through a symlinked config", async () => {
    const { symlink, lstat } = await import("node:fs/promises");
    await writeFile(join(dir, "real.json"), "{}");
    await mkdir(join(dir, "lazycc"), { recursive: true });
    await symlink(join(dir, "real.json"), join(dir, "lazycc", "config.json"));
    await saveRepos(env(), () => ["a"]);
    expect((await lstat(join(dir, "lazycc", "config.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "real.json"), "utf8"))).toEqual({ repos: ["a"] });
  });
});
