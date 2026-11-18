import { describe, expect, it } from "vitest";
import type { FolderEntry } from "../aws/codecommit.js";
import { fakeApi } from "../testing/fakes.js";
import { browseActions, browseConsoleUrl, isBinary, normalizePath, openPath } from "./browse.js";

const ctx = { repository: "demo" };
const tree: Record<string, FolderEntry[]> = {
  "": [
    { name: "src", path: "src", type: "folder" },
    { name: "README.md", path: "README.md", type: "file" },
    { name: "vendor", path: "vendor", type: "submodule" },
    { name: ".github", path: ".github", type: "folder" },
    { name: "LICENSE", path: "LICENSE", type: "file" },
  ],
  src: [{ name: "a.ts", path: "src/a.ts", type: "file" }],
};
const files: Record<string, Uint8Array> = {
  "README.md": Buffer.from("# demo\n"),
  "bom.txt": Buffer.from("\ufeffhi"),
  "logo.png": Buffer.from([0x89, 0x50, 0x00, 0x01]),
};

function deps(over: Parameters<typeof fakeApi>[1] = {}) {
  const calls: string[] = [];
  const api = fakeApi([], {
    getFolder: async (_r, ref, path) => {
      calls.push(`folder ${ref} ${path}`);
      return tree[path];
    },
    getFile: async (_r, ref, path) => {
      calls.push(`file ${ref} ${path}`);
      return files[path];
    },
    ...over,
  });
  return { api, ctx, calls };
}

describe("normalizePath", () => {
  it.each([
    ["", ""],
    ["/", ""],
    ["src/", "src"],
    ["/src//lib/", "src/lib"],
    ["./src/./a.ts", "src/a.ts"],
  ])("%j → %j", (input, out) => {
    expect(normalizePath(input)).toBe(out);
  });

  it("refuses to climb out of the root", () => {
    expect(() => normalizePath("src/../..")).toThrow("Not a path in the repository: src/../..");
  });
});

describe("isBinary", () => {
  it("spots a NUL byte near the start, as git does", () => {
    expect(isBinary(Buffer.from("text"))).toBe(false);
    expect(isBinary(Buffer.from([0x41, 0x00]))).toBe(true);
    expect(isBinary(Buffer.concat([Buffer.alloc(8000, 0x41), Buffer.from([0])]))).toBe(false);
  });
});

describe("openPath", () => {
  it("lists a folder, folders first, then by name", async () => {
    const d = deps();
    const node = await openPath("main", "", d);
    expect(node).toEqual({
      kind: "folder",
      ref: "main",
      path: "",
      entries: [
        { name: ".github", path: ".github", type: "folder" },
        { name: "src", path: "src", type: "folder" },
        { name: "LICENSE", path: "LICENSE", type: "file" },
        { name: "README.md", path: "README.md", type: "file" },
        { name: "vendor", path: "vendor", type: "submodule" },
      ],
    });
  });

  it("sorts names that come in reverse order", async () => {
    const names = ["e", "d", "c", "b", "a"];
    const d = deps({
      getFolder: async () => names.map((name) => ({ name, path: name, type: "file" as const })),
    });
    const node = await openPath("main", "", d);
    expect(node.kind === "folder" && node.entries.map((e) => e.name)).toEqual(names.toSorted());
  });

  it("does not try a file at the root of an empty repository", async () => {
    const d = deps({ getFolder: async () => undefined });
    await expect(openPath("main", "", d)).rejects.toThrow("demo has no folder  at main.");
    expect(d.calls).toEqual([]);
  });

  it("falls back to the file when the path is not a folder", async () => {
    const d = deps();
    expect(await openPath("main", "README.md", d)).toEqual({
      kind: "file",
      ref: "main",
      path: "README.md",
      size: 7,
      text: "# demo\n",
    });
    expect(d.calls).toEqual(["folder main README.md", "file main README.md"]);
  });

  it("does not try a file for a path ending in /", async () => {
    const d = deps();
    await expect(openPath("main", "README.md/", d)).rejects.toThrow(
      "demo has no folder README.md at main.",
    );
    expect(d.calls).toEqual(["folder main README.md"]);
  });

  it("keeps a byte order mark", async () => {
    expect(await openPath("main", "bom.txt", deps())).toMatchObject({ text: "\ufeffhi" });
  });

  it("marks a binary file instead of decoding it", async () => {
    expect(await openPath("main", "logo.png", deps())).toEqual({
      kind: "file",
      ref: "main",
      path: "logo.png",
      size: 4,
      binary: true,
    });
  });

  it("says when nothing is at the path", async () => {
    await expect(openPath("main", "nope", deps())).rejects.toThrow(
      "demo has no file or folder nope at main.",
    );
  });

  it("marks a file over the API's limit", async () => {
    const d = deps({
      getFolder: async () => undefined,
      getFile: async () => {
        throw Object.assign(new Error("big"), { name: "FileTooLargeException" });
      },
    });
    expect(await openPath("main", "big.bin", d)).toEqual({
      kind: "file",
      ref: "main",
      path: "big.bin",
      tooLarge: true,
    });
  });

  it("passes on another error from reading the file", async () => {
    const d = deps({
      getFolder: async () => undefined,
      getFile: async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      },
    });
    await expect(openPath("main", "a.bin", d)).rejects.toThrow("denied");
  });

  it.each(["CommitDoesNotExistException", "InvalidCommitException"])(
    "names a ref that does not exist (%s)",
    async (name) => {
      const d = deps({
        getFolder: async () => {
          throw Object.assign(new Error("x"), { name });
        },
      });
      await expect(openPath("nope", "", d)).rejects.toThrow(
        "demo has no branch or commit named nope.",
      );
    },
  );

  it("asks for the full id when CodeCommit refuses an abbreviated one", async () => {
    const d = deps({
      getFolder: async () => {
        throw Object.assign(new Error("x"), { name: "CommitDoesNotExistException" });
      },
    });
    await expect(openPath("fc9417b", "", d)).rejects.toThrow(
      "demo has no commit fc9417b. CodeCommit takes only full 40-character commit IDs.",
    );
    await expect(openPath("fc9417b0", "", d)).rejects.toThrow("takes only full 40-character");
    await expect(openPath("f".repeat(40), "", d)).rejects.toThrow(
      `demo has no branch or commit named ${"f".repeat(40)}.`,
    );
  });

  it("passes other errors through", async () => {
    const d = deps({
      getFolder: async () => {
        throw new Error("boom");
      },
    });
    await expect(openPath("main", "", d)).rejects.toThrow("boom");
  });
});

describe("browseConsoleUrl", () => {
  it("points at a branch or a commit, encoding each segment", () => {
    expect(browseConsoleUrl("us-east-1", "demo", "feature/x", "src/a b.ts")).toBe(
      "https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/demo/browse/refs/heads/feature/x/--/src/a%20b.ts?region=us-east-1",
    );
    expect(browseConsoleUrl("us-east-1", "demo", "ABC1234", "")).toContain("/browse/ABC1234/--/");
    expect(browseConsoleUrl("us-east-1", "demo", "abc1234-fix", "")).toContain(
      "/browse/refs/heads/abc1234-fix/--/",
    );
    expect(browseConsoleUrl("us-east-1", "demo", "fix-abc1234", "")).toContain(
      "/browse/refs/heads/fix-abc1234/--/",
    );
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(browseConsoleUrl("us-east-1", "demo", commit, "")).toBe(
      `https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/demo/browse/${commit}/--/?region=us-east-1`,
    );
  });
});

describe("browseActions", () => {
  it("binds the repository, the default branch and the region", async () => {
    const d = deps({ listBranches: async () => ["main", "dev"] });
    const actions = await browseActions(d, "us-east-1");
    expect(actions.repository).toBe("demo");
    expect(actions.startRef).toBe("main");
    expect(await actions.branches()).toEqual(["dev", "main"]);
    expect((await actions.open("main", "src")).kind).toBe("folder");
    expect(actions.consoleUrl("main", "src")).toContain("/browse/refs/heads/main/--/src?");
  });

  it("refuses an empty repository", async () => {
    const d = deps({ defaultBranch: async () => undefined });
    await expect(browseActions(d, "us-east-1")).rejects.toThrow(
      "demo has no default branch yet (is it empty?). Pass --ref.",
    );
  });

  it("skips the default branch lookup when a ref is given", async () => {
    let asked = false;
    const d = deps({
      defaultBranch: async () => {
        asked = true;
        return "main";
      },
    });
    expect((await browseActions(d, "us-east-1", "dev")).startRef).toBe("dev");
    expect(asked).toBe(false);
  });
});
