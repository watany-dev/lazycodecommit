import { readdirSync, readFileSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

// Bundled packages that publish no license file. The text comes from the
// package's source headers and its license field.
const MISSING_LICENSE_FILES: Record<string, string> = {
  "yoga-layout": `MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
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
  metafile: true,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await chmod("./dist/cli.mjs", 0o755);
await writeFile(
  "./dist/THIRD_PARTY_LICENSES.txt",
  thirdPartyLicenses(Object.keys(result.metafile?.inputs ?? {})),
);
for (const output of result.outputs) {
  console.log(`  ${output.path}  ${(output.size / 1024).toFixed(1)} KB`);
}

// Every dependency is bundled and minified, which drops the license headers, so
// the notices the MIT, ISC and Apache-2.0 licenses ask for ship in this file.
function thirdPartyLicenses(inputs: string[]): string {
  const dirs = new Set<string>();
  for (const input of inputs) {
    const last = [...input.matchAll(/node_modules\/(?:@[^/]+\/)?[^/]+/g)].pop();
    if (last) dirs.add(input.slice(0, last.index + last[0].length));
  }
  const packages = [...dirs].map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      license?: string;
    };
    const files = readdirSync(dir)
      .filter((f) => /^(licen[cs]e|notice|copying)/i.test(f))
      .toSorted();
    const text = files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
    return {
      head: `${pkg.name}@${pkg.version} (${pkg.license ?? "no license field"})`,
      ...pkg,
      text,
    };
  });
  packages.sort((a, b) => a.head.localeCompare(b.head));
  // Identical texts (the AWS SDK's Apache-2.0 files) are written once.
  const firstWith = new Map<string, string>();
  const apache = packages.find((p) => p.license === "Apache-2.0" && p.text);
  const missing: string[] = [];
  const sections = packages.map((pkg) => {
    let body = pkg.text || MISSING_LICENSE_FILES[pkg.name] || "";
    if (!body && pkg.license === "Apache-2.0" && apache) body = `Same text as ${apache.head}.`;
    else if (firstWith.has(body)) body = `Same text as ${firstWith.get(body)}.`;
    else if (body) firstWith.set(body, pkg.head);
    if (!body) missing.push(pkg.head);
    return `${pkg.head}\n${"-".repeat(pkg.head.length)}\n\n${body}`;
  });
  if (missing.length > 0) {
    console.error(
      "build: no license text for these bundled packages; add it to MISSING_LICENSE_FILES:\n  %s",
      missing.join("\n  "),
    );
    process.exit(1);
  }
  return `lazycodecommit bundles the following packages.\n\n${sections.join("\n\n\n")}\n`;
}
