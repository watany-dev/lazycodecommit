import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withLock } from "./lock.js";

export interface Config {
  readonly profile?: string;
  readonly region?: string;
  readonly repos?: readonly string[];
  readonly pr?: {
    readonly template?: string;
    readonly mergeOption?: "ff" | "squash" | "three-way";
  };
  readonly branch?: { readonly closedPrLookback?: number };
  readonly concurrency?: number;
  /** Per repository, the CodeBuild projects and pipelines whose runs are a PR's CI results (ADR 0010). */
  readonly ci?: Readonly<
    Record<
      string,
      { readonly codebuild?: readonly string[]; readonly codepipeline?: readonly string[] }
    >
  >;
}

/** The config file is user-written, so a bad one stops the command (ADR 0003). */
export class ConfigError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "ConfigError";
  }
}

export function configPath(env: Readonly<Record<string, string | undefined>>): string {
  const base = env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config");
  return join(base, "lazycc", "config.json");
}

export async function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): Promise<Config> {
  const path = configPath(env);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(path, (error as Error).message);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ConfigError(path, `invalid JSON: ${(error as Error).message}`);
  }
  return validate(path, raw);
}

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validate(path: string, raw: unknown): Config {
  const fail = (key: string, want: string): never => {
    throw new ConfigError(path, `"${key}" must be ${want}`);
  };
  const str = (o: Obj, key: string, name: string) => {
    const v = o[key];
    if (v !== undefined && (typeof v !== "string" || v === "")) fail(name, "a non-empty string");
  };
  const posInt = (o: Obj, key: string, name: string) => {
    const v = o[key];
    if (v !== undefined && !(Number.isInteger(v) && (v as number) > 0))
      fail(name, "a positive integer");
  };
  const section = (key: string): Obj | undefined => {
    const v = (raw as Obj)[key];
    if (v === undefined) return undefined;
    if (!isObject(v)) return fail(key, "an object");
    return v;
  };

  if (!isObject(raw)) return fail("(top level)", "an object");
  str(raw, "profile", "profile");
  str(raw, "region", "region");
  const names = (o: Obj, key: string, name: string) => {
    const v = o[key];
    if (v !== undefined && !(Array.isArray(v) && v.every((r) => typeof r === "string" && r !== "")))
      fail(name, "an array of non-empty strings");
  };
  names(raw, "repos", "repos");
  posInt(raw, "concurrency", "concurrency");
  const pr = section("pr");
  if (pr) {
    str(pr, "template", "pr.template");
    const merge = pr["mergeOption"];
    if (merge !== undefined && merge !== "ff" && merge !== "squash" && merge !== "three-way") {
      fail("pr.mergeOption", 'one of "ff", "squash", "three-way"');
    }
  }
  const branch = section("branch");
  if (branch) posInt(branch, "closedPrLookback", "branch.closedPrLookback");
  const ci = section("ci");
  for (const [repo, entry] of Object.entries(ci ?? {})) {
    if (!isObject(entry)) fail(`ci.${repo}`, "an object");
    names(entry as Obj, "codebuild", `ci.${repo}.codebuild`);
    names(entry as Obj, "codepipeline", `ci.${repo}.codepipeline`);
  }
  // Unknown keys are left alone so a newer config still loads in an older lazycc.
  return raw as Config;
}

/**
 * Sets `repos` in the config file (the repository picker's w), keeping every
 * other key. JSON has no comments to lose; the file is rewritten with two-space
 * indents. A file that does not load is left alone and the error is thrown.
 * `update` gets the file's current repos, under the lock, and returns the new
 * list; the list saved is returned.
 */
export async function saveRepos(
  env: Readonly<Record<string, string | undefined>>,
  update: (current: readonly string[]) => readonly string[],
): Promise<readonly string[]> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true });
  // Read under the lock, so a save from another lazycc in between is not undone.
  let repos: readonly string[] = [];
  await withLock(path, async () => {
    const config = await loadConfig(env);
    repos = update(config.repos ?? []);
    const current = { ...config } as Record<string, unknown>;
    if (repos.length > 0) current["repos"] = repos;
    else delete current["repos"];
    // In place, not write-and-rename: that would replace a symlinked config
    // (dotfiles) with a plain file and drop its mode.
    await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
  });
  return repos;
}
