import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchActions, BranchRow, BranchTable } from "../core/branch.js";
import type { ReviewService } from "../core/review.js";

const exit = vi.fn();
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  useApp: () => ({ exit }),
}));

const { BranchesApp } = await import("./BranchesApp.js");

const ROWS: BranchRow[] = [
  { name: "main", isDefault: true, tip: "m", state: "none" },
  {
    name: "feature/login",
    isDefault: false,
    tip: "f",
    state: "open",
    pr: { id: "42", title: "Fix login" },
    rules: { approved: false, overridden: false, satisfied: [], notSatisfied: ["one"] },
    ahead: 2,
    behind: 1,
    lastCommit: { date: new Date(), author: "alice" },
  },
  { name: "done", isDefault: false, tip: "d", state: "merged", pr: { id: "7", title: "Old" } },
  { name: "wip", isDefault: false, tip: "w", state: "none" },
];

function actions(over: Partial<BranchActions> = {}): BranchActions {
  const table: BranchTable = { repository: "demo", defaultBranch: "main", rows: ROWS };
  return {
    repository: "demo",
    load: vi.fn(async () => table),
    deleteBranch: vi.fn(async () => {}),
    switchBranch: vi.fn(async () => {}),
    consoleUrl: (b) => `https://console/${b}`,
    ...over,
  };
}

const service = {
  getPullRequestDetail: vi.fn(async () => ({
    pullRequest: { pullRequestId: "42", title: "Fix login", pullRequestTargets: [] },
    differences: [],
    commentThreads: [],
  })),
  getReactionsForComments: vi.fn(async () => new Map()),
} as unknown as ReviewService;

const tick = () => new Promise((r) => setTimeout(r, 30));

async function setup(a = actions(), start: Parameters<typeof BranchesApp>[0]["start"] = null) {
  const onCreate = vi.fn();
  const r = render(<BranchesApp actions={a} service={service} start={start} onCreate={onCreate} />);
  await vi.waitFor(() => expect(r.lastFrame()).toContain("wip"));
  return { ...r, onCreate, a };
}

async function press(stdin: { write: (s: string) => void }, ...keys: string[]) {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

beforeEach(() => {
  exit.mockReset();
});

describe("BranchesApp", () => {
  it("leaves for another view or the picker on 1, 3 and r", async () => {
    for (const [k, want] of [
      ["1", { view: "home" }],
      ["3", { view: "browse" }],
      ["r", { pick: true }],
    ] as const) {
      exit.mockReset();
      const onSwitch = vi.fn();
      const r = render(
        <BranchesApp
          actions={actions()}
          service={service}
          start={null}
          onCreate={vi.fn()}
          onSwitch={onSwitch}
        />,
      );
      await vi.waitFor(() => expect(r.lastFrame()).toContain("r repositories"));
      await press(r.stdin, "2", k);
      expect(onSwitch.mock.calls).toEqual([[want]]);
      expect(exit).toHaveBeenCalledOnce();
      r.unmount();
    }
  });

  it("lists branches with state, counts, PR and rules", async () => {
    const { lastFrame } = await setup();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("branches of demo");
    expect(frame).toMatch(/> \* main/);
    expect(frame).toContain("↑2 ↓1");
    expect(frame).toContain("#42 Fix login");
    expect(frame).toContain("✗ 0/1");
    expect(frame).toContain("merged");
  });

  it("opens the review for a branch with an open PR, and comes back on q", async () => {
    const { lastFrame, stdin, a } = await setup();
    await press(stdin, "j", "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("PR #42"));
    await press(stdin, "q");
    await vi.waitFor(() => expect(lastFrame()).toContain("branches of demo"));
    expect(a.load).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
  });

  it("starts on a review when asked", async () => {
    const r = render(
      <BranchesApp
        actions={actions()}
        service={service}
        start={{ reviewPullRequestId: "42" }}
        onCreate={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(r.lastFrame()).toContain("PR #42"));
  });

  it("shows a note it starts with", async () => {
    const { lastFrame } = await setup(actions(), { message: "Aborted: the title is empty." });
    expect(lastFrame()).toContain("Aborted: the title is empty.");
  });

  it("explains Enter and n on rows where they do not apply", async () => {
    const { lastFrame, stdin, onCreate } = await setup();
    await press(stdin, "\r");
    expect(lastFrame()).toContain("main has no open pull request. Press n to create one.");
    await press(stdin, "n");
    expect(lastFrame()).toContain("main is the default branch.");
    await press(stdin, "j", "n");
    expect(lastFrame()).toContain("feature/login already has #42. Press Enter.");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("leaves the TUI to create a PR with n", async () => {
    const { stdin, onCreate } = await setup();
    await press(stdin, "j", "j", "j", "n");
    expect(onCreate).toHaveBeenCalledWith("wip");
    expect(exit).toHaveBeenCalled();
  });

  it("deletes after confirming, and refuses protected branches", async () => {
    const { lastFrame, stdin, a } = await setup();
    await press(stdin, "d");
    expect(lastFrame()).toContain("main is the default branch.");
    await press(stdin, "j", "d");
    expect(lastFrame()).toContain("feature/login has an open pull request.");
    await press(stdin, "j", "d");
    expect(lastFrame()).toContain("Delete origin/done on CodeCommit? (y/n)");
    await press(stdin, "n");
    expect(a.deleteBranch).not.toHaveBeenCalled();
    await press(stdin, "d", "y");
    await vi.waitFor(() => expect(lastFrame()).toContain("Deleted origin/done."));
    expect(a.deleteBranch).toHaveBeenCalledWith(ROWS[2]);
  });

  it("shows why an action failed", async () => {
    const userError = Object.assign(new Error("fatal: local changes"), { name: "GitError" });
    const awsError = Object.assign(new Error("no"), { name: "AccessDeniedException" });
    const a = actions({
      switchBranch: vi.fn(async () => Promise.reject(userError)),
      deleteBranch: vi.fn(async () => Promise.reject(awsError)),
    });
    const { lastFrame, stdin } = await setup(a);
    await press(stdin, " ");
    await vi.waitFor(() => expect(lastFrame()).toContain("fatal: local changes"));
    await press(stdin, "j", "j", "d", "y");
    await vi.waitFor(() => expect(lastFrame()).toContain("Access denied"));
  });

  it("switches with Space, only inside a clone", async () => {
    const { lastFrame, stdin, a } = await setup();
    await press(stdin, "j", "j", "j", " ");
    await vi.waitFor(() => expect(lastFrame()).toContain("Switched to wip."));
    expect(a.switchBranch).toHaveBeenCalledWith(ROWS[3]);

    const { switchBranch: _, ...outside } = actions();
    const o = await setup(outside);
    expect(o.lastFrame()).not.toContain("Space switch");
    await press(o.stdin, " ");
    expect(o.lastFrame()).toContain("Switching needs a clone of the repository.");
  });

  it("filters by name and clears the filter with Esc", async () => {
    const { lastFrame, stdin } = await setup();
    await press(stdin, "/", "w", "i", "\r");
    expect(lastFrame()).toContain("filter: wi");
    expect(lastFrame()).not.toContain("feature/login");
    await press(stdin, "/", "z", "z", "\r");
    expect(lastFrame()).toContain("No branch matches.");
    await press(stdin, "/", "\u001B");
    await vi.waitFor(() => expect(lastFrame()).toContain("feature/login"));
  });

  it("refreshes with a fetch on Ctrl+r, shows the URL on u, and moves with k", async () => {
    const { lastFrame, stdin, a } = await setup();
    await press(stdin, "j", "k", "u");
    expect(lastFrame()).toContain("https://console/main");
    await press(stdin, "\u0012");
    await vi.waitFor(() => expect(a.load).toHaveBeenLastCalledWith({ fetch: true }));
  });

  it("ignores row actions while the table reloads", async () => {
    let calls = 0;
    const table: BranchTable = { repository: "demo", defaultBranch: "main", rows: ROWS };
    const a = actions({
      load: vi.fn(async () => (calls++ === 0 ? table : new Promise<BranchTable>(() => {}))),
    });
    const { lastFrame, stdin } = await setup(a);
    await press(stdin, "\u0012", "j", "j", "d");
    expect(lastFrame()).not.toContain("Delete origin/done");
    await press(stdin, "\u0012");
    expect(a.load).toHaveBeenCalledTimes(2);
    await press(stdin, "q");
    expect(exit).toHaveBeenCalled();
  });

  it("shows help, and quits on q", async () => {
    const { lastFrame, stdin } = await setup();
    await press(stdin, "?");
    expect(lastFrame()).toContain("Branches help");
    await press(stdin, "x");
    expect(lastFrame()).toContain("branches of demo");
    await press(stdin, "q");
    expect(exit).toHaveBeenCalled();
  });

  it("shows load errors and an empty repository", async () => {
    const failing = actions({ load: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const r = render(
      <BranchesApp actions={failing} service={service} start={null} onCreate={vi.fn()} />,
    );
    await vi.waitFor(() => expect(r.lastFrame()).toContain("Error: boom"));

    const empty = actions({ load: vi.fn(async () => ({ repository: "demo", rows: [] })) });
    const e = render(
      <BranchesApp actions={empty} service={service} start={null} onCreate={vi.fn()} />,
    );
    await vi.waitFor(() => expect(e.lastFrame()).toContain("No branches."));
    await press(e.stdin, "\r", "j");
    expect(e.lastFrame()).toContain("No branches.");
  });
});

describe("BranchesApp with hostile text", () => {
  // Commit author names and PR titles hold any byte; branch names can hold C1 controls.
  // oxlint-disable-next-line no-control-regex -- finding them is the point
  const RAW = /\x1b\]52|\x1b\[2J|\u009b/;

  it("shows names, authors, titles and messages with control characters made visible", async () => {
    const row: BranchRow = {
      name: "x\u009b2J",
      isDefault: false,
      tip: "h",
      state: "open",
      pr: { id: "9", title: "t\x1b[2J" },
      lastCommit: { date: new Date(), author: "a\x1b]52;c;aGk=\x07" },
    };
    const gitError = Object.assign(new Error("fatal: \x1b]52;c;aGk=\x07"), { name: "GitError" });
    const a = actions({
      load: vi.fn(async () => ({ repository: "demo", rows: [...ROWS, row] })),
      switchBranch: vi.fn(async (r: BranchRow) => {
        if (r === row) throw gitError;
      }),
    });
    const { lastFrame, stdin } = await setup(a);
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(RAW);
    expect(frame).toContain("x^[[2J");
    expect(frame).toContain("#9 t^[[2J");
    expect(frame).toContain("a^[]52;c");
    await press(stdin, "/", "x", "\r", " ");
    await vi.waitFor(() => expect(lastFrame()).toContain("fatal: ^[]52;c;aGk=^G"));
    expect(lastFrame()).not.toMatch(RAW);
  });
});
