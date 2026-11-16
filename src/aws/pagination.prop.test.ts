import {
  CodeCommitClient,
  GetDifferencesCommand,
  GetMergeConflictsCommand,
  ListBranchesCommand,
  ListRepositoriesCommand,
} from "@aws-sdk/client-codecommit";
import { mockClient } from "aws-sdk-client-mock";
import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeCommitApi } from "./codecommit.js";
import { createReviewApi } from "./review.js";

const cc = mockClient(CodeCommitClient);
afterEach(() => cc.reset());

/** Splits `all` into the pages the service picked: sizes cycle, an empty page carries a token too. */
function pager<T>(all: readonly T[], sizes: readonly number[]) {
  let call = 0;
  return (token: string | undefined) => {
    const start = Number(token ?? 0);
    const end = Math.min(start + (sizes[call++ % sizes.length] as number), all.length);
    return { items: all.slice(start, end), next: end < all.length ? String(end) : undefined };
  };
}

const pages = fc
  .array(fc.integer({ min: 0, max: 7 }), { minLength: 1, maxLength: 6 })
  .filter((s) => s.some((n) => n > 0));
const names = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 30 });

describe("calls that page, whatever page sizes the service picks", () => {
  it("list every repository and branch once, in the service's order", async () => {
    await fc.assert(
      fc.asyncProperty(names, names, pages, async (repos, branches, sizes) => {
        cc.reset();
        const repoPage = pager(repos, sizes);
        const branchPage = pager(branches, sizes);
        cc.on(ListRepositoriesCommand).callsFake((input) => {
          const { items, next } = repoPage(input.nextToken);
          return {
            repositories: items.map((repositoryName) => ({ repositoryName })),
            ...(next ? { nextToken: next } : {}),
          };
        });
        cc.on(ListBranchesCommand).callsFake((input) => {
          const { items, next } = branchPage(input.nextToken);
          return { branches: items, ...(next ? { nextToken: next } : {}) };
        });
        const api = createCodeCommitApi({ region: "us-east-1", concurrency: 4 });
        expect(await api.listRepositories()).toEqual(repos);
        expect(await api.listBranches("demo")).toEqual(branches);
      }),
      { numRuns: 200 },
    );
  });

  it("read every difference and every conflicting file once", async () => {
    await fc.assert(
      fc.asyncProperty(names, names, pages, fc.boolean(), async (paths, conflicts, sizes, ok) => {
        cc.reset();
        const diffPage = pager(paths, sizes);
        const conflictPage = pager(conflicts, sizes);
        cc.on(GetDifferencesCommand).callsFake((input) => {
          const { items, next } = diffPage(input.NextToken);
          return {
            differences: items.map((path) => ({
              changeType: "A",
              afterBlob: { path, blobId: path },
            })),
            ...(next ? { NextToken: next } : {}),
          };
        });
        cc.on(GetMergeConflictsCommand).callsFake((input) => {
          const { items, next } = conflictPage(input.nextToken);
          return {
            mergeable: ok,
            conflictMetadataList: items.map((filePath) => ({ filePath })),
            ...(next ? { nextToken: next } : {}),
          };
        });
        const api = createReviewApi(new CodeCommitClient({ region: "us-east-1" }));
        const diffs = await api.getAllDifferences("demo", "a", "b");
        expect(diffs.map((d) => d.afterBlob?.path)).toEqual(paths);
        const summary = await api.getMergeConflicts({
          repositoryName: "demo",
          sourceCommitId: "b",
          destinationCommitId: "a",
          strategy: "three-way",
        });
        expect(summary.conflictFiles).toEqual(conflicts);
        expect(summary.conflictCount).toBe(conflicts.length);
      }),
      { numRuns: 200 },
    );
  });
});
