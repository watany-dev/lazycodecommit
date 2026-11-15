import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** ~/.local/state/lazycc (XDG_STATE_HOME): seen.json, cache.json, identity.json, drafts.json. */
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

/** The ARN for a set of credentials, keyed by `cred:` and a hash of them. */
export interface IdentityStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, arn: string): Promise<void>;
}

/** When each PR was last opened, keyed by seenKey. */
interface SeenStore {
  all(): Promise<ReadonlyMap<string, Date>>;
  /** Keeps the later time; `replaces` is an older key for the same PR, removed. */
  mark(key: string, at: Date, replaces?: string): Promise<void>;
}

/** Last results per screen ("home", the branch table, ...), each its own section. */
interface CacheStore {
  get(section: string): Promise<unknown>;
  set(section: string, value: unknown): Promise<void>;
}

/**
 * Unposted review comments, keyed like seen. Entries are checked by the
 * reader (core/commentDrafts.ts); an empty list removes the key.
 */
interface DraftStore {
  get(key: string): Promise<unknown>;
  set(key: string, drafts: readonly unknown[]): Promise<void>;
}

export interface LocalState {
  readonly identity: IdentityStore;
  readonly drafts: DraftStore;
  readonly seen: SeenStore;
  readonly cache: CacheStore;
  /** Resolves when every save started so far has landed. */
  flush(): Promise<void>;
}

/** What names a PR across accounts: its id and its author, whose ARN holds the account. */
export interface SeenPr {
  readonly id: string;
  readonly authorArn?: string | undefined;
}

/** The account in an ARN (arn:partition:service:region:account:...). */
export function accountOf(arn: string | undefined): string {
  return arn?.split(":")[4] || "unknown";
}

/**
 * `${region}/${account}/${id}`: PR ids are unique per account and region only,
 * so a user of two accounts would otherwise see one PR's mark on another.
 */
export function seenKey(region: string, pr: SeenPr): string {
  return `${region}/${accountOf(pr.authorArn)}/${pr.id}`;
}

/** Older versions keyed by region and id alone. */
const legacySeenKey = (region: string, pr: SeenPr) => `${region}/${pr.id}`;

/**
 * When the PR was last opened. A mark from an older version is still read, so
 * an upgrade does not mark every PR unread; marking the PR replaces it.
 */
export function lastSeen(
  seen: ReadonlyMap<string, Date>,
  region: string,
  pr: SeenPr,
): Date | undefined {
  return seen.get(seenKey(region, pr)) ?? seen.get(legacySeenKey(region, pr));
}

export function markSeen(
  state: Pick<LocalState, "seen">,
  region: string,
  pr: SeenPr,
  at: Date,
): Promise<void> {
  return state.seen.mark(seenKey(region, pr), at, legacySeenKey(region, pr));
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
          // Older versions keyed by profile (stale once its role changed) or by
          // the access key ID itself, which this file should not hold.
          for (const k of Object.keys(o)) if (!k.startsWith("cred:")) delete o[k];
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
      mark: (key, at, replaces) =>
        update("seen.json", (o) => {
          if (replaces !== undefined) delete o[replaces];
          const prev = typeof o[key] === "string" ? Date.parse(o[key] as string) : Number.NaN;
          if (!(prev >= at.getTime())) o[key] = at.toISOString();
        }),
    },
    drafts: {
      async get(key) {
        // A save just made (posting one draft) must be in what is read next.
        await queue;
        return (await readObject(path("drafts.json")))[key];
      },
      set: (key, drafts) =>
        update("drafts.json", (o) => {
          if (drafts.length === 0) delete o[key];
          else o[key] = drafts;
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
