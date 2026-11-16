import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** A save takes milliseconds; a lock this old was left by a process that died. */
const STALE_LOCK_MS = 5_000;

/**
 * Runs `work` holding `${path}.lock`, so another lazycc cannot read the file
 * between this one's read and its rename and then overwrite what it wrote.
 * The lock is a file created exclusively; no dependency is needed.
 */
export async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      // A lock from the future (the clock was set back) would otherwise never age.
      if (Math.abs(age) > STALE_LOCK_MS) await rm(lock, { force: true });
      else await sleep(5 + Math.random() * 10);
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}
