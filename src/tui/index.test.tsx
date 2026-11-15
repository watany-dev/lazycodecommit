import { describe, expect, it, vi } from "vitest";
import { fakeGit } from "../testing/fakes.js";

const render = vi.fn((_node: unknown) => ({ waitUntilExit: async () => {} }));
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  render: (node: unknown) => render(node),
}));

const { openBranches, openHome, openReview } = await import("./index.js");

describe("openReview", () => {
  it("renders the review app and waits for it to exit", async () => {
    await openReview({ repository: "demo", start: { pullRequestId: "4" }, region: "us-west-2" });
    await openReview({ repository: "demo", start: null, profile: "dev", git: fakeGit() });
    const props = render.mock.calls.map(([node]) => (node as { props: object }).props);
    expect(props[0]).toMatchObject({ repository: "demo", start: { pullRequestId: "4" } });
    expect(props[1]).toMatchObject({ start: null });
  });

  it("gives the service the read marker", async () => {
    render.mockClear();
    const markSeen = vi.fn();
    await openReview({ repository: "demo", start: null, markSeen });
    const props = (render.mock.calls[0]![0] as { props: { service: { markSeen?: unknown } } })
      .props;
    expect(props.service.markSeen).toBe(markSeen);
  });
});

describe("the preselected merge strategy", () => {
  it("is on the service", async () => {
    render.mockClear();
    await openReview({ repository: "demo", start: null, mergeStrategy: "squash" });
    const props = (render.mock.calls[0]![0] as { props: { service: { mergeStrategy?: unknown } } })
      .props;
    expect(props.service.mergeStrategy).toBe("squash");
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

describe("openHome", () => {
  it("uses git diffs only for the clone's own repository", async () => {
    render.mockReset();
    render.mockImplementation(() => ({ waitUntilExit: async () => {} }));
    const markSeen = vi.fn();
    await openHome({
      actions: { markSeen } as never,
      region: "us-west-2",
      git: fakeGit(),
      cloneRepository: "demo",
    });
    const { reviewService } = (
      render.mock.calls[0]![0] as {
        props: { reviewService: (r: string) => { markSeen?: unknown } };
      }
    ).props;
    expect(reviewService("demo")).not.toBe(reviewService("other"));
    expect(reviewService("other")).toBe(reviewService("another"));
    expect(reviewService("demo").markSeen).toBe(markSeen);

    await openHome({ actions: { markSeen } as never });
    const outside = (
      render.mock.calls[1]![0] as { props: { reviewService: (r: string) => unknown } }
    ).props.reviewService;
    expect(outside("demo")).toBe(outside("other"));
  });
});
