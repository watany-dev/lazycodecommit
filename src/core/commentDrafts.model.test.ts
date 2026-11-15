import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CommentDraft,
  type Commits,
  canEdit,
  editDraft,
  newDraft,
  reanchor,
  submitDrafts,
} from "./commentDrafts.js";

/**
 * A model of CodeCommit's clientRequestToken: the same token with the same
 * parameters returns the first comment; with other parameters it is refused.
 * Each call can be refused, lost before it lands, or lost after it lands.
 */
/** An answer from CodeCommit with this HTTP status. */
const status = (code: number) =>
  Object.assign(new Error(`HTTP ${code}`), { $metadata: { httpStatusCode: code } });

type Fault = "ok" | "refuse" | "lostBefore" | "lostAfter" | "crashAfter";

class FakeCodeCommit {
  readonly byToken = new Map<string, string>();
  /** Comments created, by the draft they came from. */
  readonly created = new Map<string, number>();
  faults: Fault[] = [];

  async post(draft: CommentDraft, commits: Commits, token: string): Promise<void> {
    const fault = this.faults.shift() ?? "ok";
    if (fault === "refuse") throw status(400);
    if (fault === "lostBefore")
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const params = JSON.stringify([draft.content, draft.target, commits]);
    const seen = this.byToken.get(token);
    if (seen !== undefined) {
      if (seen !== params) throw status(400); // IdempotencyParameterMismatchException
    } else {
      this.byToken.set(token, params);
      this.created.set(draft.id, (this.created.get(draft.id) ?? 0) + 1);
    }
    if (fault === "lostAfter")
      throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    if (fault === "crashAfter") throw new Crash();
  }
}

/** The process dies after CodeCommit created the comment, before drafts.json is saved. */
class Crash extends Error {}

const tipOf = (n: number): Commits => ({ beforeCommitId: `d${n}`, afterCommitId: `s${n}` });

type Step =
  | { readonly kind: "submit"; readonly faults: Fault[] }
  | { readonly kind: "push" }
  | { readonly kind: "edit"; readonly index: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("submit" as const),
    faults: fc.array(
      fc.constantFrom<Fault>("ok", "refuse", "lostBefore", "lostAfter", "crashAfter"),
      {
        maxLength: 4,
      },
    ),
  }),
  fc.constant({ kind: "push" as const }),
  fc.record({ kind: fc.constant("edit" as const), index: fc.nat(3) }),
);

describe("submitting drafts, against a model of CodeCommit's request tokens", () => {
  it("never posts a draft twice, through refusals, lost answers, crashes, edits and new commits", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(step, { maxLength: 12 }),
        async (n, steps) => {
          const cc = new FakeCodeCommit();
          let tip = 0;
          // drafts.json: what survives a crash.
          let disk: CommentDraft[] = Array.from({ length: n }, (_, i) =>
            newDraft(`comment ${i}`, { kind: "general" }, tipOf(tip)),
          );
          const submit = async (faults: Fault[]) => {
            cc.faults = [...faults];
            // What the review screen does: move drafts to the tip, then post.
            const anchored = reanchor(disk, tipOf(tip), () => undefined);
            disk = anchored;
            try {
              await submitDrafts(anchored, {
                post: (d, c, t) => cc.post(d, c, t),
                save: async (list) => {
                  disk = [...list];
                },
              });
            } catch (e) {
              if (!(e instanceof Crash)) throw e;
            }
          };
          for (const s of steps) {
            if (s.kind === "submit") await submit(s.faults);
            else if (s.kind === "push") tip++;
            else {
              const d = disk[s.index];
              if (d && canEdit(d))
                disk = disk.map((x) => (x === d ? editDraft(d, `${d.content}!`) : x));
            }
          }
          // Then the network behaves: everything left goes out.
          await submit([]);
          expect(disk).toEqual([]);
          for (const count of cc.created.values()) expect(count).toBe(1);
          expect(cc.created.size).toBe(n);
        },
      ),
      { numRuns: 3000 },
    );
  });
});
