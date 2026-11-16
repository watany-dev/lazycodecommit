import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fakeApi, fakeGit, fakeState, pullRequest } from "../testing/fakes.js";
import { type Deps, run } from "./main.js";

const prs = [
  pullRequest({ id: "1" }),
  pullRequest({ id: "2", title: "Closed one", status: "CLOSED" }),
  pullRequest({ id: "3", title: "\u001b]52;c;aGk=\u0007 hostile", description: "\u009b2J" }),
];

function deps(interactive: boolean, out: string[], err: string[]): Deps {
  return {
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: {},
      cwd: "/work",
      interactive,
      confirm: async () => true,
      edit: async (t) => t,
      readFile: async (path) => (path === "body.md" ? "From a file" : null),
      readStdin: async () => "From stdin",
    },
    createGit: () => fakeGit(),
    createApi: async () => fakeApi(prs),
    createCiApi: async () => ({ recentBuilds: async () => [], recentExecutions: async () => [] }),
    loadConfig: async () => ({}),
    createState: () => fakeState(),
    openReview: async () => {},
    openTop: async () => {},
  };
}

const words = fc.constantFrom(
  "pr",
  "create",
  "list",
  "view",
  "status",
  "checkout",
  "comment",
  "approve",
  "merge",
  "close",
  "branch",
  "browse",
  "clone",
  "completion",
  "bash",
  "zsh",
  "fish",
  "home",
  "help",
  "1",
  "2",
  "3",
  "999",
  "0",
  "-1",
  "abc",
  "",
  "--",
  "-",
  "--json",
  "--help",
  "-h",
  "--version",
  "-v",
  "-R",
  "--repo",
  "demo",
  "--profile",
  "--region",
  "us-west-2",
  "--state",
  "open",
  "closed",
  "merged",
  "-L",
  "--limit",
  "5",
  "x",
  "-B",
  "-H",
  "-t",
  "-b",
  "-F",
  "body.md",
  "--fill",
  "--push",
  "--no-push",
  "--dry-run",
  "--revoke",
  "--ff",
  "--squash",
  "--three-way",
  "--ref",
  "--path",
  "src/",
  "../..",
  "--protocol",
  "ssh",
  "grc",
  "https",
  "--repo=",
  "--state=open",
  "-L0",
  "-L=3",
);

// Bugs in lazycc show up as a JavaScript error reaching the user; bad input is a UsageError (2).
const INTERNAL = /\b(TypeError|RangeError|ReferenceError|SyntaxError)\b|undefined|\[object /;

describe("run, for any command line", () => {
  it("settles with 0, 1 or 2, keeps control characters off the terminal, and never leaks an internal error", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof({ weight: 6, arbitrary: words }, { weight: 1, arbitrary: fc.string() }), {
          maxLength: 7,
        }),
        fc.boolean(),
        async (args, interactive) => {
          const out: string[] = [];
          const err: string[] = [];
          const code = await run(args, deps(interactive, out, err));
          expect([0, 1, 2]).toContain(code);
          for (const line of [...out, ...err]) {
            // oxlint-disable-next-line no-control-regex -- finding them is the point
            expect(line).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
          }
          if (code !== 0) expect(err.join("\n")).not.toMatch(INTERNAL);
          // Bare `lazycc pr` prints the usage itself; any other bad input says what was wrong.
          if (code === 2 && args.join(" ") !== "pr")
            expect(err.at(-1)).toBe("Run `lazycc --help` for usage.");
        },
      ),
      { numRuns: 500 },
    );
  });
});
