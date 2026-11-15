import { describe, expect, it } from "vitest";
import { fakeGit } from "../testing/fakes.js";
import { type RepoContext, resolveContext } from "./context.js";
import { UsageError } from "./errors.js";

// Exhaustive check of resolveContext against the spec's rules (リポジトリの推定,
// プロファイルとリージョンの優先順位), written out independently below. Every
// combination of the inputs is tried: a few thousand cases, well under a second.

interface Remote {
  readonly url: string;
  readonly repo?: string;
  readonly region?: string;
  readonly profile?: string;
}
const REMOTES: readonly (Remote | null)[] = [
  null,
  {
    url: "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/demo",
    repo: "demo",
    region: "us-east-1",
  },
  { url: "codecommit::eu-west-1://rp@demo", repo: "demo", region: "eu-west-1", profile: "rp" },
  { url: "codecommit://demo", repo: "demo" },
  { url: "https://github.com/o/demo.git" },
];

function* product<T extends Record<string, readonly unknown[]>>(
  axes: T,
): Generator<{ [K in keyof T]: T[K][number] }> {
  const keys = Object.keys(axes);
  const go = function* (
    i: number,
    acc: Record<string, unknown>,
  ): Generator<Record<string, unknown>> {
    if (i === keys.length) {
      yield { ...acc };
      return;
    }
    const key = keys[i] as string;
    for (const v of axes[key] as readonly unknown[]) yield* go(i + 1, { ...acc, [key]: v });
  };
  yield* go(0, {}) as Generator<{ [K in keyof T]: T[K][number] }>;
}

const AXES = {
  root: [null, "/w"],
  remote: REMOTES,
  repo: [undefined, "demo", "other"],
  region: [undefined, "", "us-east-1", "ap-south-1"],
  profile: [undefined, "", "fp"],
  AWS_REGION: [undefined, "er"],
  AWS_DEFAULT_REGION: [undefined, "edr"],
  AWS_PROFILE: [undefined, "ep"],
  configRegion: [undefined, "cr"],
  configProfile: [undefined, "cp"],
} as const;

type Case = ReturnType<typeof product<typeof AXES>> extends Generator<infer C> ? C : never;

/** The spec, as a table lookup. Returns null where it says to fail. */
function expected(c: Case): RepoContext | null {
  const remote = c.root !== null && c.remote?.repo ? c.remote : null;
  const repository = c.repo ?? remote?.repo;
  if (!repository) return null;
  // The clone is the repository only when no flag names another one: not a
  // different name, and not a different region (a region is a different repository).
  const inClone =
    remote !== null &&
    (c.repo === undefined || c.repo === remote.repo) &&
    (!c.region || !remote.region || c.region === remote.region);
  const fromRemote = inClone ? remote : null;
  const region =
    c.region || fromRemote?.region || c.AWS_REGION || c.AWS_DEFAULT_REGION || c.configRegion;
  const profile = c.profile || fromRemote?.profile || c.AWS_PROFILE || c.configProfile;
  return {
    repository,
    ...(region ? { region } : {}),
    ...(profile ? { profile } : {}),
    ...(inClone ? { clone: { root: c.root as string } } : {}),
    // Standing in a clone a flag ruled out: errors say why it was not used.
    ...(remote !== null && !inClone ? { otherClone: expect.stringContaining(remote.repo) } : {}),
  };
}

describe("resolveContext, exhaustively", () => {
  it("matches the spec for every combination of flags, clone, environment and config", async () => {
    let n = 0;
    for (const c of product(AXES)) {
      n++;
      const run = resolveContext({
        ...(c.repo !== undefined ? { repo: c.repo } : {}),
        ...(c.region !== undefined ? { region: c.region } : {}),
        ...(c.profile !== undefined ? { profile: c.profile } : {}),
        git: fakeGit({
          topLevel: async () => c.root,
          remoteUrl: async () => (c.remote ? c.remote.url : null),
        }),
        env: {
          AWS_REGION: c.AWS_REGION,
          AWS_DEFAULT_REGION: c.AWS_DEFAULT_REGION,
          AWS_PROFILE: c.AWS_PROFILE,
        },
        config: {
          ...(c.configRegion ? { region: c.configRegion } : {}),
          ...(c.configProfile ? { profile: c.configProfile } : {}),
        },
      });
      const want = expected(c);
      if (want === null) await expect(run, JSON.stringify(c)).rejects.toBeInstanceOf(UsageError);
      else expect(await run, JSON.stringify(c)).toEqual(want);
    }
    expect(n).toBe(2 * 5 * 3 * 4 * 3 * 2 * 2 * 2 * 2 * 2);
  });
});
