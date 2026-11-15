import { describe, expect, it } from "vitest";
import { fakeGit } from "../testing/fakes.js";
import { resolveAccountContext, resolveContext } from "./context.js";

const GRC = "codecommit::eu-west-1://remote-profile@demo";

describe("resolveContext", () => {
  it("reads the repository, region and profile from origin", async () => {
    const ctx = await resolveContext({
      git: fakeGit({ remoteUrl: async () => GRC }),
      env: {},
      config: {},
    });
    expect(ctx).toEqual({
      repository: "demo",
      region: "eu-west-1",
      profile: "remote-profile",
      clone: { root: "/work" },
    });
  });

  it("puts flags first", async () => {
    const ctx = await resolveContext({
      repo: "demo",
      region: "eu-west-1",
      profile: "flag",
      git: fakeGit({ remoteUrl: async () => GRC }),
      env: { AWS_REGION: "x", AWS_PROFILE: "y" },
      config: {},
    });
    expect(ctx).toEqual({
      repository: "demo",
      region: "eu-west-1",
      profile: "flag",
      clone: { root: "/work" },
    });
  });

  it("puts the remote before the environment, and the environment before the config", async () => {
    const env = { AWS_REGION: "env-region", AWS_PROFILE: "env-profile" };
    const config = { region: "cfg-region", profile: "cfg-profile" };
    const https = await resolveContext({ git: fakeGit(), env, config });
    expect(https).toMatchObject({ region: "ap-northeast-1", profile: "env-profile" });
    const outside = await resolveContext({
      repo: "other",
      git: fakeGit({ topLevel: async () => null }),
      env,
      config,
    });
    expect(outside).toEqual({ repository: "other", region: "env-region", profile: "env-profile" });
    const cfg = await resolveContext({
      repo: "other",
      git: fakeGit({ topLevel: async () => null }),
      env: {},
      config,
    });
    expect(cfg).toEqual({ repository: "other", region: "cfg-region", profile: "cfg-profile" });
  });

  it("accepts AWS_DEFAULT_REGION and leaves region to the SDK when nothing is set", async () => {
    const git = fakeGit({ topLevel: async () => null });
    expect(
      await resolveContext({ repo: "r", git, env: { AWS_DEFAULT_REGION: "d" }, config: {} }),
    ).toEqual({
      repository: "r",
      region: "d",
    });
    expect(await resolveContext({ repo: "r", git, env: {}, config: {} })).toEqual({
      repository: "r",
    });
  });

  it("falls back past a grc remote that names no region", async () => {
    const ctx = await resolveContext({
      git: fakeGit({ remoteUrl: async () => "codecommit://demo" }),
      env: { AWS_REGION: "env-region" },
      config: {},
    });
    expect(ctx).toEqual({ repository: "demo", region: "env-region", clone: { root: "/work" } });
  });

  it("treats --repo naming another repository as outside the clone", async () => {
    const ctx = await resolveContext({ repo: "other", git: fakeGit(), env: {}, config: {} });
    expect(ctx).toEqual({ repository: "other" });
  });

  it("treats --region naming another region as outside the clone", async () => {
    // Same name, other region: a different repository, so origin is not its remote.
    const ctx = await resolveContext({ region: "us-east-1", git: fakeGit(), env: {}, config: {} });
    expect(ctx).toEqual({ repository: "demo", region: "us-east-1" });
  });

  it.each([
    ["outside a repository", { topLevel: async () => null }, "not inside a git repository"],
    ["without origin", { remoteUrl: async () => null }, "this clone has no origin remote"],
    [
      "with a non-CodeCommit origin",
      { remoteUrl: async () => "git@github.com:a/b.git" },
      "is not a CodeCommit remote",
    ],
  ])("asks for --repo %s", async (_, git, message) => {
    await expect(resolveContext({ git: fakeGit(git), env: {}, config: {} })).rejects.toThrow(
      message,
    );
  });
});

describe("resolveAccountContext", () => {
  it("leaves the repository out outside a clone", async () => {
    const ctx = await resolveAccountContext({
      git: fakeGit({ topLevel: async () => null }),
      env: { AWS_PROFILE: "dev" },
      config: { region: "ap-northeast-1" },
    });
    expect(ctx).toEqual({ region: "ap-northeast-1", profile: "dev" });
  });

  it("keeps the clone's repository", async () => {
    const ctx = await resolveAccountContext({
      git: fakeGit({ remoteUrl: async () => GRC }),
      env: {},
      config: {},
    });
    expect(ctx).toEqual({
      repository: "demo",
      region: "eu-west-1",
      profile: "remote-profile",
      clone: { root: "/work" },
    });
  });
});
