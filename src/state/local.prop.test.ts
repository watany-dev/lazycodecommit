import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createLocalState } from "./local.js";

type Op =
  | { readonly kind: "mark"; readonly key: string; readonly at: number; readonly replaces?: string }
  | { readonly kind: "identity"; readonly key: string }
  | { readonly kind: "cache"; readonly section: string; readonly value: number }
  | { readonly kind: "draft"; readonly key: string; readonly item: string };

const key = fc.constantFrom("r/1/1", "r/1/2", "r/2/1");
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record(
    {
      kind: fc.constant("mark" as const),
      key,
      at: fc.integer({ min: 0, max: 5 }).map((d) => Date.UTC(2026, 0, 1 + d)),
      replaces: fc.constantFrom("r/1", "r/2"),
    },
    { requiredKeys: ["kind", "key", "at"] },
  ),
  fc.record({
    kind: fc.constant("identity" as const),
    key: fc.integer({ min: 0, max: 20 }).map((n) => `cred:${n}`),
  }),
  fc.record({
    kind: fc.constant("cache" as const),
    section: fc.constantFrom("home", "branches"),
    value: fc.nat(),
  }),
  fc.record({ kind: fc.constant("draft" as const), key, item: fc.uuid() }),
);

describe("two lazycc processes saving state at once, for any mix of saves", () => {
  it("keep the latest mark per PR, every draft, a written cache value and at most 16 identities", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(op, { maxLength: 12 }),
        fc.array(op, { maxLength: 12 }),
        async (opsA, opsB) => {
          const home = await mkdtemp(join(tmpdir(), "lazycc-prop-"));
          try {
            const [a, b] = [createLocalState({ HOME: home }), createLocalState({ HOME: home })];
            const run = (s: typeof a, ops: Op[]) =>
              Promise.all(
                ops.map((o) => {
                  if (o.kind === "mark") return s.seen.mark(o.key, new Date(o.at), o.replaces);
                  if (o.kind === "identity")
                    return s.identity.set(o.key, `arn:aws:iam::1:user/${o.key}`);
                  if (o.kind === "cache") return s.cache.set(o.section, o.value);
                  return s.drafts.update(o.key, (l) => [...(Array.isArray(l) ? l : []), o.item]);
                }),
              );
            await Promise.all([run(a, opsA), run(b, opsB)]);
            await Promise.all([a.flush(), b.flush()]);
            const all = [...opsA, ...opsB];

            const seen = await a.seen.all();
            for (const k of new Set(all.flatMap((o) => (o.kind === "mark" ? [o.key] : [])))) {
              const latest = Math.max(
                ...all.flatMap((o) => (o.kind === "mark" && o.key === k ? [o.at] : [])),
              );
              expect(seen.get(k)?.getTime()).toBe(latest);
            }
            for (const k of seen.keys()) {
              expect(all.some((o) => o.kind === "mark" && o.key === k)).toBe(true);
            }

            for (const k of new Set(all.flatMap((o) => (o.kind === "draft" ? [o.key] : [])))) {
              const items = all.flatMap((o) => (o.kind === "draft" && o.key === k ? [o.item] : []));
              const { value } = await b.drafts.get(k);
              expect([...(value as string[])].toSorted()).toEqual(items.toSorted());
            }

            for (const section of ["home", "branches"]) {
              const written = all.flatMap((o) =>
                o.kind === "cache" && o.section === section ? [o.value] : [],
              );
              const value = await a.cache.get(section);
              if (written.length === 0) expect(value).toBeUndefined();
              else expect(written).toContain(value);
            }

            const ids = new Set(all.flatMap((o) => (o.kind === "identity" ? [o.key] : [])));
            const kept = await Promise.all([...ids].map((k) => a.identity.get(k)));
            expect(kept.filter(Boolean).length).toBe(Math.min(ids.size, 16));
            // Only state files are left: no lock, no temporary file.
            const files = await readdir(join(home, ".local", "state", "lazycc")).catch(() => []);
            for (const f of files) expect(f).toMatch(/^(seen|cache|identity|drafts)\.json$/);
          } finally {
            await rm(home, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});
