import { CodeCommitClient, ListPullRequestsCommand } from "@aws-sdk/client-codecommit";
import { mockClient } from "aws-sdk-client-mock";
import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeCommitApi } from "./codecommit.js";
import { mapLimit } from "./mapLimit.js";

const cc = mockClient(CodeCommitClient);
afterEach(() => cc.reset());

describe("listPullRequestIds", () => {
  it("returns the first `limit` ids, whatever page sizes the service picks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 450 }),
        fc.integer({ min: 1, max: 500 }),
        // The service may return fewer ids than asked for, even none, with a token.
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 20 }),
        async (total, limit, pageSizes) => {
          cc.reset();
          const all = Array.from({ length: total }, (_, i) => String(i + 1));
          const asked: number[] = [];
          let call = 0;
          cc.on(ListPullRequestsCommand).callsFake((input) => {
            asked.push(input.maxResults);
            const start = Number(input.nextToken ?? 0);
            const size = Math.min(input.maxResults, pageSizes[call++ % pageSizes.length] as number);
            const end = Math.min(start + size, total);
            return {
              pullRequestIds: all.slice(start, end),
              ...(end < total ? { nextToken: String(end) } : {}),
            };
          });
          const api = createCodeCommitApi({ region: "us-east-1" });
          // A service that keeps returning empty pages would never end; cap it.
          if (pageSizes.every((s) => s === 0) && total > 0) return;
          const ids = await api.listPullRequestIds("demo", "OPEN", limit);
          expect(ids).toEqual(all.slice(0, limit));
          for (const m of asked) expect(m >= 1 && m <= 100).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("mapLimit", () => {
  it("keeps order and never has more than `limit` calls in flight", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 })),
        fc.integer({ min: 1, max: 10 }),
        async (delays, limit) => {
          let inFlight = 0;
          let peak = 0;
          const out = await mapLimit(delays, limit, async (d) => {
            peak = Math.max(peak, ++inFlight);
            for (let i = 0; i < d; i++) await Promise.resolve();
            inFlight--;
            return d * 2;
          });
          expect(out).toEqual(delays.map((d) => d * 2));
          expect(peak).toBeLessThanOrEqual(limit);
        },
      ),
    );
  });
});
