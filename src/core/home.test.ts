import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeApi, fakeState, pullRequest } from "../testing/fakes.js";
import { homeActions } from "./home.js";

const ME = "arn:aws:iam::123456789012:user/me";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lazycc-home-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const prs = [
  pullRequest({ id: "1", repository: "a" }),
  pullRequest({ id: "2", repository: "b", authorArn: ME }),
];

function setup(repos?: string[]) {
  const state = fakeState();
  const actions = homeActions({
    api: fakeApi(prs),
    state,
    config: repos ? { repos, concurrency: 3 } : {},
    env: { XDG_CONFIG_HOME: dir },
    region: "us-east-1",
    me: ME,
    initial: repos,
  });
  return { state, actions };
}

const fail = async () => {
  throw new Error("EROFS");
};

describe("homeActions", () => {
  it("fetches, loads details, saves and reads back the cache with fresh unread marks", async () => {
    const { state, actions } = setup(["a", "b"]);
    expect(actions).toMatchObject({ concurrency: 3, initial: ["a", "b"], me: ME });
    expect(await actions.cached(["a", "b"])).toBeUndefined();
    const inbox = await actions.fetch(["a", "b"]);
    expect(inbox.items.map((i) => i.pr.id)).toEqual(["1", "2"]);
    const items = await Promise.all(inbox.items.map(actions.details));
    expect(items[1]?.rules).toBeDefined();
    await actions.save({ ...inbox, items });
    actions.markSeen(inbox.items[0]!.pr);
    await state.flush();
    const cached = await actions.cached(["b", "a"]);
    expect(cached?.items.map((i) => [i.pr.id, i.unread])).toEqual([
      ["1", false],
      ["2", true],
    ]);
    const mark = await actions.unreadMarker();
    expect(mark({ ...inbox }).items[0]?.unread).toBe(false);
  });

  it("lists repositories once, retrying after a failure, and builds console URLs", async () => {
    let calls = 0;
    const actions = homeActions({
      api: fakeApi(prs, {
        listRepositories: async () => {
          calls++;
          if (calls === 1) throw new Error("throttled");
          return ["a", "b"];
        },
      }),
      state: fakeState(),
      config: {},
      env: {},
      region: "us-east-1",
      me: ME,
      initial: undefined,
    });
    await expect(actions.listRepositories()).rejects.toThrow("throttled");
    expect(await actions.listRepositories()).toEqual(["a", "b"]);
    expect(await actions.listRepositories()).toEqual(["a", "b"]);
    expect(calls).toBe(2);
    expect(actions.consoleUrl(prs[0] as never)).toContain("/repositories/a/pull-requests/1/");
  });

  it("toggles a repository in the config file", async () => {
    const { actions } = setup();
    expect(actions.watched()).toEqual([]);
    expect(await actions.toggleWatch("a")).toEqual(["a"]);
    expect(await actions.toggleWatch("b")).toEqual(["a", "b"]);
    expect(await actions.toggleWatch("a")).toEqual(["b"]);
    expect(actions.watched()).toEqual(["b"]);
    const file = JSON.parse(await readFile(join(dir, "lazycc", "config.json"), "utf8"));
    expect(file).toEqual({ repos: ["b"] });
  });

  it("keeps the old list when the config cannot be saved", async () => {
    const { actions } = setup(["a"]);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "lazycc"), { recursive: true });
    await writeFile(join(dir, "lazycc", "config.json"), "{bad");
    await expect(actions.toggleWatch("b")).rejects.toThrow();
    expect(actions.watched()).toEqual(["a"]);
  });

  it("ignores failures to save the cache or a read mark", async () => {
    const { state, actions } = setup(["a"]);
    Object.assign(state.cache, { set: fail });
    Object.assign(state.seen, { mark: fail });
    await expect(actions.save(await actions.fetch(["a"]))).resolves.toBeUndefined();
    expect(() => actions.markSeen({ id: "1" })).not.toThrow();
  });
});
