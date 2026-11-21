import type { ParseArgsConfig } from "node:util";

type Options = NonNullable<ParseArgsConfig["options"]>;

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

/** Flags whose value is one of a few words. Other string flags take free text. */
const FLAG_VALUES: Record<string, readonly string[]> = {
  state: ["open", "closed"],
  protocol: ["https", "ssh", "grc"],
};
const FILE_FLAGS = new Set(["body-file"]);
/** Commands whose positional argument is one of a few words. */
const POSITIONAL_VALUES: Record<string, readonly string[]> = { completion: SHELLS };

interface Flag {
  readonly long: string;
  readonly short?: string;
  readonly takesValue: boolean;
}

function flags(options: Options): Flag[] {
  return Object.entries(options).map(([long, o]) => ({
    long,
    ...(o.short ? { short: o.short } : {}),
    takesValue: o.type === "string",
  }));
}

/** Bare lazycc: --help and --version, and the flags of status, which it runs. */
function bareFlags(commands: Record<string, Options>): Flag[] {
  const top: Flag[] = [
    { long: "help", short: "h", takesValue: false },
    { long: "version", short: "v", takesValue: false },
  ];
  const own = flags(commands["status"] ?? {}).filter((f) => !top.some((t) => t.long === f.long));
  return [...top, ...own];
}

function nouns(commands: Record<string, Options>): string[] {
  return [...new Set(Object.keys(commands).map((c) => c.split(" ")[0] as string))];
}

/** Each noun that takes a verb (pr, issue), with its verbs. */
function groups(commands: Record<string, Options>): [string, string[]][] {
  const byNoun = new Map<string, string[]>();
  for (const c of Object.keys(commands)) {
    const [noun = "", verb] = c.split(" ");
    if (verb) byNoun.set(noun, [...(byNoun.get(noun) ?? []), verb]);
  }
  return [...byNoun];
}

/** Words never contain a quote: they are our own command and flag names. */
const words = (list: readonly string[]) => list.join(" ");

const spellings = (f: Flag) => [`--${f.long}`, ...(f.short ? [`-${f.short}`] : [])];

function bash(commands: Record<string, Options>): string {
  const all = Object.values(commands).flatMap(flags);
  const valueCases: string[] = [];
  const addCase = (pick: (f: Flag) => boolean, action: string) => {
    const pattern = [...new Set(all.filter(pick).flatMap(spellings))].join("|");
    if (pattern) valueCases.push(`    ${pattern}) ${action} ;;`);
  };
  for (const [long, values] of Object.entries(FLAG_VALUES)) {
    addCase(
      (f) => f.long === long,
      `COMPREPLY=($(compgen -W "${words(values)}" -- "$cur")); return`,
    );
  }
  addCase((f) => FILE_FLAGS.has(f.long), `COMPREPLY=($(compgen -f -- "$cur")); return`);
  // Free text: offer nothing rather than flags.
  addCase((f) => f.takesValue && !(f.long in FLAG_VALUES) && !FILE_FLAGS.has(f.long), "return");
  const commandCases = Object.entries(commands).map(([command, options]) => {
    const positional = POSITIONAL_VALUES[command];
    return `    "${command}") flags="${words(flags(options).flatMap(spellings))}"${positional ? `; values="${words(positional)}"` : ""} ;;`;
  });
  return `_lazycc() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" cmd flags="" values=""
  COMPREPLY=()
  if [[ $COMP_CWORD -eq 1 && $cur != -* ]]; then
    COMPREPLY=($(compgen -W "${words([...nouns(commands), "--help", "--version"])}" -- "$cur"))
    return
  fi
  cmd="\${COMP_WORDS[1]}"
  if [[ $COMP_CWORD -eq 1 || $cmd == -* ]]; then
    cmd=""
    flags="${words(bareFlags(commands).flatMap(spellings))}"
${groups(commands)
  .map(
    ([noun, verbs]) => `  elif [[ $cmd == ${noun} ]]; then
    if [[ $COMP_CWORD -eq 2 ]]; then
      COMPREPLY=($(compgen -W "${words(verbs)}" -- "$cur"))
      return
    fi
    cmd="${noun} \${COMP_WORDS[2]}"`,
  )
  .join("\n")}
  fi
  case "$prev" in
${valueCases.join("\n")}
  esac
  case "$cmd" in
${commandCases.join("\n")}
  esac
  if [[ $cur == -* ]]; then
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$values" -- "$cur"))
  fi
}
complete -F _lazycc lazycc lazycodecommit
`;
}

function fishFlag(f: Flag): string {
  const short = f.short ? ` -s ${f.short}` : "";
  const values = FLAG_VALUES[f.long];
  const value = !f.takesValue
    ? ""
    : FILE_FLAGS.has(f.long)
      ? " -r -F"
      : values
        ? ` -x -a '${words(values)}'`
        : " -x";
  return `-l ${f.long}${short}${value}`;
}

const c = (condition: string, rest: string) => `complete -c lazycc -n '${condition}' ${rest}`;

function fish(commands: Record<string, Options>): string {
  const lines = [
    "complete -c lazycc -f",
    c("__fish_use_subcommand", `-a '${words(nouns(commands))}'`),
    ...bareFlags(commands).map((f) => c("__fish_use_subcommand", fishFlag(f))),
    ...groups(commands).map(([noun, verbs]) =>
      c(
        `__fish_seen_subcommand_from ${noun}; and not __fish_seen_subcommand_from ${words(verbs)}`,
        `-a '${words(verbs)}'`,
      ),
    ),
  ];
  for (const [command, options] of Object.entries(commands)) {
    const [noun, verb] = command.split(" ");
    const condition = verb
      ? `__fish_seen_subcommand_from ${noun}; and __fish_seen_subcommand_from ${verb}`
      : `__fish_seen_subcommand_from ${noun}`;
    const positional = POSITIONAL_VALUES[command];
    if (positional) lines.push(c(condition, `-a '${words(positional)}'`));
    for (const f of flags(options)) lines.push(c(condition, fishFlag(f)));
  }
  lines.push("complete -c lazycodecommit -w lazycc");
  return `${lines.join("\n")}\n`;
}

/** The completion script for `shell`, built from the same table the parser uses. */
export function completionScript(shell: Shell, commands: Record<string, Options>): string {
  if (shell === "fish") return fish(commands);
  const script = bash(commands);
  return shell === "zsh" ? `autoload -U +X bashcompinit && bashcompinit\n${script}` : script;
}
