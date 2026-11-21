import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeActions } from "../core/home.js";
import type { Inbox, InboxItem } from "../core/inbox.js";
import type { ReviewService } from "../core/review.js";
import { pullRequest } from "../testing/fakes.js";
import { press, render, settle } from "../testing/keys.js";

const exit = vi.fn();
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  useApp: () => ({ exit }),
}));

const { HomeApp } = await import("./HomeApp.js");

const ME = "arn:aws:iam::123456789012:user/me";
const BOB = "arn:aws:sts::123456789012:assumed-role/Dev/bob";

const awaiting = (id: string, title: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  section: "awaiting",
  pr: pullRequest({ id, title, repository: "demo", authorArn: BOB }),
  unread: true,
  ...extra,
});
const mine = (id: string, title: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  section: "mine",
  pr: pullRequest({ id, title, repository: "infra", authorArn: ME }),
  unread: false,
  ...extra,
});

const inbox = (items: InboxItem[], extra: Partial<Inbox> = {}): Inbox => ({
  me: ME,
  repositories: ["demo", "infra"],
  items,
  errors: [],
  fetchedAt: new Date(),
  ...extra,
});

const FRESH = [awaiting("11", "Add retry"), awaiting("12", "Fix cache"), mine("21", "My feature")];

function actions(over: Partial<HomeActions> = {}): HomeActions {
  return {
    region: "us-east-1",
    me: ME,
    concurrency: 2,
    initial: ["demo", "infra"],
    watched: () => ["demo", "infra"],
    cached: vi.fn(async () => undefined),
    fetch: vi.fn(async () => inbox(FRESH)),
    details: vi.fn(async (item: InboxItem) =>
      item.section === "mine"
        ? {
            ...item,
            rules: { approved: false, overridden: false, satisfied: ["a"], notSatisfied: ["b"] },
            mergeable: false,
          }
        : { ...item, approvedBy: item.pr.id === "12" ? [ME] : [] },
    ),
    save: vi.fn(async () => {}),
    unreadMarker: vi.fn(async () => (i: Inbox) => ({
      ...i,
      items: i.items.map((x) => ({ ...x, unread: false })),
    })),
    markSeen: vi.fn(),
    listRepositories: vi.fn(async () => ["demo", "infra", "sandbox"]),
    toggleWatch: vi.fn(async () => ["demo", "infra", "sandbox"]),
    consoleUrl: (pr) => `https://console/${pr.repository}/${pr.id}`,
    ...over,
  };
}

const service = {
  getPullRequestDetail: vi.fn(async () => ({
    pullRequest: { pullRequestId: "11", title: "Add retry", pullRequestTargets: [] },
    differences: [],
    commentThreads: [],
  })),
  getReactionsForComments: vi.fn(async () => new Map()),
  listPullRequests: vi.fn(async () => ({ pullRequests: [] })),
} as unknown as ReviewService;

async function setup(a = actions()) {
  const reviewService = vi.fn(() => service);
  const r = render(<HomeApp actions={a} reviewService={reviewService} />);
  await vi.waitFor(() => expect(r.lastFrame()).toContain("Add retry"));
  return { ...r, a, reviewService };
}

beforeEach(() => exit.mockReset());

describe("HomeApp", () => {
  it("leaves for the branch table or browse on 2 and 3, and shows a note", async () => {
    for (const [k, want] of [
      ["2", { view: "branches" }],
      ["3", { view: "browse" }],
    ] as const) {
      exit.mockReset();
      const onSwitch = vi.fn();
      const r = render(
        <HomeApp
          actions={actions()}
          reviewService={() => service}
          note="empty repository"
          onSwitch={onSwitch}
        />,
      );
      await vi.waitFor(() => expect(r.lastFrame()).toContain("Add retry"));
      expect(r.lastFrame()).toContain("empty repository");
      await press(r.stdin, "1", k);
      expect(onSwitch.mock.calls).toEqual([[want]]);
      expect(exit).toHaveBeenCalledOnce();
      r.unmount();
    }
  });

  it("lists PRs awaiting approval, drops the ones I approved, and saves the result", async () => {
    const { lastFrame, a } = await setup();
    await vi.waitFor(() => expect(lastFrame()).not.toContain("Fix cache"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Awaiting your approval (1)");
    expect(frame).toContain("Your PRs (1)");
    expect(frame).toMatch(/> ● demo/);
    expect(frame).toContain("bob");
    expect(frame).toContain("2 repositories");
    await vi.waitFor(() => expect(a.save).toHaveBeenCalled());
    expect(a.fetch).toHaveBeenCalledWith(["demo", "infra"]);
  });

  it("marks my PRs with their CI state when there is one", async () => {
    const a = actions({
      details: vi.fn(async (item: InboxItem) =>
        item.section === "mine"
          ? {
              ...item,
              rules: { approved: true, overridden: false, satisfied: ["a"], notSatisfied: [] },
              mergeable: true,
              checks: "fail" as const,
            }
          : { ...item, approvedBy: [] },
      ),
    });
    const { lastFrame, stdin } = await setup(a);
    await press(stdin, "\t");
    await vi.waitFor(() => expect(lastFrame()).toContain("CI ✗"));
  });

  it("shows my PRs on Tab with rules and conflicts", async () => {
    const { lastFrame, stdin } = await setup();
    await press(stdin, "\t");
    await vi.waitFor(() => expect(lastFrame()).toContain("✗ 1/2 rules"));
    expect(lastFrame()).toContain("My feature");
    expect(lastFrame()).toContain("conflict");
    await press(stdin, "\t");
    expect(lastFrame()).toContain("Add retry");
  });

  it("shows the cache first, then the fresh result", async () => {
    let finish: (v: Inbox) => void = () => {};
    const a = actions({
      cached: vi.fn(async () => inbox([awaiting("9", "Cached one")])),
      fetch: vi.fn(() => new Promise<Inbox>((r) => (finish = r))),
    });
    const r = render(<HomeApp actions={a} reviewService={() => service} />);
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Cached one"));
    expect(r.lastFrame()).toContain("refreshing…");
    finish(inbox(FRESH));
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Add retry"));
    expect(r.lastFrame()).not.toContain("Cached one");
  });

  it("opens the review on Enter for the PR's repository and comes back with fresh marks", async () => {
    const { lastFrame, stdin, a, reviewService } = await setup();
    await vi.waitFor(() => expect(a.save).toHaveBeenCalled());
    await press(stdin, "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("PR #11"));
    expect(reviewService).toHaveBeenCalledWith("demo");
    await press(stdin, "\u001B");
    await vi.waitFor(() => expect(lastFrame()).toContain("Awaiting your approval"));
    expect(a.unreadMarker).toHaveBeenCalled();
    expect(a.fetch).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
  });

  it("shows the console URL, filters, moves, and quits", async () => {
    const { lastFrame, stdin } = await setup();
    await vi.waitFor(() => expect(lastFrame()).not.toContain("Fix cache"));
    await press(stdin, "u");
    expect(lastFrame()).toContain("https://console/demo/11");
    // Each key waits for the screen it leads to: on a slow runner a fixed tick
    // lets the next key reach the filter input before the last one has landed.
    const step = async (key: string, shows: string | RegExp) => {
      await press(stdin, key);
      await vi.waitFor(() => expect(lastFrame()).toMatch(shows));
    };
    await step("/", /^ \//m);
    await step("z", "/z");
    await step("z", "/zz");
    await step("\r", "filter: zz");
    expect(lastFrame()).toContain("No pull request matches.");
    await step("/", "/zz");
    await step("\u001b", "Add retry");
    await press(stdin, "j", "k");
    await step("?", "Home help");
    await step("\u001b", "Awaiting your approval");
    await press(stdin, "q");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  });

  it("refreshes on R, and opens the picker on Ctrl+r", async () => {
    const { stdin, a, lastFrame } = await setup();
    await vi.waitFor(() => expect(a.save).toHaveBeenCalled());
    await press(stdin, "R");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenCalledTimes(2));
    await press(stdin, "\u0012");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
  });

  it("switches sections with ] and [, and goes to the first and last PR with < and >", async () => {
    const three = inbox([awaiting("11", "Add retry"), awaiting("13", "Third"), mine("21", "Mine")]);
    const { stdin, lastFrame, a } = await setup(actions({ fetch: vi.fn(async () => three) }));
    await vi.waitFor(() => expect(lastFrame()).toContain("Third"));
    await vi.waitFor(() => expect(a.save).toHaveBeenCalled());
    await press(stdin, ">");
    expect(lastFrame()).toMatch(/> .*#13/);
    await press(stdin, "<");
    expect(lastFrame()).toMatch(/> .*#11/);
    await press(stdin, "]");
    expect(lastFrame()).toMatch(/Your PRs \(1\)/);
    await press(stdin, "[");
    await press(stdin, "\u001B");
    expect(exit).not.toHaveBeenCalled();
  });

  it("runs a key picked in the help menu", async () => {
    const { stdin, lastFrame, a } = await setup();
    await vi.waitFor(() => expect(a.save).toHaveBeenCalled());
    await press(stdin, "?", "/", "U", "R", "L", "\r", "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("https://console/demo/11"));
  });

  it("says when a section is empty", async () => {
    const { lastFrame, stdin } = await setup(
      actions({ fetch: vi.fn(async () => inbox([awaiting("11", "Add retry")])) }),
    );
    await press(stdin, "\t");
    expect(lastFrame()).toContain("You have no open pull requests.");
    const r = render(
      <HomeApp
        actions={actions({ fetch: vi.fn(async () => inbox([mine("21", "Mine")])) })}
        reviewService={() => service}
      />,
    );
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Nothing awaits your approval."));
  });

  it("shows repositories that failed, a failed load, and failed details", async () => {
    const withErrors = await setup(
      actions({
        fetch: vi.fn(async () =>
          inbox(FRESH, { errors: [{ repository: "legacy", error: new Error("gone") }] }),
        ),
        details: vi.fn(async (item: InboxItem) => ({ ...item, detailError: "denied" })),
      }),
    );
    await vi.waitFor(() => expect(withErrors.lastFrame()).toContain("legacy:"));
    await press(withErrors.stdin, "\t");
    await vi.waitFor(() => expect(withErrors.lastFrame()).toContain("details failed"));

    const failed = render(
      <HomeApp
        actions={actions({
          fetch: vi.fn(async () => {
            throw new Error("expired");
          }),
        })}
        reviewService={() => service}
      />,
    );
    await vi.waitFor(() => expect(failed.lastFrame()).toContain("Error:"));

    const staleFailed = render(
      <HomeApp
        actions={actions({
          cached: vi.fn(async () => inbox([awaiting("9", "Cached one")])),
          fetch: vi.fn(async () => {
            throw new Error("expired");
          }),
        })}
        reviewService={() => service}
      />,
    );
    await vi.waitFor(() => expect(staleFailed.lastFrame()).toContain("Refresh failed:"));
    expect(staleFailed.lastFrame()).toContain("Cached one");
  });

  it("shows … while my PR's details load", async () => {
    const r = render(
      <HomeApp
        actions={actions({ details: vi.fn(() => new Promise<InboxItem>(() => {})) })}
        reviewService={() => service}
      />,
    );
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Add retry"));
    r.stdin.write("\t");
    await vi.waitFor(() => expect(r.lastFrame()).toContain("…"));
  });

  it("opens the picker when nothing is watched and quits from it when still nothing is", async () => {
    const a = actions({ initial: undefined, watched: () => [] });
    const r = render(<HomeApp actions={a} reviewService={() => service} />);
    await vi.waitFor(() => expect(r.lastFrame()).toContain("sandbox"));
    expect(a.fetch).not.toHaveBeenCalled();
    await press(r.stdin, "q");
    expect(exit).toHaveBeenCalled();
  });

  it("follows the watch list when coming back from the picker", async () => {
    let watched = ["demo", "infra"];
    const a = actions({ watched: () => watched });
    const { lastFrame, stdin } = await setup(a);
    await press(stdin, "r");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    watched = ["demo", "infra", "sandbox"];
    await press(stdin, "\u001B");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenLastCalledWith(watched));
    expect(lastFrame()).toContain("3 repositories");
  });

  it("starts from the picker and follows the watch list once there is one", async () => {
    let watched: string[] = [];
    const a = actions({ initial: undefined, watched: () => watched });
    const r = render(<HomeApp actions={a} reviewService={() => service} />);
    await vi.waitFor(() => expect(r.lastFrame()).toContain("sandbox"));
    watched = ["demo"];
    await press(r.stdin, "\u001B");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenCalledWith(["demo"]));
  });

  it("shows one repository picked with Enter, and keeps it after the picker", async () => {
    const a = actions();
    const { lastFrame, stdin } = await setup(a);
    await press(stdin, "r");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    await press(stdin, "j", "j", "\r");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenLastCalledWith(["sandbox"]));
    expect(lastFrame()).toContain("sandbox");
    await press(stdin, "r");
    await vi.waitFor(() => expect(lastFrame()).toContain("repositories"));
    await press(stdin, "\u001B");
    expect(a.fetch).toHaveBeenCalledTimes(2);
  });

  it("goes back from a picked repository to the watched ones on Esc", async () => {
    const a = actions();
    const onRepository = vi.fn();
    const { lastFrame, stdin } = render(
      <HomeApp actions={a} reviewService={() => service} onRepository={onRepository} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("Add retry"));
    await press(stdin, "\u001B");
    expect(a.fetch).toHaveBeenCalledTimes(1);
    await press(stdin, "r");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    await press(stdin, "j", "j", "\r");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenLastCalledWith(["sandbox"]));
    expect(lastFrame()).toContain("sandbox only");
    expect(lastFrame()).toContain("Esc back to 2 repositories");
    expect(onRepository).toHaveBeenLastCalledWith("sandbox");
    await press(stdin, "\u001B");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenLastCalledWith(["demo", "infra"]));
    expect(lastFrame()).not.toContain("only");
    expect(onRepository).toHaveBeenLastCalledWith(undefined);
    await press(stdin, "\u001B");
    expect(a.fetch).toHaveBeenCalledTimes(3);
  });

  it("goes back to the watch list as it is now, after w changed it", async () => {
    let watched = ["demo", "infra"];
    const a = actions({ watched: () => watched });
    const { lastFrame, stdin } = await setup(a);
    await press(stdin, "r");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    await press(stdin, "j", "j", "\r");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenLastCalledWith(["sandbox"]));
    watched = ["infra"];
    await press(stdin, "\u001B");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenLastCalledWith(["infra"]));
  });

  it("goes back to the repository it started on when nothing is watched", async () => {
    const a = actions({ initial: ["clone"], watched: () => [] });
    const r = render(<HomeApp actions={a} reviewService={() => service} />);
    await vi.waitFor(() => expect(a.fetch).toHaveBeenCalledWith(["clone"]));
    await press(r.stdin, "r");
    await vi.waitFor(() => expect(r.lastFrame()).toContain("sandbox"));
    await press(r.stdin, "j", "j", "\r");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenLastCalledWith(["sandbox"]));
    expect(r.lastFrame()).toContain("Esc back to clone");
    await press(r.stdin, "\u001B");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenLastCalledWith(["clone"]));
  });

  it("has nothing to go back to after picking the repository it started on", async () => {
    const a = actions({ initial: ["demo"], watched: () => [] });
    const r = render(<HomeApp actions={a} reviewService={() => service} />);
    await vi.waitFor(() => expect(a.fetch).toHaveBeenCalledWith(["demo"]));
    await press(r.stdin, "r");
    await vi.waitFor(() => expect(r.lastFrame()).toContain("sandbox"));
    await press(r.stdin, "\r");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenCalledTimes(2));
    expect(r.lastFrame()).not.toContain("Esc back");
  });

  it("has nothing to go back to when it started on the picker and nothing is watched", async () => {
    const a = actions({ initial: undefined, watched: () => [] });
    const r = render(<HomeApp actions={a} reviewService={() => service} />);
    await vi.waitFor(() => expect(r.lastFrame()).toContain("sandbox"));
    await press(r.stdin, "j", "j", "\r");
    await vi.waitFor(() => expect(a.fetch).toHaveBeenLastCalledWith(["sandbox"]));
    expect(r.lastFrame()).not.toContain("Esc back");
    await press(r.stdin, "\u001B");
    expect(a.fetch).toHaveBeenCalledTimes(1);
  });

  it("opens a repository's PR list from the picker and returns to the picker", async () => {
    const { lastFrame, stdin, reviewService } = await setup();
    await press(stdin, "r");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    await press(stdin, "p");
    await vi.waitFor(() => expect(reviewService).toHaveBeenCalledWith("demo"));
    await vi.waitFor(() => expect(lastFrame()).toContain("lazycc — demo"));
    await press(stdin, "\u001B");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
  });

  it("drops a refresh for repositories the user has left", async () => {
    let finishOld: (v: Inbox) => void = () => {};
    const a = actions({
      fetch: vi.fn((repos: readonly string[]) =>
        repos.includes("sandbox")
          ? Promise.resolve(inbox([awaiting("31", "Sandbox PR")]))
          : new Promise<Inbox>((r) => (finishOld = r)),
      ),
    });
    const r = render(<HomeApp actions={a} reviewService={() => service} />);
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Loading..."));
    await press(r.stdin, "r");
    await vi.waitFor(() => expect(r.lastFrame()).toContain("sandbox"));
    await press(r.stdin, "j", "j", "\r");
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Sandbox PR"));
    finishOld(inbox(FRESH));
    await settle();
    expect(r.lastFrame()).toContain("Sandbox PR");
    expect(r.lastFrame()).not.toContain("Add retry");
  });

  it("stays on the picker when everything is unwatched, and quits on a second q", async () => {
    let watched = ["demo", "infra"];
    const a = actions({ watched: () => watched });
    const { lastFrame, stdin } = await setup(a);
    await press(stdin, "r");
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    watched = [];
    await press(stdin, "\u001B");
    expect(lastFrame()).toContain("repositories");
    expect(exit).not.toHaveBeenCalled();
    await press(stdin, "\u001B");
    expect(exit).toHaveBeenCalled();
  });

  it("starts without the cache when it cannot be read", async () => {
    const { lastFrame } = await setup(
      actions({
        cached: vi.fn(async () => {
          throw new Error("EACCES");
        }),
      }),
    );
    expect(lastFrame()).toContain("Add retry");
  });

  it("marks the PR read when coming back from its review", async () => {
    const { lastFrame, stdin, a } = await setup();
    await press(stdin, "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("PR #11"));
    await press(stdin, "\u001B");
    await vi.waitFor(() => expect(a.markSeen).toHaveBeenCalledWith({ id: "11", authorArn: BOB }));
  });
});

describe("HomeApp with hostile text", () => {
  it("shows PR titles with control characters made visible", async () => {
    const hostile = [
      awaiting("11", "Add retry\x1b]52;c;aGk=\x07\x1b[2J"),
      mine("21", "Mine\u009b2J"),
    ];
    const { lastFrame, stdin } = await setup(actions({ fetch: vi.fn(async () => inbox(hostile)) }));
    expect(lastFrame()).toContain("Add retry^[]52;c;aGk=^G^[[2J");
    expect(lastFrame()).not.toContain("\x1b]52");
    await press(stdin, "\t");
    await vi.waitFor(() => expect(lastFrame()).toContain("Mine^[[2J"));
    expect(lastFrame()).not.toContain("\u009b");
  });
});

describe("HomeApp, from mutation testing", () => {
  const four = () =>
    inbox([
      awaiting("11", "Add retry"),
      awaiting("13", "Third"),
      awaiting("14", "Fourth"),
      mine("21", "Mine"),
      mine("22", "Also mine"),
    ]);
  const cursorOn = (frame: string | undefined) =>
    frame
      ?.split("\n")
      .filter((l) => /^ ?> /.test(l))
      .map((l) => /#(\d+)/.exec(l)?.[1]);

  async function ready() {
    const r = await setup(actions({ fetch: vi.fn(async () => four()) }));
    await vi.waitFor(() => expect(r.a.save).toHaveBeenCalled());
    return r;
  }

  it("moves one row at a time with j k and the arrows, and stays inside the list", async () => {
    const { stdin, lastFrame } = await ready();
    expect(cursorOn(lastFrame())).toEqual(["11"]);
    await press(stdin, "k");
    expect(cursorOn(lastFrame())).toEqual(["11"]);
    await press(stdin, "j");
    expect(cursorOn(lastFrame())).toEqual(["13"]);
    await press(stdin, "\u001B[B");
    expect(cursorOn(lastFrame())).toEqual(["14"]);
    await press(stdin, "j");
    expect(cursorOn(lastFrame())).toEqual(["14"]);
    await press(stdin, "k");
    expect(cursorOn(lastFrame())).toEqual(["13"]);
    await press(stdin, "\u001B[A");
    expect(cursorOn(lastFrame())).toEqual(["11"]);
  });

  it("switches sections with Tab, ] and [, each from the first row", async () => {
    const { stdin, lastFrame } = await ready();
    for (const key of ["\t", "]", "["]) {
      await press(stdin, "j", key);
      const frame = lastFrame() ?? "";
      expect(cursorOn(frame)?.length).toBe(1);
      expect(["11", "21"]).toContain(cursorOn(frame)?.[0]);
    }
    expect(lastFrame()).toContain("Also mine");
    await press(stdin, "]");
    expect(cursorOn(lastFrame())).toEqual(["11"]);
    expect(lastFrame()).toContain("Fourth");
  });

  it("filters by title or repository, whatever the case", async () => {
    const { stdin, lastFrame } = await ready();
    await press(stdin, "j", "/", "T", "H", "I", "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("filter: THI"));
    expect(lastFrame()).toContain("Third");
    expect(lastFrame()).not.toContain("Add retry");
    expect(cursorOn(lastFrame())).toEqual(["13"]);
    await press(stdin, "/", "\u001B", "]", "/", "I", "N", "F", "R", "A", "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("filter: INFRA"));
    expect(lastFrame()).toContain("Also mine");
  });

  it("shows the URL only on u, and goes to the last row on >", async () => {
    const { stdin, lastFrame } = await ready();
    await press(stdin, "x");
    expect(lastFrame()).not.toContain("https://console");
    await press(stdin, ">");
    expect(cursorOn(lastFrame())).toEqual(["14"]);
    await press(stdin, "u");
    expect(lastFrame()).toContain("https://console/demo/14");
    // Any key clears the note.
    await press(stdin, "x");
    expect(lastFrame()).not.toContain("https://console");
  });

  it("marks unread PRs and the selected one only", async () => {
    const { lastFrame } = await ready();
    const lines = (lastFrame() ?? "").split("\n").filter((l) => /#\d+/.test(l));
    expect(lines.filter((l) => l.includes("●"))).toHaveLength(3);
    expect(lines.filter((l) => /^ ?> /.test(l))).toHaveLength(1);
  });

  it("names one repository, counts several, and says when it refreshes", async () => {
    let finish: (v: Inbox) => void = () => {};
    const a = actions({
      initial: ["demo"],
      watched: () => ["demo"],
      cached: vi.fn(async () => inbox([awaiting("9", "Cached one")])),
      fetch: vi.fn(() => new Promise<Inbox>((r) => (finish = r))),
    });
    const r = render(<HomeApp actions={a} reviewService={() => service} />);
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Cached one"));
    expect(r.lastFrame()).toMatch(/\) {3}demo {2}refreshing…/);
    finish(inbox(FRESH));
    await vi.waitFor(() => expect(r.lastFrame()).not.toContain("refreshing…"));
    const many = await setup();
    expect(many.lastFrame()).toMatch(/\) {3}2 repositories/);
  });

  it("offers 2 and 3 in the footer only when it can switch views", async () => {
    const { lastFrame } = await setup();
    expect(lastFrame()).toContain("r repositories / filter");
    const r = render(
      <HomeApp actions={actions()} reviewService={() => service} onSwitch={vi.fn()} />,
    );
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Add retry"));
    expect(r.lastFrame()).toContain("r repositories 2 branches 3 browse / filter");
  });

  it("does not show a refresh failure without a list", async () => {
    const r = render(
      <HomeApp
        actions={actions({
          fetch: vi.fn(async () => {
            throw new Error("expired");
          }),
        })}
        reviewService={() => service}
      />,
    );
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Error: expired"));
    expect(r.lastFrame()).not.toContain("Refresh failed");
  });

  it("clears an earlier failure when a refresh succeeds", async () => {
    let fail = true;
    const a = actions({
      cached: vi.fn(async () => inbox([awaiting("9", "Cached one")])),
      fetch: vi.fn(async () => {
        if (fail) throw new Error("expired");
        return inbox(FRESH);
      }),
    });
    const r = render(<HomeApp actions={a} reviewService={() => service} />);
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Refresh failed"));
    fail = false;
    await press(r.stdin, "R");
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Add retry"));
    expect(r.lastFrame()).not.toContain("Refresh failed");
  });
});
