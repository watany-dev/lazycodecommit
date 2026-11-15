import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
