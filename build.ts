import { chmod, rm } from "node:fs/promises";

// Ink imports react-devtools-core only when DEV is set; leave it out of the bundle.
const stubDevtools = {
  name: "stub-devtools",
  setup(build: Bun.PluginBuilder) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

await rm("./dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  outdir: "./dist",
  naming: { entry: "cli.mjs", chunk: "[name]-[hash].mjs" },
  format: "esm",
  // The package runs on the Node.js that CloudShell ships; Bun is only a dev tool.
  target: "node",
  minify: true,
  // Dynamic imports become their own files, so a CLI subcommand never parses
  // the TUI (Ink, React) or, until it calls AWS, the SDK.
  splitting: true,
  plugins: [stubDevtools],
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
