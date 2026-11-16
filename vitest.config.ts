import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// FC_RUNS_SCALE=10 bun run test runs every property ten times as often as CI does:
// "fast-check" then resolves to a wrapper that scales numRuns (docs/dev/ci.md).
const fcScale = Number(process.env["FC_RUNS_SCALE"] ?? "1");
const scaled = fcScale !== 1;
const wrapper = fileURLToPath(new URL("./src/testing/fast-check-scaled.ts", import.meta.url));

export default defineConfig({
  plugins: scaled
    ? [
        {
          name: "fast-check-scaled",
          enforce: "pre",
          resolveId(id, importer) {
            return id === "fast-check" && importer !== wrapper ? wrapper : null;
          },
        },
      ]
    : [],
  test: {
    ...(scaled ? { testTimeout: 5000 * fcScale, hookTimeout: 10000 * fcScale } : {}),
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/testing/vitest-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // The entry point only wires process.argv to run(); pack-smoke runs it.
      exclude: ["src/**/*.test.{ts,tsx}", "src/cli.ts", "src/testing/**"],
      // 95% over all files, and no single file below 80% (the aggregate hid a
      // screen at 83% of branches).
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
        perFile: { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
      reporter: ["text", "lcov"],
    },
  },
});
