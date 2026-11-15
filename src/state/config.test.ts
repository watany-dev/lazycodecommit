import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, configPath, loadConfig } from "./config.js";

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
  ])("rejects %s", async (text, message) => {
    await write(text);
    await expect(loadConfig({ XDG_CONFIG_HOME: dir })).rejects.toThrow(message);
  });
});
