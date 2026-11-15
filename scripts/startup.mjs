// Cold-start gate: the spec targets 300 ms for a CLI subcommand, excluding API
// waits. Runs the built bin under the current Node.js and fails when the
// median wall time of RUNS starts exceeds the budget.
// Usage: node scripts/startup.mjs [path/to/cli.mjs]   (default: dist/cli.mjs)
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const BUDGET_MS = 300;
const RUNS = 15;
const bin = process.argv[2] ?? fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

const times = [];
for (let i = 0; i < RUNS; i++) {
  const start = performance.now();
  const r = spawnSync(process.execPath, [bin, "--version"], { stdio: "ignore" });
  times.push(performance.now() - start);
  if (r.status !== 0) {
    console.error(`startup: ${bin} --version failed:`, r.error ?? r.signal ?? `exit ${r.status}`);
    process.exit(1);
  }
}
times.sort((a, b) => a - b);
const median = times[Math.floor(RUNS / 2)];
console.log(
  `startup: median ${median.toFixed(1)} ms over ${RUNS} runs (budget ${BUDGET_MS} ms, ${process.version})`,
);
if (median > BUDGET_MS) process.exit(1);
