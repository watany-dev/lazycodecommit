import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { completionScript } from "./completion.js";

const commands = {
  "pr list": { state: { type: "string", short: "s" }, json: { type: "boolean" } },
  "pr comment": { "body-file": { type: "string", short: "F" } },
  // Bare lazycc takes status's flags.
  status: {
    help: { type: "boolean", short: "h" },
    repo: { type: "string", short: "R" },
    json: { type: "boolean" },
  },
  clone: { protocol: { type: "string" } },
  completion: { title: { type: "string" } },
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
    expect(bash("lazycc ")).toEqual(["pr", "status", "clone", "completion", "--help", "--version"]);
    expect(bash("lazycc c")).toEqual(["clone", "completion"]);
    expect(bash("lazycc pr ")).toEqual(["list", "comment"]);
  });

  it("offers bare lazycc's flags, which are status's", () => {
    expect(bash("lazycc --")).toEqual(["--help", "--version", "--repo", "--json"]);
    expect(bash("lazycc -")).toEqual(["--help", "-h", "--version", "-v", "--repo", "-R", "--json"]);
    expect(bash("lazycc --json --r")).toEqual(["--repo"]);
    expect(bash("lazycc -R ")).toEqual([]);
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
    expect(bash("lazycc completion --title ")).toEqual([]);
  });
});

describe("several nouns with verbs", () => {
  const table = {
    "pr list": {},
    "issue list": {},
    "issue close": { json: { type: "boolean" } },
  } as const;

  it("offers each noun's own verbs in bash", () => {
    const script = completionScript("bash", table);
    const offer = (line: string) => {
      const words = line.split(" ");
      const r = spawnSync(
        "bash",
        [
          "--norc",
          "-c",
          `${script}\nCOMP_WORDS=(${words.map((w) => `'${w}'`).join(" ")}); COMP_CWORD=${words.length - 1}\n_lazycc; printf '%s\\n' "\${COMPREPLY[@]}"`,
        ],
        { encoding: "utf8" },
      );
      return r.stdout.split("\n").filter(Boolean);
    };
    expect(offer("lazycc ")).toEqual(["pr", "issue", "--help", "--version"]);
    expect(offer("lazycc issue ")).toEqual(["list", "close"]);
    expect(offer("lazycc pr ")).toEqual(["list"]);
    expect(offer("lazycc issue close --")).toEqual(["--json"]);
  });

  it("offers each noun's own verbs in fish", () => {
    expect(completionScript("fish", table)).toContain(
      "complete -c lazycc -n '__fish_seen_subcommand_from issue; and not __fish_seen_subcommand_from list close' -a 'list close'",
    );
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
      "complete -c lazycc -n '__fish_use_subcommand' -a 'pr status clone completion'",
    );
    for (const flag of ["-l help -s h", "-l version -s v", "-l repo -s R -x", "-l json"])
      expect(fish).toContain(`complete -c lazycc -n '__fish_use_subcommand' ${flag}\n`);
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
    expect(fish.split("\n")[0]).toBe("complete -c lazycc -f");
    expect(fish).toContain(
      "complete -c lazycc -n '__fish_seen_subcommand_from status' -l repo -s R -x\n",
    );
    expect(fish).toContain(
      "complete -c lazycc -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'\n",
    );
  });
});
