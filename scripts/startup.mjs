// Cold-start gate: the spec targets 300 ms for a CLI subcommand, excluding API
// waits. Runs the built bin under the current Node.js and fails when the
// median wall time of RUNS starts exceeds the budget. First it checks the other
// half of that requirement: the files a subcommand loads up front (the entry
// and its static imports) contain neither Ink nor React, which only the TUI's
// dynamic import may pull in, nor the AWS SDK, which commands load when they
// first call AWS (not for --version or a usage error).
// Usage: node scripts/startup.mjs [path/to/cli.mjs]   (default: dist/cli.mjs)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const BUDGET_MS = 300;
const RUNS = 15;
const bin = process.argv[2] ?? fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

const LAZY_MARKERS = {
  React: 'Symbol.for("react.',
  Ink: '"ink-root"',
  "the AWS SDK": '"CodeCommit_20150413"',
  "the CodeBuild client": '"CodeBuild_20161006"',
  "the CodePipeline client": '"CodePipeline_20150709"',
};
const seen = new Set();
const pending = [bin];
while (pending.length > 0) {
  const file = pending.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const code = readFileSync(file, "utf8");
  for (const [what, marker] of Object.entries(LAZY_MARKERS)) {
    if (code.includes(marker)) {
      console.error("startup: %s is loaded by every command but contains %s", file, what);
      process.exit(1);
    }
  }
  // Static imports only (`from"./x.mjs"`, `import"./x.mjs"`); `import("./x.mjs")` is lazy.
  for (const [, spec] of code.matchAll(/(?:from|import)\s*["'](\.\/[^"']+)["']/g)) {
    pending.push(join(dirname(file), spec));
  }
}

const times = [];
for (let i = 0; i < RUNS; i++) {
  const start = performance.now();
  const r = spawnSync(process.execPath, [bin, "--version"], { stdio: "ignore" });
  times.push(performance.now() - start);
  if (r.status !== 0) {
    console.error(
      "startup: %s --version failed: %s",
      bin,
      r.error ?? r.signal ?? `exit ${r.status}`,
    );
    process.exit(1);
  }
}
times.sort((a, b) => a - b);
const median = times[Math.floor(RUNS / 2)];
console.log(
  `startup: median ${median.toFixed(1)} ms over ${RUNS} runs (budget ${BUDGET_MS} ms, ${process.version}); ${seen.size} file(s) loaded up front, none with Ink, React or the SDK`,
);
if (median > BUDGET_MS) process.exit(1);
