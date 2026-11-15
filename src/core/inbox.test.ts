import { describe, expect, it } from "vitest";
import type { PullRequest } from "../aws/codecommit.js";
import { fakeApi, pullRequest } from "../testing/fakes.js";
import {
  classify,
  fetchInbox,
  fromCache,
  type Inbox,
  type InboxItem,
  inApprovalPool,
  isPending,
  isUnread,
  loadAllDetails,
  loadDetails,
  resolveMe,
  toCache,
  watchedRepositories,
  withUnread,
} from "./inbox.js";

const ME = "arn:aws:iam::123456789012:user/me";
const ROLE_ME = "arn:aws:sts::123456789012:assumed-role/Dev/me";
const ALICE = "arn:aws:iam::123456789012:user/alice";

const rule = (members?: unknown, extra: object = {}) => ({
  name: "r",
  content: JSON.stringify({
    Version: "2018-11-08",
    Statements: [
      {
        Type: "Approvers",
        NumberOfApprovalsNeeded: 1,
        ...(members === undefined ? {} : { ApprovalPoolMembers: members }),
      },
    ],
    ...extra,
  }),
});

const store = () => {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string) => void m.set(k, v),
  };
};

const withRules = (...rules: PullRequest["approvalRules"][number][]) =>
  pullRequest({ approvalRules: rules });

const item = (section: InboxItem["section"], approvedBy?: string[]): InboxItem => ({
  section,
  pr: pullRequest(),
  unread: false,
  ...(approvedBy ? { approvedBy } : {}),
});

describe("watchedRepositories", () => {
  it("puts --repo first, then the config, then the clone", () => {
    expect(watchedRepositories("x", { repos: ["a"] }, "c")).toEqual(["x"]);
    expect(watchedRepositories(undefined, { repos: ["a", "b"] }, "c")).toEqual(["a", "b"]);
    expect(watchedRepositories(undefined, { repos: [] }, "c")).toEqual(["c"]);
    expect(watchedRepositories(undefined, {}, undefined)).toBeUndefined();
  });
});

/** An API whose credentials have `accessKeyId`, counting STS calls. */
function apiFor(accessKeyId: string) {
  const api = {
    calls: 0,
    credentialId: async () => accessKeyId,
    callerArn: async () => (api.calls++, `${ME}-${accessKeyId}`),
  };
  return api;
}

describe("resolveMe", () => {
  it("asks STS once per set of credentials and caches the answer", async () => {
    const s = store();
    const api = apiFor("AKIA1");
    expect(await resolveMe(api, s)).toBe(`${ME}-AKIA1`);
    expect(await resolveMe(api, s)).toBe(`${ME}-AKIA1`);
    expect(api.calls).toBe(1);
  });

  it("asks again when the credentials change, as when a profile's role changes", async () => {
    const s = store();
    await resolveMe(apiFor("AKIA1"), s);
    const next = apiFor("ASIA2");
    expect(await resolveMe(next, s)).toBe(`${ME}-ASIA2`);
    expect(next.calls).toBe(1);
  });

  it("never writes the access key ID itself", async () => {
    const s = store();
    await resolveMe(apiFor("AKIAIOSFODNN7EXAMPLE"), s);
    const [key] = [...s.m.keys()];
    expect(key).toMatch(/^cred:[0-9a-f]{32}$/);
    expect(key).not.toContain("AKIA");
  });

  it("asks STS, uncached, when the credentials cannot be read", async () => {
    const s = store();
    const api = {
      credentialId: async () => {
        throw new Error("no credentials");
      },
      callerArn: async () => ME,
    };
    expect(await resolveMe(api, s)).toBe(ME);
    expect(s.m.size).toBe(0);
  });

  it("still answers when the cache cannot be written", async () => {
    const api = apiFor("AKIA1");
    const broken = {
      get: async () => undefined,
      set: async () => {
        throw new Error("EROFS");
      },
    };
    expect(await resolveMe(api, broken)).toBe(`${ME}-AKIA1`);
  });
});

describe("inApprovalPool", () => {
  it("accepts a PR without rules", () => {
    expect(inApprovalPool(withRules(), ME)).toBe(true);
  });

  it.each([
    ["an exact ARN", [ME], ME, true],
    ["another user", [ALICE], ME, false],
    ["a wildcard", ["arn:aws:sts::123456789012:assumed-role/Dev/*"], ROLE_ME, true],
    [
      "a wildcard for another role",
      ["arn:aws:sts::123456789012:assumed-role/Ops/*"],
      ROLE_ME,
      false,
    ],
    ["a ? wildcard", ["arn:aws:iam::123456789012:user/m?"], ME, true],
    ["regex characters taken literally", ["arn:aws:iam::123456789012:user/m."], ME, false],
    ["a star in the middle", ["arn:aws:iam::*:user/me"], ME, true],
    ["stars that need backtracking", ["arn:*:*e"], ME, true],
    ["a pattern longer than the ARN", [`${ME}*x`], ME, false],
    [
      "many stars against a long ARN",
      [`arn:${"*a".repeat(40)}`],
      `arn:${"a".repeat(5000)}b`,
      false,
    ],
    ["a short user name", ["CodeCommitApprovers:123456789012:me"], ME, true],
    ["a short session name", ["CodeCommitApprovers:123456789012:me"], ROLE_ME, true],
    ["a short name in another account", ["CodeCommitApprovers:999999999999:me"], ME, false],
    ["a short name for someone else", ["CodeCommitApprovers:123456789012:alice"], ME, false],
    ["an unknown member form", ["somebody"], ME, true],
    ["a member that is not a string", [7], ME, true],
    ["a pool that is not an array", "me", ME, true],
    ["no pool at all", undefined, ME, true],
  ])("with %s", (_, members, me, want) => {
    expect(inApprovalPool(withRules(rule(members)), me)).toBe(want);
  });

  it("accepts when any rule's pool matches", () => {
    expect(inApprovalPool(withRules(rule([ALICE]), rule([ME])), ME)).toBe(true);
  });

  it.each([
    ["not JSON", "{"],
    ["no statements", "{}"],
  ])("keeps a PR whose rule is %s", (_, content) => {
    expect(inApprovalPool(withRules(rule([ALICE]), { name: "x", content }), ME)).toBe(true);
  });
});

describe("classify", () => {
  it("sorts by author and status", () => {
    expect(classify(pullRequest({ authorArn: ME }), ME)).toBe("mine");
    expect(classify(pullRequest({ authorArn: ALICE }), ME)).toBe("awaiting");
    expect(classify(pullRequest({ status: "CLOSED" }), ME)).toBeUndefined();
    expect(classify(pullRequest({ approvalRules: [rule([ALICE])] }), ME)).toBeUndefined();
  });
});

describe("isUnread", () => {
  const pr = pullRequest({
    authorArn: ALICE,
    creationDate: new Date("2026-11-01T00:00:00Z"),
    lastActivityDate: new Date("2026-11-02T00:00:00Z"),
  });

  it("compares the last activity with when the PR was opened", () => {
    expect(isUnread(pr, new Date("2026-11-01T12:00:00Z"), ME)).toBe(true);
    expect(isUnread(pr, new Date("2026-11-02T00:00:00Z"), ME)).toBe(false);
  });

  it("treats a never-opened PR as unread unless it is one's own and untouched", () => {
    expect(isUnread(pr, undefined, ME)).toBe(true);
    const mine = { ...pr, authorArn: ME };
    expect(isUnread(mine, undefined, ME)).toBe(true);
    expect(isUnread({ ...mine, lastActivityDate: mine.creationDate }, undefined, ME)).toBe(false);
  });
});

describe("isPending", () => {
  it("drops awaiting PRs the user approved", () => {
    expect(isPending(item("awaiting"), ME)).toBe(true);
    expect(isPending(item("awaiting", [ALICE]), ME)).toBe(true);
    expect(isPending(item("awaiting", [ME]), ME)).toBe(false);
    expect(isPending(item("mine", [ME]), ME)).toBe(true);
  });
});

describe("fetchInbox", () => {
  const prs = [
    pullRequest({ id: "1", repository: "a", authorArn: ALICE, lastActivityDate: new Date(1000) }),
    pullRequest({ id: "2", repository: "b", authorArn: ME, lastActivityDate: new Date(3000) }),
    pullRequest({ id: "3", repository: "a", authorArn: ALICE, lastActivityDate: new Date(2000) }),
    pullRequest({ id: "4", repository: "a", status: "CLOSED" }),
    pullRequest({ id: "5", repository: "c", authorArn: ALICE }),
    pullRequest({
      id: "6",
      repository: "a",
      authorArn: ALICE,
      approvalRules: [rule(["CodeCommitApprovers:123456789012:alice"])],
    }),
  ];
  const deps = (api = fakeApi(prs), seen = new Map<string, Date>()) => ({
    api,
    me: ME,
    region: "us-east-1",
    seen,
    concurrency: 2,
  });

  it("collects awaiting then mine across repositories, newest first", async () => {
    const seen = new Map([["us-east-1/3", new Date(5000)]]);
    const inbox = await fetchInbox(["a", "b"], deps(fakeApi(prs), seen));
    expect(inbox.items.map((i) => [i.section, i.pr.id, i.unread])).toEqual([
      ["awaiting", "3", false],
      ["awaiting", "1", true],
      ["mine", "2", false],
    ]);
    expect(inbox).toMatchObject({ me: ME, repositories: ["a", "b"], errors: [] });
  });

  it("reports a repository that fails and keeps the rest", async () => {
    const api = fakeApi(prs, {
      listPullRequestIds: async (repo) => {
        if (repo === "b")
          throw Object.assign(new Error("gone"), { name: "RepositoryDoesNotExistException" });
        return ["1"];
      },
    });
    const inbox = await fetchInbox(["a", "b"], deps(api));
    expect(inbox.items.map((i) => i.pr.id)).toEqual(["1"]);
    expect(inbox.errors.map((e) => [e.repository, e.error.message])).toEqual([["b", "gone"]]);
  });

  it("throws when every repository fails", async () => {
    const api = fakeApi(prs, {
      listPullRequestIds: async () => {
        throw new Error("expired");
      },
    });
    await expect(fetchInbox(["a", "b"], deps(api))).rejects.toThrow("expired");
  });

  it("returns an empty inbox for no repositories", async () => {
    expect((await fetchInbox([], deps())).items).toEqual([]);
  });

  it("skips PRs closed between listing and reading, and reports other failures once", async () => {
    const api = fakeApi(prs, {
      listPullRequestIds: async (repo) => (repo === "a" ? ["1", "9"] : ["7", "8"]),
      getPullRequests: async ([id]) => {
        if (id === "9")
          throw Object.assign(new Error("closed"), { name: "PullRequestDoesNotExistException" });
        if (id === "7" || id === "8") throw "throttled";
        return [prs[0] as PullRequest];
      },
    });
    const inbox = await fetchInbox(["a", "b"], deps(api));
    expect(inbox.items.map((i) => i.pr.id)).toEqual(["1"]);
    expect(inbox.errors.map((e) => [e.repository, e.error.message])).toEqual([["b", "throttled"]]);
  });
});

describe("loadDetails", () => {
  const awaiting: InboxItem = { section: "awaiting", pr: pullRequest(), unread: false };
  const mine: InboxItem = { section: "mine", pr: pullRequest({ authorArn: ME }), unread: false };

  it("loads approvals for awaiting and rules and conflicts for mine", async () => {
    const api = fakeApi([], { approvers: async () => [ME] });
    expect(await loadDetails(awaiting, api)).toMatchObject({ approvedBy: [ME] });
    expect(await loadDetails(mine, api)).toMatchObject({
      rules: { satisfied: ["one"], notSatisfied: ["two"] },
      mergeable: true,
    });
  });

  it("keeps the row with the error when a call fails", async () => {
    const api = fakeApi([], {
      approvers: async () => {
        throw new Error("denied");
      },
      mergeable: async () => {
        throw "boom";
      },
    });
    expect(await loadDetails(awaiting, api)).toEqual({ ...awaiting, detailError: "denied" });
    expect(await loadDetails(mine, api)).toEqual({ ...mine, detailError: "boom" });
  });

  it("loads all rows in order and reports each", async () => {
    const seen: string[] = [];
    const out = await loadAllDetails(
      [awaiting, mine],
      (i) => loadDetails(i, fakeApi()),
      2,
      (i) => seen.push(i.section),
    );
    expect(out.map((i) => i.section)).toEqual(["awaiting", "mine"]);
    expect(seen.toSorted()).toEqual(["awaiting", "mine"]);
    expect(await loadAllDetails([mine], (i) => loadDetails(i, fakeApi()), 1)).toHaveLength(1);
  });
});

describe("cache", () => {
  const inbox: Inbox = {
    me: ME,
    repositories: ["b", "a"],
    items: [
      {
        section: "awaiting",
        pr: pullRequest({ approvalRules: [rule([ME])] }),
        unread: true,
        approvedBy: [ALICE],
      },
      {
        section: "mine",
        pr: pullRequest({ id: "2", authorArn: ME }),
        unread: false,
        rules: { approved: true, overridden: false, satisfied: ["r"], notSatisfied: [] },
        mergeable: false,
        detailError: "dropped",
      },
    ],
    errors: [{ repository: "c", error: new Error("x") }],
    fetchedAt: new Date("2026-11-15T00:00:00Z"),
  };

  it("round-trips through JSON for the same account, region and repositories", () => {
    const raw = JSON.parse(JSON.stringify(toCache(inbox, "us-east-1")));
    const back = fromCache(raw, ME, "us-east-1", ["a", "b"]);
    const { detailError: _, ...second } = inbox.items[1] as InboxItem;
    expect(back).toEqual({
      ...inbox,
      repositories: ["a", "b"],
      items: [inbox.items[0], second],
      errors: [],
    });
  });

  it.each([
    ["another region", ME, "eu-west-1", ["a", "b"]],
    ["another account", ALICE, "us-east-1", ["a", "b"]],
    ["other repositories", ME, "us-east-1", ["a"]],
  ])("ignores a cache for %s", (_, me, region, repos) => {
    expect(fromCache(toCache(inbox, "us-east-1"), me, region, repos)).toBeUndefined();
  });

  it.each([
    ["nothing", undefined],
    ["a string", "x"],
    ["no items", { key: '["m","r",[]]' }],
  ])("ignores %s", (_, raw) => {
    expect(fromCache(raw, ME, "r", [])).toBeUndefined();
  });

  it("leaves out rules that do not have the expected shape", () => {
    const good = JSON.parse(JSON.stringify(toCache(inbox, "r")));
    for (const rules of [
      {},
      null,
      { approved: true, overridden: false, satisfied: [1], notSatisfied: [] },
    ]) {
      const back = fromCache({ ...good, items: [{ ...good.items[1], rules }] }, ME, "r", [
        "a",
        "b",
      ]);
      expect(back?.items[0]?.rules, JSON.stringify(rules)).toBeUndefined();
    }
  });

  it("drops a cache with a bad date or a bad item", () => {
    const good = JSON.parse(JSON.stringify(toCache(inbox, "r")));
    expect(fromCache({ ...good, fetchedAt: "soon" }, ME, "r", ["a", "b"])).toBeUndefined();
    for (const bad of [
      null,
      { section: "other", pr: {} },
      { section: "mine" },
      { section: "mine", pr: { ...good.items[0].pr, id: 1 } },
      { section: "mine", pr: { ...good.items[0].pr, creationDate: "x" } },
      { section: "mine", pr: { ...good.items[0].pr, lastActivityDate: "x" } },
      { section: "mine", pr: { ...good.items[0].pr, approvalRules: null } },
      { section: "mine", pr: { ...good.items[0].pr, sourceBranch: undefined } },
    ]) {
      expect(
        fromCache({ ...good, items: [bad] }, ME, "r", ["a", "b"]),
        JSON.stringify(bad),
      ).toBeUndefined();
    }
  });

  it("recomputes unread marks against seen.json", () => {
    const seen = new Map([["us-east-1/1", new Date("2026-12-01T00:00:00Z")]]);
    const fresh = withUnread(inbox, "us-east-1", seen);
    expect(fresh.items.map((i) => i.unread)).toEqual([false, true]);
  });

  it("does not take a mark for the same PR id in another account", () => {
    const other = new Map([["us-east-1/999999999999/1", new Date("2026-12-01T00:00:00Z")]]);
    const unread = (seen: ReadonlyMap<string, Date>) =>
      withUnread(inbox, "us-east-1", seen).items.map((i) => i.unread);
    expect(unread(other)).toEqual(unread(new Map()));
    expect(unread(new Map())[0]).toBe(true);
  });
});
