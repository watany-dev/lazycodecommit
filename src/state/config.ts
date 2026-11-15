import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  const repos = raw["repos"];
  if (
    repos !== undefined &&
    !(Array.isArray(repos) && repos.every((r) => typeof r === "string" && r !== ""))
  ) {
    fail("repos", "an array of non-empty strings");
  }
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
  // Unknown keys are left alone so a newer config still loads in an older lazycc.
  return raw as Config;
}
