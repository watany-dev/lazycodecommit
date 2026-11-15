import { chmod } from "node:fs/promises";

const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  outdir: "./dist",
  naming: "cli.mjs",
  format: "esm",
  // The package runs on the Node.js that CloudShell ships; Bun is only a dev tool.
  target: "node",
  minify: true,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await chmod("./dist/cli.mjs", 0o755);
for (const output of result.outputs) {
  console.log(`  ${output.path}  ${(output.size / 1024).toFixed(1)} KB`);
}
