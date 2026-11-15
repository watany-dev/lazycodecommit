import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** ~/.local/state/lazycc (XDG_STATE_HOME): seen.json, cache.json, identity.json. */
export function stateDir(env: Env): string {
  const base = env["XDG_STATE_HOME"] || join(env["HOME"] || homedir(), ".local", "state");
  return join(base, "lazycc");
}

type Obj = Record<string, unknown>;

/**
 * State files are ours, not the user's: a missing, unreadable or corrupt one
 * reads as empty and is rewritten on the next save (spec: ローカル状態).
 */
async function readObject(path: string): Promise<Obj> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Obj) : {};
  } catch {
    return {};
  }
}

/** Write then rename, so a crash mid-write never leaves a half file behind. */
async function writeObject(path: string, value: Obj): Promise<void> {
  // User-only: the cache holds PR titles from private repositories.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** The ARN for a set of credentials. Keyed by profile, as the spec says. */
export interface IdentityStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, arn: string): Promise<void>;
}

/** When each PR was last opened, keyed by `${region}/${id}` (PR ids are unique per region). */
interface SeenStore {
  all(): Promise<ReadonlyMap<string, Date>>;
  mark(key: string, at: Date): Promise<void>;
}

/** Last results per screen ("home", the branch table, ...), each its own section. */
interface CacheStore {
  get(section: string): Promise<unknown>;
  set(section: string, value: unknown): Promise<void>;
}

export interface LocalState {
  readonly identity: IdentityStore;
  readonly seen: SeenStore;
  readonly cache: CacheStore;
  /** Resolves when every save started so far has landed. */
  flush(): Promise<void>;
}

export function seenKey(region: string, id: string): string {
  return `${region}/${id}`;
}

export function createLocalState(env: Env): LocalState {
  const dir = stateDir(env);
  const path = (name: string) => join(dir, name);
  // Each save re-reads the file, so another lazycc (or another screen's
  // section) written in between is kept; the last writer wins per key.
  // Saves from this process run one at a time so none reads a stale file.
  let queue: Promise<unknown> = Promise.resolve();
  const update = (name: string, change: (o: Obj) => void): Promise<void> => {
    const run = queue.then(async () => {
      const o = await readObject(path(name));
      change(o);
      await writeObject(path(name), o);
    });
    queue = run.catch(() => {});
    return run;
  };
  return {
    flush: () => queue.then(() => {}),
    identity: {
      async get(key) {
        const v = (await readObject(path("identity.json")))[key];
        return typeof v === "string" && v.startsWith("arn:") ? v : undefined;
      },
      set: (key, arn) =>
        update("identity.json", (o) => {
          o[key] = arn;
        }),
    },
    seen: {
      async all() {
        // A mark just made (leaving a review) must be in what the home reads next.
        await queue;
        const map = new Map<string, Date>();
        for (const [k, v] of Object.entries(await readObject(path("seen.json")))) {
          const d = typeof v === "string" ? new Date(v) : null;
          if (d && !Number.isNaN(d.getTime())) map.set(k, d);
        }
        return map;
      },
      mark: (key, at) =>
        update("seen.json", (o) => {
          const prev = typeof o[key] === "string" ? Date.parse(o[key] as string) : Number.NaN;
          if (!(prev >= at.getTime())) o[key] = at.toISOString();
        }),
    },
    cache: {
      get: async (section) => (await readObject(path("cache.json")))[section],
      set: (section, value) =>
        update("cache.json", (o) => {
          o[section] = value;
        }),
    },
  };
}
