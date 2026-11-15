import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BrowseActions, type BrowseNode, NotFoundError } from "../core/browse.js";
import { UserError } from "../core/errors.js";
import { press, render, settle } from "../testing/keys.js";

const exit = vi.fn();
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  useApp: () => ({ exit }),
}));

const { BrowseApp } = await import("./BrowseApp.js");

const LONG = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

/** A small tree on main; dev has only the root README. */
function node(ref: string, path: string): BrowseNode {
  const p = path.replace(/^\/+|\/+$/g, "");
  if (ref === "dev") {
    if (p === "") return { kind: "folder", ref, path: "", entries: [] };
    throw new NotFoundError(`demo has no file or folder ${p} at dev.`);
  }
  if (ref !== "main") throw new UserError(`demo has no branch or commit named ${ref}.`);
  switch (p) {
    case "":
      return {
        kind: "folder",
        ref,
        path: "",
        entries: [
          { name: "docs", path: "docs", type: "folder" },
          { name: "src", path: "src", type: "folder" },
          { name: "README.md", path: "README.md", type: "file" },
          { name: "logo.png", path: "logo.png", type: "file" },
          { name: "huge.bin", path: "huge.bin", type: "file" },
          { name: "vendor", path: "vendor", type: "submodule" },
        ],
      };
    case "src":
      return {
        kind: "folder",
        ref,
        path: "src",
        entries: [{ name: "long.ts", path: "src/long.ts", type: "file" }],
      };
    case "docs":
      return { kind: "folder", ref, path: "docs", entries: [] };
    case "crlf.txt":
      return { kind: "file", ref, path: p, size: 10, text: "one\r\ntwo\r\n" };
    case "README.md":
      return { kind: "file", ref, path: p, size: 20, text: "# demo\n\tindented\x1b[2J\n" };
    case "src/long.ts":
      return { kind: "file", ref, path: p, size: LONG.length, text: LONG };
    case "logo.png":
      return { kind: "file", ref, path: p, size: 4, binary: true };
    case "huge.bin":
      return { kind: "file", ref, path: p, tooLarge: true };
    default:
      throw new NotFoundError(`demo has no file or folder ${p} at main.`);
  }
}

function actions(over: Partial<BrowseActions> = {}): BrowseActions {
  return {
    repository: "demo",
    startRef: "main",
    open: vi.fn(async (ref: string, path: string) => node(ref, path)),
    branches: vi.fn(async () => ["dev", "feature/x", "main"]),
    consoleUrl: (ref, path) => `https://console/${ref}/${path}`,
    ...over,
  };
}

async function setup(a = actions(), path = "", ready = "README.md") {
  const r = render(<BrowseApp actions={a} path={path} />);
  await vi.waitFor(() => expect(r.lastFrame()).toContain(ready));
  return { ...r, a };
}

beforeEach(() => {
  exit.mockReset();
});

describe("BrowseApp folders", () => {
  it("leaves for another view or the picker on 1, 2 and r", async () => {
    for (const [k, want] of [
      ["1", { view: "home" }],
      ["2", { view: "branches" }],
      ["r", { pick: true }],
    ] as const) {
      exit.mockReset();
      const onSwitch = vi.fn();
      const r = render(<BrowseApp actions={actions()} path="" onSwitch={onSwitch} />);
      await vi.waitFor(() => expect(r.lastFrame()).toContain("1 home 2 branches"));
      await press(r.stdin, "3", k);
      expect(onSwitch.mock.calls).toEqual([[want]]);
      expect(exit).toHaveBeenCalledOnce();
      r.unmount();
    }
  });

  it("lists the root with marks, folders first", async () => {
    const { lastFrame } = await setup();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("browse demo @ main : /");
    expect(frame).toMatch(/> docs\//);
    expect(frame).toContain("vendor (submodule)");
  });

  it("opens a folder and comes back up onto it", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "j", "\r");
    expect(lastFrame()).toContain("@ main : src/");
    expect(lastFrame()).toContain("long.ts");
    await press(stdin, "h");
    expect(lastFrame()).toMatch(/> src\//);
    await press(stdin, "l", "\x7f");
    expect(lastFrame()).toMatch(/> src\//);
    await press(stdin, "h");
    expect(exit).not.toHaveBeenCalled();
  });

  it("shows an empty folder", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "\r");
    expect(lastFrame()).toContain("Empty folder.");
  });

  it("filters by name and clears with Esc", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "/", "r", "e", "a", "\r");
    expect(lastFrame()).toContain("filter: rea");
    expect(lastFrame()).toMatch(/> README.md/);
    expect(lastFrame()).not.toContain("docs/");
    await press(stdin, "/", "z", "z", "\r");
    expect(lastFrame()).toContain("Nothing matches.");
    await press(stdin, "/", "\u001B");
    await settle();
    expect(lastFrame()).toContain("docs/");
  });

  it("moves with k and G, and says a submodule cannot be opened", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "G");
    expect(lastFrame()).toMatch(/> vendor/);
    await press(stdin, "\r");
    expect(lastFrame()).toContain("vendor is a submodule");
    await press(stdin, "k");
    expect(lastFrame()).toMatch(/> huge.bin/);
    await press(stdin, "g");
    expect(lastFrame()).toMatch(/> docs\//);
  });

  it("shows the console URL and reloads", async () => {
    const { stdin, lastFrame, a } = await setup();
    await press(stdin, "u");
    expect(lastFrame()).toContain("https://console/main/");
    await press(stdin, "\u0012");
    expect(a.open).toHaveBeenLastCalledWith("main", "/");
  });

  it("quits from a folder with q", async () => {
    const { stdin } = await setup();
    await press(stdin, "q");
    expect(exit).toHaveBeenCalled();
  });

  it("shows help and closes it on any key", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "?");
    expect(lastFrame()).toContain("Browse help");
    await press(stdin, "x");
    expect(lastFrame()).toContain("README.md");
  });

  it("shows a failed first load as an error", async () => {
    const a = actions({ startRef: "nope" });
    const { lastFrame } = await setup(a, "", "Error:");
    expect(lastFrame()).toContain("no branch or commit named nope");
  });
});

describe("BrowseApp files", () => {
  it("shows a file with line numbers and control characters made harmless", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "j", "j", "\r");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("@ main : README.md");
    expect(frame).toContain("1 │ # demo");
    expect(frame).toContain("2 │     indented?[2J");
    await press(stdin, "q");
    expect(lastFrame()).toMatch(/> README.md/);
    expect(exit).not.toHaveBeenCalled();
  });

  it("scrolls a long file by line, half page, top and end", async () => {
    const { stdin, lastFrame } = await setup(actions(), "src/long.ts", "line 1");
    expect(lastFrame()).toContain("100 lines");
    await press(stdin, "j");
    expect(lastFrame()).toMatch(/2 │ line 2/);
    expect(lastFrame()).not.toMatch(/ 1 │ line 1\n/);
    await press(stdin, "k", "\u0004");
    expect(lastFrame()).toContain("· 10-27");
    await press(stdin, "\u0015");
    expect(lastFrame()).toMatch(/ 1 │ line 1/);
    await press(stdin, "G");
    expect(lastFrame()).toContain("100 │ line 100");
    await press(stdin, "g");
    expect(lastFrame()).toMatch(/ 1 │ line 1/);
    await press(stdin, "h");
    expect(lastFrame()).toContain("@ main : src/");
  });

  it("opened straight on a file, goes back to its folder", async () => {
    const { stdin, lastFrame } = await setup(actions(), "README.md", "# demo");
    await press(stdin, "\u001B");
    await settle();
    expect(lastFrame()).toMatch(/> README.md/);
  });

  it("does not show binary or too-large files", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "j", "j", "j", "\r");
    expect(lastFrame()).toContain("Binary file (4 bytes), not shown.");
    await press(stdin, "q", "j", "\r");
    expect(lastFrame()).toContain("Use lazycc clone");
  });

  it("shows a failed open as a note and stays put", async () => {
    const a = actions({
      open: vi.fn(async (ref: string, path: string) => {
        if (path === "README.md") throw new Error("boom");
        return node(ref, path);
      }),
    });
    const { stdin, lastFrame } = await setup(a);
    await press(stdin, "j", "j", "\r");
    expect(lastFrame()).toContain("boom");
    expect(lastFrame()).toMatch(/> README.md/);
  });
});

describe("BrowseApp refs", () => {
  it("picks a branch from the list, falling back to the root", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "j", "\r", "b");
    expect(lastFrame()).toContain("feature/x");
    await press(stdin, "\r");
    expect(lastFrame()).toContain("@ dev : /");
    expect(lastFrame()).toContain("src is not on dev; showing the root.");
  });

  it("filters the list by typing, and moves with arrows", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "b", "a", "\u001B[B", "\u001B[A");
    expect(lastFrame()).toMatch(/> feature\/x/);
    expect(lastFrame()).not.toContain("  dev");
    await press(stdin, "\u001B[B", "\r");
    expect(lastFrame()).toContain("@ main : /");
  });

  it("takes a typed commit ID when no branch matches, and reports a bad one", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "b", "z", "z");
    expect(lastFrame()).toContain("No branch matches.");
    await press(stdin, "\r");
    expect(lastFrame()).toContain("no branch or commit named zz");
    expect(lastFrame()).toContain("@ main : /");
  });

  it("cancels with Esc, and reports a failed branch list", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "b", "\u001B");
    await settle();
    expect(lastFrame()).not.toContain("ref:");
    const a = actions({
      branches: vi.fn(async () => {
        throw new Error("denied");
      }),
    });
    const o = await setup(a);
    await press(o.stdin, "b");
    expect(o.lastFrame()).toContain("denied");
  });
});

describe("BrowseApp review fixes", () => {
  it("drops CRLF line endings instead of showing them", async () => {
    const { lastFrame } = await setup(actions(), "crlf.txt", "one");
    expect(lastFrame()).toContain("2 │ two");
    expect(lastFrame()).not.toContain("one?");
  });

  it("comes back up onto the folder opened through a filter", async () => {
    const { stdin, lastFrame } = await setup();
    await press(stdin, "/", "s", "r", "c", "\r", "\r");
    expect(lastFrame()).toContain("@ main : src/");
    await press(stdin, "h");
    expect(lastFrame()).toMatch(/> src\//);
  });

  it("keeps its place when switching refs fails for another reason", async () => {
    const a = actions({
      open: vi.fn(async (ref: string, path: string) => {
        if (ref === "dev") throw new Error("throttled");
        return node(ref, path);
      }),
    });
    const { stdin, lastFrame } = await setup(a);
    // A fixed 30 ms per key let a key reach a handler that had not caught up
    // with the previous one on a slow runner (macos-15): Enter opened docs/,
    // or reached a picker that had not drawn. Wait for each step to show.
    await press(stdin, "j");
    await vi.waitFor(() => expect(lastFrame()).toMatch(/> src\//));
    await press(stdin, "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("@ main : src/"));
    await press(stdin, "b");
    await vi.waitFor(() => expect(lastFrame()).toContain("ref:"));
    await press(stdin, "\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("throttled"));
    expect(lastFrame()).toContain("@ main : src/");
  });

  it("does not quit on q while a file reloads", async () => {
    let release = () => {};
    const a = actions();
    const { stdin, lastFrame } = await setup(a, "README.md", "# demo");
    vi.mocked(a.open).mockImplementationOnce(
      (ref, path) => new Promise((r) => (release = () => r(node(ref, path)))),
    );
    await press(stdin, "\u0012", "q");
    expect(exit).not.toHaveBeenCalled();
    release();
    await settle();
    expect(lastFrame()).toContain("# demo");
  });
});

describe("BrowseApp with hostile text", () => {
  it("shows error messages with control characters made visible", async () => {
    const refusal = Object.assign(new Error("no path a\x1b]52;c;aGk=\x07"), { name: "UserError" });
    const a = actions({ open: vi.fn(async () => Promise.reject(refusal)) });
    const { lastFrame } = await setup(a, "", "Error:");
    expect(lastFrame()).toContain("no path a^[]52;c;aGk=^G");
    expect(lastFrame()).not.toContain("\x1b]52");
  });
});
