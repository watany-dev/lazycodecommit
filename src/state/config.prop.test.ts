import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lazycc-config-prop-"));
  await mkdir(join(dir, "lazycc"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const load = async (text: string) => {
  await writeFile(join(dir, "lazycc", "config.json"), text);
  return loadConfig({ XDG_CONFIG_HOME: dir });
};

// Shaped like the real file, with each key sometimes the wrong type.
const value = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string()),
  fc.object(),
);
const maybe = <T>(a: fc.Arbitrary<T>) => fc.option(fc.oneof(a, value), { nil: undefined });
const configLike = fc.record(
  {
    profile: maybe(fc.string()),
    region: maybe(fc.string()),
    repos: maybe(fc.array(fc.string())),
    concurrency: maybe(fc.integer()),
    pr: maybe(
      fc.record(
        {
          template: maybe(fc.string()),
          mergeOption: maybe(fc.constantFrom("ff", "squash", "three-way", "rebase")),
        },
        { requiredKeys: [] },
      ),
    ),
    branch: maybe(fc.record({ closedPrLookback: maybe(fc.integer()) }, { requiredKeys: [] })),
  },
  { requiredKeys: [] },
);

describe("loadConfig on arbitrary input", () => {
  it("either loads or fails with ConfigError, never anything else", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          configLike.map((c) => JSON.stringify(c)),
          fc.json(),
          fc.string(),
        ),
        async (text) => {
          try {
            await load(text);
          } catch (error) {
            expect(error).toBeInstanceOf(ConfigError);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("loads every well-typed config unchanged", async () => {
    const good = fc.record(
      {
        profile: fc.string({ minLength: 1 }),
        region: fc.string({ minLength: 1 }),
        repos: fc.array(fc.string({ minLength: 1 })),
        concurrency: fc.integer({ min: 1 }),
        pr: fc.record(
          {
            template: fc.string({ minLength: 1 }),
            mergeOption: fc.constantFrom("ff", "squash", "three-way"),
          },
          { requiredKeys: [] },
        ),
        branch: fc.record({ closedPrLookback: fc.integer({ min: 1 }) }, { requiredKeys: [] }),
      },
      { requiredKeys: [] },
    );
    await fc.assert(
      fc.asyncProperty(good, async (c) => {
        expect(await load(JSON.stringify(c))).toEqual(c);
      }),
      { numRuns: 200 },
    );
  });
});
