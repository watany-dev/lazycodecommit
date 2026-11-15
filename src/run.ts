import { version } from "../package.json" with { type: "json" };

export function run(args: readonly string[], print: (line: string) => void): number {
  if (args[0] === "--version" || args[0] === "-v") {
    print(version);
    return 0;
  }
  print("usage: lazycc [--version]");
  return args.length === 0 || args[0] === "--help" || args[0] === "-h" ? 0 : 1;
}
