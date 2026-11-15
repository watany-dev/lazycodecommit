import { describe, expect, it, vi } from "vitest";
import { fakeState } from "../testing/fakes.js";
import {
  type CommentDraft,
  type Commits,
  canEdit,
  describeFailure,
  draftKey,
  draftStorage,
  editDraft,
  lineReader,
  newDraft,
  parseDrafts,
  postAnyway,
  reanchor,
  submitDrafts,
} from "./commentDrafts.js";

const OLD: Commits = { beforeCommitId: "dest1", afterCommitId: "src1" };
const NEW: Commits = { beforeCommitId: "dest1", afterCommitId: "src2" };

const general = (content = "general") => newDraft(content, { kind: "general" }, OLD);
const inline = (lineText = "const a = 1;", content = "inline") =>
  newDraft(
    content,
    {
      kind: "inline",
      location: { filePath: "a.ts", filePosition: 3, relativeFileVersion: "AFTER", lineText },
    },
    OLD,
  );
const reply = () =>
  newDraft(
    "reply",
    { kind: "reply", inReplyTo: "c1", replyTo: { author: "bob", excerpt: "why?" } },
    OLD,
  );

function awsError(name: string, status?: number): Error {
  const e = Object.assign(
    new Error(`${name} message`),
    status === undefined ? {} : { $metadata: { httpStatusCode: status } },
  );
  e.name = name;
  return e;
}

function harness(fail: Map<number, Error> = new Map()) {
  const calls: { content: string; commits: Commits; token: string }[] = [];
  const saves: (readonly CommentDraft[])[] = [];
  const post = vi.fn(async (d: CommentDraft, commits: Commits, token: string) => {
    calls.push({ content: d.content, commits, token });
    const err = fail.get(calls.length);
    if (err) throw err;
  });
  const save = vi.fn(async (list: readonly CommentDraft[]) => {
    saves.push(list);
  });
  return { calls, saves, deps: { post, save } };
}

describe("newDraft", () => {
  it("gets its own id and token and remembers the commits it was written on", () => {
    const a = general();
    const b = general();
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(a.id);
    expect(a).toMatchObject({ content: "general", ...OLD });
    expect(Date.parse(a.createdAt)).not.toBeNaN();
  });
});

describe("submitDrafts", () => {
  it("posts in order, one at a time, and empties the list", async () => {
    const h = harness();
    const drafts = [general("1"), inline(), reply()];
    const progress = vi.fn();
    const r = await submitDrafts(drafts, { ...h.deps, progress });
    expect(h.calls.map((c) => c.content)).toEqual(["1", "inline", "reply"]);
    expect(h.calls.map((c) => c.token)).toEqual(drafts.map((d) => d.token));
    expect(r).toEqual({ remaining: [], posted: 3 });
    expect(h.saves.at(-1)).toEqual([]);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it("saves the draft as sending before posting, so a crash keeps its token", async () => {
    const h = harness();
    const d = general();
    h.deps.post.mockImplementationOnce(async () => {
      expect(h.saves.at(-1)?.[0]?.sent).toEqual(OLD);
    });
    await submitDrafts([d], h.deps);
    expect(h.deps.post).toHaveBeenCalledOnce();
  });

  it("stops at the first refusal and keeps it and the rest as drafts", async () => {
    const h = harness(new Map([[2, awsError("CommentDoesNotExistException", 400)]]));
    const drafts = [general("1"), reply(), general("3")];
    const r = await submitDrafts(drafts, h.deps);
    expect(r.posted).toBe(1);
    expect(r.remaining.map((d) => d.content)).toEqual(["reply", "3"]);
    expect(r.stopped?.problem).toEqual({
      kind: "failed",
      message: "CommentDoesNotExistException message",
    });
    expect(h.saves.at(-1)).toEqual(r.remaining);
  });

  it("retries a send that got no answer with the same token and commits, even after the tip moved", async () => {
    const first = harness(new Map([[1, awsError("TimeoutError")]]));
    const r1 = await submitDrafts([inline()], first.deps);
    expect(r1.stopped?.problem?.kind).toBe("unknown");
    const moved = reanchor(r1.remaining, NEW, () => "const a = 1;");
    const second = harness();
    await submitDrafts(moved, second.deps);
    expect(second.calls[0]).toEqual(first.calls[0]);
  });

  it("sends a refused draft again with the same token while nothing changed", async () => {
    const first = harness(new Map([[1, awsError("ThrottlingException", 400)]]));
    const r1 = await submitDrafts([general()], first.deps);
    const second = harness();
    await submitDrafts(r1.remaining, second.deps);
    expect(second.calls[0]!.token).toBe(first.calls[0]!.token);
  });

  it("takes a new token when a refused draft goes to new commits", async () => {
    const first = harness(new Map([[1, awsError("ThrottlingException", 400)]]));
    const r1 = await submitDrafts([general()], first.deps);
    const second = harness();
    await submitDrafts(
      reanchor(r1.remaining, NEW, () => undefined),
      second.deps,
    );
    expect(second.calls[0]!.commits).toEqual(NEW);
    expect(second.calls[0]!.token).not.toBe(first.calls[0]!.token);
  });

  it("skips moved drafts and leaves them in place", async () => {
    const h = harness();
    const drafts = reanchor([general("1"), inline("old line")], NEW, () => "new line");
    const r = await submitDrafts(drafts, h.deps);
    expect(h.calls.map((c) => c.content)).toEqual(["1"]);
    expect(r.remaining.map((d) => d.problem?.kind)).toEqual(["moved"]);
  });
});

describe("reanchor", () => {
  it("moves general comments, replies and unchanged lines to the new tip", () => {
    const lineAt = vi.fn(() => "const a = 1;");
    const out = reanchor([general(), reply(), inline()], NEW, lineAt);
    expect(out.map((d) => [d.afterCommitId, d.problem])).toEqual([
      ["src2", undefined],
      ["src2", undefined],
      ["src2", undefined],
    ]);
    expect(lineAt).toHaveBeenCalledWith(expect.objectContaining({ filePath: "a.ts" }));
  });

  it("marks an inline draft moved when its line reads differently or is gone", () => {
    const [changed] = reanchor([inline()], NEW, () => "const a = 2;");
    const [gone] = reanchor([inline()], NEW, () => undefined);
    expect(changed!.problem?.kind).toBe("moved");
    expect(changed!.afterCommitId).toBe("src1");
    expect(gone!.problem?.kind).toBe("moved");
  });

  it("leaves drafts already on the tip, and unsettled ones, alone", () => {
    const d = inline();
    const lineAt = vi.fn(() => "x");
    expect(reanchor([d], OLD, lineAt)).toEqual([d]);
    const unsettled = { ...d, problem: { kind: "unknown" as const, message: "t" } };
    expect(reanchor([unsettled], NEW, lineAt)).toEqual([unsettled]);
    expect(lineAt).not.toHaveBeenCalled();
  });
});

describe("postAnyway", () => {
  it("puts a moved draft on the tip at the same position", () => {
    const [moved] = reanchor([inline()], NEW, () => "other");
    const d = postAnyway(moved!, NEW);
    expect(d.problem).toBeUndefined();
    expect(d.afterCommitId).toBe("src2");
    const fine = general();
    expect(postAnyway(fine, NEW)).toBe(fine);
  });
});

describe("editDraft", () => {
  it("changes the content, takes a new token and clears a refusal", () => {
    const d = { ...general(), sent: OLD, problem: { kind: "failed" as const, message: "no" } };
    const e = editDraft(d, "better");
    expect(e).toMatchObject({ id: d.id, content: "better" });
    expect(e.token).not.toBe(d.token);
    expect(e.problem).toBeUndefined();
    expect(e.sent).toBeUndefined();
  });

  it("refuses while a send is unsettled, which could post twice", () => {
    const d = { ...general(), problem: { kind: "unknown" as const, message: "t" } };
    expect(canEdit(d)).toBe(false);
    expect(() => editDraft(d, "x")).toThrow(/already be posted/);
  });
});

describe("describeFailure", () => {
  it("calls an answer below 500 a refusal and anything else unknown", () => {
    expect(describeFailure(awsError("InvalidFilePositionException", 400)).kind).toBe("failed");
    expect(describeFailure(awsError("InternalFailure", 500)).kind).toBe("unknown");
    expect(describeFailure(awsError("TimeoutError")).kind).toBe("unknown");
    expect(describeFailure(awsError("ECONNRESET"))).toEqual({
      kind: "unknown",
      message: "ECONNRESET message",
    });
    expect(describeFailure("boom")).toEqual({ kind: "unknown", message: "boom" });
    expect(describeFailure(null).kind).toBe("unknown");
    // Nothing was sent without credentials to sign with.
    expect(describeFailure(awsError("CredentialsProviderError")).kind).toBe("failed");
  });

  it("uses the explanation the CLI gives for known errors", () => {
    const p = describeFailure(awsError("AccessDeniedException", 400));
    expect(p).toEqual({ kind: "failed", message: "Access denied: AccessDeniedException message" });
  });
});

describe("parseDrafts", () => {
  it("round-trips every kind of draft through JSON", () => {
    const drafts: CommentDraft[] = [
      general(),
      inline(),
      { ...reply(), sent: OLD, problem: { kind: "unknown", message: "timeout" } },
    ];
    expect(parseDrafts(JSON.parse(JSON.stringify(drafts)))).toEqual(drafts);
  });

  it("drops entries that are not whole drafts", () => {
    const ok = general();
    const bad = [
      null,
      "x",
      { ...ok, id: "" },
      { ...ok, afterCommitId: 3 },
      { ...ok, target: { kind: "other" } },
      { ...ok, target: null },
      { ...ok, target: { kind: "inline", location: { filePath: "a", filePosition: 1.5 } } },
      { ...ok, target: { kind: "reply", inReplyTo: "c", replyTo: { author: 1, excerpt: "" } } },
      { ...ok, target: { kind: "reply", inReplyTo: "c" } },
      { ...ok, sent: { beforeCommitId: "a" } },
      { ...ok, problem: { kind: "lost", message: "m" } },
      { ...ok, problem: { kind: "failed" } },
    ];
    expect(parseDrafts([...bad, ok])).toEqual([ok]);
    expect(parseDrafts({ not: "a list" })).toEqual([]);
    expect(parseDrafts(undefined)).toEqual([]);
  });
});

describe("draftStorage", () => {
  it("keeps each PR's drafts under its region and reads back only whole drafts", async () => {
    const state = fakeState();
    const storage = draftStorage(state.drafts, "us-east-1");
    const d = general();
    await storage.save("7", [d]);
    expect([...state.draftLists.keys()]).toEqual(["us-east-1/7"]);
    expect(await storage.load("7")).toEqual([d]);
    state.draftLists.set("us-east-1/8", [{ broken: true }, d]);
    expect(await storage.load("8")).toEqual([d]);
    expect(await storage.load("9")).toEqual([]);
  });
});

const at = (relativeFileVersion: "BEFORE" | "AFTER", filePath = "a.ts", filePosition = 2) => ({
  filePath,
  filePosition,
  relativeFileVersion,
  lineText: "",
});

describe("lineReader", () => {
  const files = [
    { beforeBlob: { blobId: "b-old", path: "a.ts" }, afterBlob: { blobId: "b-new", path: "a.ts" } },
    { afterBlob: { blobId: "c-new", path: "c.ts" } },
  ];

  it("reads each side's line on the new tip, once per blob", async () => {
    const readBlob = vi.fn(async (id: string) => `${id} 1\n${id} 2\n`);
    const before = newDraft("x", { kind: "inline", location: at("BEFORE") }, OLD);
    const lineAt = await lineReader([inline(), inline(), before, general()], NEW, files, readBlob);
    expect(readBlob.mock.calls.map((c) => c[0]).toSorted()).toEqual(["b-new", "b-old"]);
    expect(lineAt(at("AFTER"))).toBe("b-new 2");
    expect(lineAt(at("BEFORE"))).toBe("b-old 2");
    expect(lineAt(at("AFTER", "a.ts", 9))).toBeUndefined();
  });

  it("reads nothing for drafts already on the tip, and a file the PR dropped as gone", async () => {
    const readBlob = vi.fn(async () => "");
    const lineAt = await lineReader(
      [newDraft("x", { kind: "general" }, NEW)],
      NEW,
      files,
      readBlob,
    );
    expect(readBlob).not.toHaveBeenCalled();
    expect(lineAt(at("AFTER", "gone.ts"))).toBeUndefined();
    expect(lineAt(at("AFTER", "c.ts", 1))).toBeUndefined();
  });
});

describe("draftKey", () => {
  it("puts the owning account before the PR id, from the author's ARN", () => {
    expect(draftKey({ pullRequestId: "5", authorArn: "arn:aws:iam::111122223333:user/a" })).toBe(
      "111122223333/5",
    );
    expect(
      draftKey({ pullRequestId: "5", authorArn: "arn:aws:sts::444455556666:assumed-role/R/s" }),
    ).toBe("444455556666/5");
    expect(draftKey({ pullRequestId: "5" })).toBe("unknown/5");
  });
});
