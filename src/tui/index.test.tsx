import { describe, expect, it, vi } from "vitest";
import { fakeGit } from "../testing/fakes.js";

const render = vi.fn((_node: unknown) => ({ waitUntilExit: async () => {}, clear: () => {} }));
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  render: (node: unknown) => render(node),
}));

const { openReview, openTop } = await import("./index.js");
const { BranchesApp } = await import("./BranchesApp.js");
const { BrowseApp } = await import("./BrowseApp.js");
const { HomeApp } = await import("./HomeApp.js");
const { PickScreen } = await import("./PickScreen.js");

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

interface Node {
  type: unknown;
  props: {
    onSwitch(s: object): void;
    onDone(repository?: string): void;
    onRepository(repository: string): void;
    onCreate(head: string | undefined): void;
    reviewService(repository: string): { markSeen?: unknown };
    start?: unknown;
  };
}

/** Plays one step per render: each step sees what was rendered and acts on its props. */
const clear = vi.fn();

function script(...steps: ((node: Node) => void)[]) {
  render.mockReset();
  clear.mockReset();
  // A step plays while the view is up, as a key press would.
  render.mockImplementation((node: unknown) => ({
    waitUntilExit: async () => steps.shift()?.(node as Node),
    clear,
  }));
  return () => render.mock.calls.map(([node]) => (node as Node).type);
}

function views(overrides: Record<string, unknown> = {}) {
  return {
    home: vi.fn(async () => ({ markSeen: vi.fn() }) as never),
    branches: vi.fn(() => ({
      actions: { repository: "demo" } as never,
      createPullRequest: vi.fn(async () => ({ pullRequestId: "9" })),
    })),
    browse: vi.fn(async () => ({}) as never),
    ...overrides,
  };
}

describe("openTop", () => {
  it("switches between the three views and quits from the last", async () => {
    const rendered = script(
      (n) => n.props.onSwitch({ view: "branches" }),
      (n) => n.props.onSwitch({ view: "browse" }),
      (n) => n.props.onSwitch({ view: "home" }),
    );
    const v = views();
    await openTop({ start: "home", repository: "demo", browsePath: "src/", views: v });
    expect(rendered()).toEqual([HomeApp, BranchesApp, BrowseApp, HomeApp]);
    // Each switch replaces the last frame; quitting leaves it.
    expect(clear).toHaveBeenCalledTimes(3);
    expect(v.branches).toHaveBeenCalledWith("demo");
    expect(v.browse).toHaveBeenCalledWith("demo");
    // --path only for the first browse.
    expect(render.mock.calls[2]![0]).toMatchObject({ props: { path: "src/" } });
  });

  it("opens the picker for a view with no repository, and goes back on q", async () => {
    const rendered = script(
      (n) => n.props.onSwitch({ view: "branches" }),
      (n) => n.props.onDone(), // q in the picker
      (n) => n.props.onSwitch({ view: "browse" }),
      (n) => n.props.onDone("picked"),
    );
    const v = views();
    await openTop({ start: "home", views: v });
    expect(rendered()).toEqual([HomeApp, PickScreen, HomeApp, PickScreen, BrowseApp]);
    expect(v.browse).toHaveBeenCalledWith("picked");
  });

  it("quits from a starting picker nothing was picked in", async () => {
    const rendered = script(() => {});
    await openTop({ start: "browse", views: views() });
    expect(rendered()).toEqual([PickScreen]);
  });

  it("changes the repository with r, and keeps it on q", async () => {
    const rendered = script(
      (n) => n.props.onSwitch({ pick: true }),
      (n) => n.props.onDone("other"),
      (n) => n.props.onSwitch({ pick: true }),
      () => {},
    );
    const v = views();
    await openTop({ start: "branches", repository: "demo", views: v });
    expect(rendered()).toEqual([BranchesApp, PickScreen, BranchesApp, PickScreen, BranchesApp]);
    expect(v.branches.mock.calls).toEqual([["demo"], ["other"], ["other"]]);
  });

  it("takes the repository picked on the home screen", async () => {
    script(
      (n) => {
        n.props.onRepository("mine");
        n.props.onSwitch({ view: "branches" });
      },
      () => {},
    );
    const v = views();
    await openTop({ start: "home", views: v });
    expect(v.branches).toHaveBeenCalledWith("mine");
  });

  it("leaves for a create and comes back on the new PR or with the failure", async () => {
    const heads = ["feature", "wip"];
    script(
      (n) => n.props.onCreate(heads.shift()),
      (n) => n.props.onCreate(heads.shift()),
    );
    const createPullRequest = vi.fn(async (head: string) =>
      head === "feature" ? { pullRequestId: "9" } : { message: "Aborted" },
    );
    await openTop({
      start: "branches",
      repository: "demo",
      region: "us-west-2",
      views: views({
        branches: () => ({ actions: { repository: "demo" }, createPullRequest }),
      }),
    });
    expect(createPullRequest.mock.calls).toEqual([["feature"], ["wip"]]);
    const starts = render.mock.calls.map(([node]) => (node as Node).props.start);
    expect(starts).toEqual([null, { reviewPullRequestId: "9" }, { message: "Aborted" }]);
  });

  it("falls back with a note when browse cannot open, and throws when it was the start", async () => {
    const browse = vi.fn(async () => {
      throw new Error("empty repository");
    });
    script(
      (n) => n.props.onSwitch({ view: "browse" }),
      () => {},
    );
    await openTop({ start: "branches", repository: "demo", views: views({ browse }) });
    expect(render.mock.calls[1]![0]).toMatchObject({
      type: BranchesApp,
      props: { start: { message: "empty repository" } },
    });

    script(
      (n) => n.props.onSwitch({ view: "browse" }),
      () => {},
    );
    await openTop({ start: "home", repository: "demo", views: views({ browse }) });
    expect(render.mock.calls[1]![0]).toMatchObject({
      type: HomeApp,
      props: { note: "empty repository" },
    });

    script();
    await expect(
      openTop({ start: "browse", repository: "demo", views: views({ browse }) }),
    ).rejects.toThrow("empty repository");
  });

  it("uses git diffs only for the clone's own repository", async () => {
    script();
    await openTop({
      start: "home",
      views: views(),
      region: "us-west-2",
      git: fakeGit(),
      cloneRepository: "demo",
      markSeen: vi.fn(),
    });
    const { reviewService } = (render.mock.calls[0]![0] as Node).props;
    expect(reviewService("demo")).not.toBe(reviewService("other"));
    expect(reviewService("other")).toBe(reviewService("another"));
    expect(reviewService("demo").markSeen).toBeTypeOf("function");

    script();
    await openTop({ start: "home", views: views() });
    const outside = (render.mock.calls[0]![0] as Node).props.reviewService;
    expect(outside("demo")).toBe(outside("other"));
  });
});
