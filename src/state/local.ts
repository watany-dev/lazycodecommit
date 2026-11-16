import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { xdg } from "./config.js";
import { withLock } from "./lock.js";

type Env = Readonly<Record<string, string | undefined>>;

/** ~/.local/state/lazycc (XDG_STATE_HOME): seen.json, cache.json, identity.json, drafts.json. */
export function stateDir(env: Env): string {
  const base = xdg(env["XDG_STATE_HOME"]) ?? join(env["HOME"] || homedir(), ".local", "state");
  return join(base, "lazycc");
}

type Obj = Record<string, unknown>;

const asObj = (raw: unknown): Obj | undefined =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Obj) : undefined;

/**
 * Seen marks, the cache and identities are ours, not the user's: a missing,
 * unreadable or corrupt file reads as empty and is rewritten on the next save
 * (spec: ローカル状態).
 */
async function readObject(path: string): Promise<Obj> {
  try {
    return asObj(JSON.parse(await readFile(path, "utf8"))) ?? {};
  } catch {
    return {};
  }
}

/**
 * drafts.json holds comments not yet sent, so it is stricter: a missing file
 * is empty, a corrupt one is undefined (for the caller to move aside), and
 * one that cannot be read (EACCES, EIO) throws, as nothing is known of it.
 */
async function readDraftsFile(path: string): Promise<Obj | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return asObj(JSON.parse(text));
  } catch {
    return undefined;
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

const IDENTITY_KEEP = 16;

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
 * What a read of drafts.json found. `setAside` is where a file that was not
 * a JSON object was moved (its name plus `.bad-<time>`) before being read as
 * empty: the user may want back what it held.
 */
export interface DraftsRead<T> {
  readonly value: T;
  readonly setAside?: string;
}

/**
 * Unposted review comments, keyed like seen. Entries are checked by the
 * reader (core/commentDrafts.ts); an empty list removes the key. A file that
 * cannot be read rejects both calls and is left as it is.
 */
interface DraftStore {
  get(key: string): Promise<DraftsRead<unknown>>;
  /**
   * Replaces the key's list with what `change` makes of the list on disk,
   * read and written under the lock, and returns what was written.
   */
  update(
    key: string,
    change: (current: unknown) => readonly unknown[],
  ): Promise<DraftsRead<unknown[]>>;
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
  // Each save re-reads the file under a lock, so what another lazycc (or
  // another screen's section) wrote is kept; the last writer wins per key.
  // Saves from this process run one at a time so none reads a stale file.
  let queue: Promise<unknown> = Promise.resolve();
  const locked = <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const run = queue.then(() => withLock(path(name), work));
    queue = run.catch(() => {});
    return run;
  };
  const update = (name: string, change: (o: Obj) => void): Promise<void> =>
    locked(name, async () => {
      const o = await readObject(path(name));
      change(o);
      await writeObject(path(name), o);
    });
  const drafts = path("drafts.json");
  /** Under the lock: drafts.json, a corrupt one moved aside and read as empty. */
  const openDrafts = async (): Promise<DraftsRead<Obj>> => {
    const value = await readDraftsFile(drafts);
    if (value) return { value };
    const setAside = `${drafts}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(drafts, setAside);
    return { value: {}, setAside };
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
          // Last in the file is the newest. Temporary credentials get a new key at
          // every refresh, so only the most recent are kept.
          delete o[key];
          o[key] = arn;
          for (const k of Object.keys(o).slice(0, -IDENTITY_KEEP)) delete o[k];
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
        const o = await readDraftsFile(drafts);
        if (o) return { value: o[key] };
        const { value, setAside } = await locked("drafts.json", openDrafts);
        return { value: value[key], ...(setAside ? { setAside } : {}) };
      },
      update: (key, change) =>
        locked("drafts.json", async () => {
          const { value: o, setAside } = await openDrafts();
          const next = [...change(o[key])];
          if (next.length === 0) delete o[key];
          else o[key] = next;
          await writeObject(drafts, o);
          return { value: next, ...(setAside ? { setAside } : {}) };
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
