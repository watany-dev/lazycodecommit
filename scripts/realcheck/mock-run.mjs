#!/usr/bin/env node
// Runs realcheck.mjs end to end against mock-server.mjs, so the script can be
// tried without AWS. Every check should pass: the mock answers the way lazycc
// assumes CodeCommit does. Usage: node scripts/realcheck/mock-run.mjs [--out report.md]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startMockServer } from "./mock-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" } } });
const dir = mkdtempSync(join(tmpdir(), "lazycc-realcheck-mock-"));
const out = resolve(values.out ?? join(dir, "report.md"));
const server = await startMockServer(join(dir, "git"));

// Static keys per profile; the mock tells callers apart by access key id. The SSO
// profile points at a session with no cached token, as after `aws sso logout`.
writeFileSync(
  join(dir, "credentials"),
  ["rc-main:AKIDMAIN", "rc-other:AKIDOTHER", "rc-limited:AKIDLIMITED"]
    .map((p) => p.split(":"))
    .map(([name, key]) => `[${name}]\naws_access_key_id = ${key}\naws_secret_access_key = mock\n`)
    .join("\n"),
);
writeFileSync(
  join(dir, "config"),
  [
    "[profile rc-sso]",
    "sso_session = realcheck-mock",
    "sso_account_id = 123456789012",
    "sso_role_name = Dev",
    "region = us-east-1",
    "[sso-session realcheck-mock]",
    "sso_start_url = https://realcheck-mock.awsapps.com/start",
    "sso_region = us-east-1",
    "",
  ].join("\n"),
);

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("AWS_")) delete env[k];
Object.assign(env, {
  AWS_ENDPOINT_URL_CODECOMMIT: server.url,
  AWS_ENDPOINT_URL_STS: server.url,
  AWS_ENDPOINT_URL_CODEBUILD: server.url,
  AWS_ENDPOINT_URL_CODEPIPELINE: server.url,
  AWS_CONFIG_FILE: join(dir, "config"),
  AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
});

const args = [
  join(here, "realcheck.mjs"),
  "--region",
  "us-east-1",
  "--profile",
  "rc-main",
  "--other-profile",
  "rc-other",
  "--limited-profile",
  "rc-limited",
  "--sso-expired-profile",
  "rc-sso",
  "--ci-project",
  "rc-check",
  "--ci-pipeline",
  "rc-release",
  "--ssh",
  "--yes",
  "--mock-git-root",
  join(dir, "git"),
  "--out",
  out,
];
const code = await new Promise((r) => {
  spawn(process.execPath, args, { env, stdio: "inherit" }).on("exit", r);
});
server.close();

const report = readFileSync(out, "utf8");
const bad = report.split("\n").filter((l) => /^\| (FAIL|DIFF) \|/.test(l));
if (!values.out) rmSync(dir, { recursive: true, force: true });
if (code !== 0 || bad.length > 0) {
  console.error(`realcheck mock run: exit ${code}\n${bad.join("\n")}`);
  process.exit(1);
}
console.log("realcheck mock run: every check passed");
