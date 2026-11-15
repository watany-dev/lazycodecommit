import { describe, expect, it, vi } from "vitest";
import { fakeGit } from "../testing/fakes.js";

const render = vi.fn((_node: unknown) => ({ waitUntilExit: async () => {} }));
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  render: (node: unknown) => render(node),
}));

const { openBranches, openReview } = await import("./index.js");

describe("openReview", () => {
  it("renders the review app and waits for it to exit", async () => {
    await openReview({ repository: "demo", start: { pullRequestId: "4" }, region: "us-west-2" });
    await openReview({ repository: "demo", start: null, profile: "dev", git: fakeGit() });
    const props = render.mock.calls.map(([node]) => (node as { props: object }).props);
    expect(props[0]).toMatchObject({ repository: "demo", start: { pullRequestId: "4" } });
    expect(props[1]).toMatchObject({ start: null });
  });
});

describe("openBranches", () => {
  it("leaves for a create and comes back on the new PR or with the failure", async () => {
    render.mockClear();
    const heads = ["feature", "wip"];
    // Each render: press n on the next head, until none are left.
    render.mockImplementation((node: unknown) => {
      const head = heads.shift();
      if (head) (node as { props: { onCreate: (h: string) => void } }).props.onCreate(head);
      return { waitUntilExit: async () => {} };
    });
    const createPullRequest = vi.fn(async (head: string) =>
      head === "feature" ? { pullRequestId: "9" } : { message: "Aborted" },
    );
    await openBranches({
      actions: { repository: "demo" } as never,
      region: "us-west-2",
      createPullRequest,
    });
    expect(createPullRequest.mock.calls).toEqual([["feature"], ["wip"]]);
    const starts = render.mock.calls.map(
      ([node]) => (node as { props: { start: unknown } }).props.start,
    );
    expect(starts).toEqual([null, { reviewPullRequestId: "9" }, { message: "Aborted" }]);
  });
});
