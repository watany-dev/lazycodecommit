import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PullRequest } from "../aws/codecommit.js";
import { inboxJson, inboxLines } from "../cli/format.js";
import { fromCache, type Inbox, type InboxItem, toCache, withUnread } from "./inbox.js";

const REGION = "us-west-2";
const ME = "arn:aws:iam::123456789012:user/me";
const date = fc.date({
  min: new Date("2000-01-01T00:00:00Z"),
  max: new Date("2100-01-01T00:00:00Z"),
  noInvalidDate: true,
});

const pr: fc.Arbitrary<PullRequest> = fc.record({
  id: fc.integer({ min: 1, max: 99999 }).map(String),
  title: fc.string(),
  description: fc.string(),
  status: fc.constantFrom("OPEN" as const, "CLOSED" as const),
  authorArn: fc.constantFrom(ME, "arn:aws:iam::123456789012:user/alice"),
  repository: fc.constantFrom("demo", "api"),
  sourceBranch: fc.string({ minLength: 1 }),
  destinationBranch: fc.string({ minLength: 1 }),
  sourceCommit: fc.stringMatching(/^[0-9a-f]{40}$/),
  destinationCommit: fc.stringMatching(/^[0-9a-f]{40}$/),
  isMerged: fc.boolean(),
  revisionId: fc.string(),
  creationDate: date,
  lastActivityDate: date,
  approvalRules: fc.array(fc.record({ name: fc.string(), content: fc.string() }), {
    maxLength: 2,
  }),
});

const item: fc.Arbitrary<InboxItem> = fc.record(
  {
    section: fc.constantFrom("awaiting" as const, "mine" as const),
    pr,
    unread: fc.boolean(),
    approvedBy: fc.array(fc.string(), { maxLength: 2 }),
    rules: fc.record({
      approved: fc.boolean(),
      overridden: fc.boolean(),
      satisfied: fc.array(fc.string(), { maxLength: 2 }),
      notSatisfied: fc.array(fc.string(), { maxLength: 2 }),
    }),
    mergeable: fc.boolean(),
    checks: fc.constantFrom(
      "pass" as const,
      "fail" as const,
      "pending" as const,
      "cancel" as const,
      "none" as const,
      "error" as const,
    ),
  },
  { requiredKeys: ["section", "pr", "unread"] },
);

const inbox: fc.Arbitrary<Inbox> = fc.record({
  me: fc.constant(ME),
  repositories: fc.constant(["demo", "api"]),
  items: fc.array(item, { maxLength: 5 }),
  errors: fc.constant([]),
  fetchedAt: date,
});

/** cache.json as the next run reads it: through JSON on disk. */
const onDisk = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** Every path to a value inside a JSON value, with a setter. */
function paths(value: unknown, at: (string | number)[] = []): (string | number)[][] {
  if (typeof value !== "object" || value === null) return [at];
  const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
  return [at, ...keys.flatMap((k) => paths((value as Record<string, unknown>)[k], [...at, k]))];
}

function setAt(root: unknown, path: (string | number)[], v: unknown): unknown {
  if (path.length === 0) return v;
  const [k, ...rest] = path as [string | number, ...(string | number)[]];
  const copy = (Array.isArray(root) ? [...root] : { ...(root as object) }) as Record<
    string | number,
    unknown
  >;
  copy[k] = setAt(copy[k], rest, v);
  return copy;
}

describe("the home screen's cache", () => {
  it("is dropped when a date in it is not a string, an object with keys included", () => {
    const saved = toCache(
      { me: ME, repositories: ["demo"], items: [], errors: [], fetchedAt: new Date() },
      REGION,
    ) as Record<string, unknown>;
    const broken = onDisk({ ...saved, fetchedAt: { toString: null } });
    expect(fromCache(broken, ME, REGION, ["demo"])).toBeUndefined();
  });

  it("reads back what was saved, through JSON on disk", () => {
    fc.assert(
      fc.property(inbox, (saved) => {
        const read = fromCache(onDisk(toCache(saved, REGION)), ME, REGION, saved.repositories);
        expect(read).toEqual(saved);
      }),
      { numRuns: 300 },
    );
  });

  it("is dropped or read whole when a value in it is replaced (an older lazycc, a bad write)", () => {
    fc.assert(
      fc.property(
        inbox.filter((i) => i.items.length > 0),
        fc.nat(),
        fc.jsonValue(),
        (saved, pick, replacement) => {
          const cached = onDisk(toCache(saved, REGION));
          const all = paths(cached);
          const broken = setAt(cached, all[pick % all.length] ?? [], replacement);
          const read = fromCache(broken, ME, REGION, saved.repositories);
          if (!read) return;
          // What was read must draw and print, and save again, as a fresh inbox would.
          const shown = withUnread(read, REGION, new Map());
          inboxLines(shown.items);
          JSON.stringify(inboxJson(shown, shown.items, REGION));
          toCache(shown, REGION);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
