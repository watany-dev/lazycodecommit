import { posix } from "node:path";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { browseConsoleUrl, normalizePath } from "./browse.js";
import { UsageError } from "./errors.js";

// Names as git allows them in a tree: anything but "/" and NUL, with dots and spaces likely.
const name = fc.oneof(
  fc.constantFrom(".", "..", "", "src", "a b", "%41", "#x", "?q", "日本", "😀", ".env", "+", "&"),
  fc.string({ minLength: 1, maxLength: 6 }).filter((s) => !s.includes("/") && !s.includes("\0")),
);
const path = fc.array(name, { maxLength: 6 }).map((parts) => parts.join("/"));

describe("normalizePath, for any path typed with --path or opened on screen", () => {
  it("is what POSIX normalization makes of it inside the repository, or a UsageError", () => {
    fc.assert(
      fc.property(path, (p) => {
        const expected = posix.normalize(`/${p}`).replace(/^\/+|\/+$/g, "");
        // Climbing out of the root is the only refusal; posix.normalize("/..") stays at "/".
        let depth = 0;
        let escapes = false;
        for (const part of p.split("/")) {
          if (part === "" || part === ".") continue;
          depth += part === ".." ? -1 : 1;
          if (depth < 0) escapes = true;
        }
        if (escapes) expect(() => normalizePath(p)).toThrow(UsageError);
        else expect(normalizePath(p)).toBe(expected);
      }),
      { numRuns: 2000 },
    );
  });

  it("is idempotent and leaves no empty, . or .. segment", () => {
    fc.assert(
      fc.property(path, (p) => {
        let once: string;
        try {
          once = normalizePath(p);
        } catch {
          return;
        }
        expect(normalizePath(once)).toBe(once);
        if (once !== "") {
          for (const part of once.split("/")) expect(["", ".", ".."]).not.toContain(part);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

// git check-ref-format: no component starting with "." or ending in ".lock", no "..",
// no control characters, space, ~ ^ : ? * [ \\, no "@{", not ending in "/" or ".".
const validRef = (r: string) =>
  !r.split("/").some((c) => c === "" || c.startsWith(".") || c.endsWith(".lock")) &&
  !r.includes("..") &&
  !r.includes("@{") &&
  !r.endsWith(".") &&
  r !== "@" &&
  // oxlint-disable-next-line no-control-regex -- finding them is the point
  !/[\x00-\x20\x7f~^:?*[\\]/.test(r);

describe("browseConsoleUrl", () => {
  const branch = fc
    .oneof(
      fc.constantFrom("main", "feature/x", "a%2Fb", "v1.0#rc", "日本語", "deadbee", "a&b=c"),
      fc.string({ minLength: 1, maxLength: 12 }),
    )
    .filter(validRef)
    // The console splits browse/<ref>/--/<path> at "/--/"; a ref with a "--" component is
    // ambiguous there, and how the console reads it is not known.
    .filter((r) => !r.split("/").includes("--"));

  it("names the same ref and path the console will decode, whatever they hold", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("us-east-1", "cn-north-1", "us-gov-west-1"),
        fc.constantFrom("demo", "my repo", "a#b"),
        branch,
        path.map((p) => {
          try {
            return normalizePath(p);
          } catch {
            return "";
          }
        }),
        (region, repo, ref, p) => {
          const url = new URL(browseConsoleUrl(region, repo, ref, p));
          // Only ?region=: nothing in the ref or the path leaked into the query or a fragment.
          expect([...url.searchParams.keys()]).toEqual(["region"]);
          expect(url.searchParams.get("region")).toBe(region);
          expect(url.hash).toBe("");
          const [, repoPart, browse] =
            /^\/codesuite\/codecommit\/repositories\/([^/]*)\/browse\/(.*)$/.exec(url.pathname) ??
            [];
          expect(decodeURIComponent(repoPart ?? "")).toBe(repo);
          const cut = (browse ?? "").indexOf("/--/");
          const [at, file] = [browse?.slice(0, cut), browse?.slice(cut + 4)];
          const decodedAt = (at ?? "").split("/").map(decodeURIComponent).join("/");
          expect(decodedAt === ref || decodedAt === `refs/heads/${ref}`).toBe(true);
          expect((file ?? "").split("/").map(decodeURIComponent).join("/")).toBe(p);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
