import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The entry point only wires process.argv to run(); pack-smoke runs it.
      exclude: ["src/**/*.test.ts", "src/cli.ts", "src/testing/**"],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
      reporter: ["text", "lcov"],
    },
  },
});
