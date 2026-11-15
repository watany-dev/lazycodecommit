import { describe, expect, it } from "vitest";
import { version } from "../package.json" with { type: "json" };
import { run } from "./run.js";

function capture(args: string[]) {
  const lines: string[] = [];
  const code = run(args, (line) => lines.push(line));
  return { code, lines };
}

describe("run", () => {
  it.each([["--version"], ["-v"]])("prints the version for %s", (flag) => {
    expect(capture([flag])).toEqual({ code: 0, lines: [version] });
  });

  it.each([[[]], [["--help"]], [["-h"]]])("prints usage and succeeds for %j", (args) => {
    expect(capture(args)).toEqual({ code: 0, lines: ["usage: lazycc [--version]"] });
  });

  it("fails on an unknown argument", () => {
    expect(capture(["nope"])).toEqual({ code: 1, lines: ["usage: lazycc [--version]"] });
  });
});
