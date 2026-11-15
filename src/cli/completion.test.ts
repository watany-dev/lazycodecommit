import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { completionScript } from "./completion.js";

const commands = {
  "pr list": { state: { type: "string", short: "s" }, json: { type: "boolean" } },
  "pr comment": { "body-file": { type: "string", short: "F" } },
  clone: { protocol: { type: "string" } },
  completion: {},
} as const;

/** What bash offers for `line` (the cursor at its end), using the generated script. */
function bash(line: string): string[] {
  const words = line.split(" ");
  const script = `${completionScript("bash", commands)}
COMP_WORDS=(${words.map((w) => `'${w}'`).join(" ")}); COMP_CWORD=${words.length - 1}
_lazycc; printf '%s\\n' "\${COMPREPLY[@]}"`;
  const r = spawnSync("bash", ["--norc", "-c", script], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  return r.stdout.split("\n").filter(Boolean);
}

describe("bash completion", () => {
  it("offers nouns, then pr verbs", () => {
    expect(bash("lazycc ")).toEqual(["pr", "clone", "completion", "--help", "--version"]);
    expect(bash("lazycc c")).toEqual(["clone", "completion"]);
    expect(bash("lazycc pr ")).toEqual(["list", "comment"]);
  });

  it("offers a command's flags, long and short", () => {
    expect(bash("lazycc pr list --")).toEqual(["--state", "--json"]);
    expect(bash("lazycc pr list -")).toEqual(["--state", "-s", "--json"]);
  });

  it("offers known values, files for a file flag, and nothing for free text", () => {
    expect(bash("lazycc pr list --state ")).toEqual(["open", "closed"]);
    expect(bash("lazycc pr list -s c")).toEqual(["closed"]);
    expect(bash("lazycc clone x --protocol ")).toEqual(["https", "ssh", "grc"]);
    expect(bash("lazycc completion ")).toEqual(["bash", "zsh", "fish"]);
    expect(bash("lazycc pr comment -F package.j")).toEqual(["package.json"]);
    expect(bash("lazycc pr bogus -")).toEqual([]);
  });
});

describe("other shells", () => {
  it("lets zsh reuse the bash function through bashcompinit", () => {
    const zsh = completionScript("zsh", commands);
    expect(zsh).toContain("bashcompinit");
    expect(zsh).toContain(completionScript("bash", commands));
  });

  it("describes every command, flag and value to fish", () => {
    const fish = completionScript("fish", commands);
    expect(fish).toContain(
      "complete -c lazycc -n '__fish_use_subcommand' -a 'pr clone completion'",
    );
    expect(fish).toContain(
      "complete -c lazycc -n '__fish_seen_subcommand_from pr; and not __fish_seen_subcommand_from list comment' -a 'list comment'",
    );
    expect(fish).toContain(
      "complete -c lazycc -n '__fish_seen_subcommand_from pr; and __fish_seen_subcommand_from list' -l state -s s -x -a 'open closed'",
    );
    expect(fish).toContain(
      "complete -c lazycc -n '__fish_seen_subcommand_from pr; and __fish_seen_subcommand_from comment' -l body-file -s F -r -F",
    );
    expect(fish).toContain("complete -c lazycodecommit -w lazycc");
  });
});
