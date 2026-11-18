import { describe, expect, it, vi } from "vitest";
import { press, render } from "../../testing/keys.js";
import { RepoPicker } from "./RepoPicker.js";

function setup(over: Partial<Parameters<typeof RepoPicker>[0]["actions"]> = {}) {
  let watched: readonly string[] = ["infra"];
  const actions = {
    listRepositories: vi.fn(async () => ["demo", "infra", "sandbox"]),
    watched: () => watched,
    toggleWatch: vi.fn(async (name: string) => {
      watched = watched.includes(name) ? watched.filter((r) => r !== name) : [...watched, name];
      return watched;
    }),
    ...over,
  };
  const props = { onSelect: vi.fn(), onOpenList: vi.fn(), onBack: vi.fn() };
  const r = render(<RepoPicker actions={actions} current={["demo"]} {...props} />);
  return { ...r, ...props, actions };
}

describe("RepoPicker", () => {
  it("lists repositories with the watched ones starred", async () => {
    const { lastFrame } = setup();
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    expect(lastFrame()).toContain("1 watched");
    expect(lastFrame()).toMatch(/> {3}demo/);
    expect(lastFrame()).toContain("★ infra");
  });

  it("watches and unwatches with w", async () => {
    const { lastFrame, stdin } = setup();
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    await press(stdin, "w");
    await vi.waitFor(() => expect(lastFrame()).toContain("Watching demo."));
    expect(lastFrame()).toContain("2 watched");
    await press(stdin, "j", "w");
    await vi.waitFor(() => expect(lastFrame()).toContain("Stopped watching infra."));
  });

  it("shows why a watch could not be saved", async () => {
    const { lastFrame, stdin } = setup({
      toggleWatch: async () => {
        throw new Error("config.json: invalid JSON");
      },
    });
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    await press(stdin, "w");
    await vi.waitFor(() => expect(lastFrame()).toContain("config.json: invalid JSON"));
  });

  it("selects, opens the PR list, and goes back", async () => {
    const { lastFrame, stdin, onSelect, onOpenList, onBack } = setup();
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    await press(stdin, "j", "\r");
    expect(onSelect).toHaveBeenCalledWith("infra");
    await press(stdin, "p");
    expect(onOpenList).toHaveBeenCalledWith("infra");
    await press(stdin, "\u001B");
    await vi.waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it("goes to the first and last repository with < > and Home End", async () => {
    const { lastFrame, stdin } = setup();
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    await press(stdin, ">");
    expect(lastFrame()).toMatch(/> +sandbox/);
    await press(stdin, "<", "\x1b[F");
    expect(lastFrame()).toMatch(/> +sandbox/);
    await press(stdin, "\x1b[H");
    expect(lastFrame()).toMatch(/> +demo/);
  });

  it("filters by name", async () => {
    const { lastFrame, stdin } = setup();
    await vi.waitFor(() => expect(lastFrame()).toContain("sandbox"));
    await press(stdin, "/", "s", "a", "\r");
    expect(lastFrame()).toContain("filter: sa");
    expect(lastFrame()).not.toContain("infra");
    await press(stdin, "/", "z", "\r");
    expect(lastFrame()).toContain("No repository matches.");
    await press(stdin, "/", "\u001b");
    await vi.waitFor(() => expect(lastFrame()).toContain("infra"));
    await press(stdin, "k");
    expect(lastFrame()).toMatch(/> {3}demo/);
  });

  it("shows a listing error and an empty region", async () => {
    const failing = setup({
      listRepositories: async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      },
    });
    await vi.waitFor(() => expect(failing.lastFrame()).toContain("Error:"));
    const empty = setup({ listRepositories: async () => [] });
    await vi.waitFor(() => expect(empty.lastFrame()).toContain("No repositories in this region."));
    expect(empty.lastFrame()).toContain("1 watched");
  });

  it("says when nothing is watched yet", async () => {
    const { lastFrame } = setup({ watched: () => [] });
    expect(lastFrame()).toContain("none watched yet: press w");
  });
});
