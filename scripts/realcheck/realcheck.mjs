#!/usr/bin/env node
// Runs lazycc against a throwaway CodeCommit repository and writes one report
// with everything that could only be checked on real AWS. See
// docs/dev/real-aws-check.md. It creates one repository named
// lazycc-realcheck-<timestamp>, works only inside it, and deletes it at the end.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
} from "@aws-sdk/client-codebuild";
import * as cc from "@aws-sdk/client-codecommit";
import { CodePipelineClient, ListPipelineExecutionsCommand } from "@aws-sdk/client-codepipeline";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PREFIX = "lazycc-realcheck-";

const { values: opt } = parseArgs({
  options: {
    region: { type: "string" },
    profile: { type: "string" },
    "other-profile": { type: "string" },
    "sso-expired-profile": { type: "string" },
    "limited-profile": { type: "string" },
    "ci-project": { type: "string" },
    "ci-pipeline": { type: "string" },
    ssh: { type: "boolean" },
    keep: { type: "boolean" },
    yes: { type: "boolean" },
    "no-redact": { type: "boolean" },
    "no-pack": { type: "boolean" },
    "no-tui": { type: "boolean" },
    lazycc: { type: "string" },
    out: { type: "string" },
    "mock-git-root": { type: "string" },
    emulator: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (opt.help) {
  console.log(`Usage: node scripts/realcheck/realcheck.mjs --region <region> [options]

  --profile <name>              profile to run as (default: the SDK's default chain)
  --other-profile <name>        a second identity: comments and approves as another person
  --sso-expired-profile <name>  an SSO profile you have logged out of (aws sso logout)
  --limited-profile <name>      an identity without CodeCommit permissions
  --ci-project <name>           an existing CodeBuild project to read builds from (read only)
  --ci-pipeline <name>          an existing CodePipeline pipeline to read executions from (read only)
  --ssh                         also clone over SSH (needs an IAM SSH key and ~/.ssh/config)
  --keep                        do not delete the repository and work directory
  --yes                         do not ask before creating the repository
  --no-redact                   keep the account id and IAM user and session names in the report
  --no-pack                     skip npm pack / npx
  --no-tui                      skip the TUI start checks
  --lazycc <path>               cli.mjs to run (default: dist/cli.mjs)
  --out <file>                  report path (default: ./lazycc-realcheck-<time>.md)
  --emulator                    run against AWS Emulator set up by scripts/emulator/env.sh`);
  process.exit(0);
}

const region = opt.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
if (!region) {
  console.error("realcheck: pass --region (or set AWS_REGION)");
  process.exit(2);
}
const mock = opt["mock-git-root"];
// AWS Emulator announces http://127.0.0.1:<port>/v1/repos/<repo> as cloneUrlHttp,
// which lazycc does not read as CodeCommit, so clones go through grc there
// (scripts/emulator/env.sh routes it). A pass here is not a real-AWS check.
const emulator = Boolean(opt.emulator);
if (emulator && !process.env.AWS_ENDPOINT_URL) {
  console.error('realcheck: --emulator needs eval "$(sh scripts/emulator/env.sh)" first');
  process.exit(2);
}
const targetName = mock ? "mock" : emulator ? "AWS Emulator (not real AWS)" : "real AWS";
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const repoName = `${PREFIX}${stamp}`.toLowerCase();
const work = mkdtempSync(join(tmpdir(), "lazycc-realcheck-"));
const reportPath = resolve(opt.out ?? `lazycc-realcheck-${stamp}.md`);
const cli = resolve(opt.lazycc ?? join(ROOT, "dist/cli.mjs"));

// ---------------------------------------------------------------- recording

const results = [];
const runs = [];
const captures = {};
const activity = [];
const manual = [];
let account;

/** status: PASS, FAIL (lazycc misbehaves), DIFF (CodeCommit differs from lazycc's assumption), SKIP, INFO. */
function record(id, title, status, detail = "") {
  results.push({ id, title, status, detail: String(detail) });
  console.log(
    `${status.padEnd(4)} ${id} ${title}${detail ? ` — ${String(detail).split("\n")[0]}` : ""}`,
  );
}

const trim = (s, n = 4000) =>
  s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (r) => (r.ok ? "ok" : `${r.name}: ${r.message}`);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const row = (cells) =>
  `| ${cells.map((c) => String(c).replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`;
const block = (lang, s) => `\`\`\`${lang}\n${s.replaceAll("```", "ˋˋˋ")}\n\`\`\``;
// oxlint-disable-next-line no-control-regex -- strips terminal escapes from the TUI's output
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]/g;
const has = (obj, path) =>
  path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj) !== undefined;

// ---------------------------------------------------------------- environment

// Keep git config the caller passed the same way (scripts/emulator/env.sh does).
const gitConfig = Array.from({ length: Number(process.env.GIT_CONFIG_COUNT ?? 0) }, (_, i) => [
  process.env[`GIT_CONFIG_KEY_${i}`] ?? "",
  process.env[`GIT_CONFIG_VALUE_${i}`] ?? "",
]);
const mockEnv = {};
if (mock) {
  // lazycc reads origin's URL, so the URLs must stay CodeCommit's: swap the
  // transports instead (https helper, git-remote-codecommit, ssh) for ones that
  // serve the mock's bare repositories.
  const bin = join(work, "mockbin");
  const exec = join(work, "mockexec");
  mkdirSync(bin);
  mkdirSync(exec);
  const real = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  for (const name of readdirSync(real))
    if (!/^git-remote-https?$/.test(name)) symlinkSync(join(real, name), join(exec, name));
  const helper = `#!/bin/sh\nrepo=\${2##*/}\nrepo=\${repo##*@}\nexec git remote-ext "$1" "git-%s ${mock}/$repo"\n`;
  for (const file of [join(exec, "git-remote-https"), join(bin, "git-remote-codecommit")])
    writeFileSync(file, helper, { mode: 0o755 });
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh\nfor a; do cmd=$a; done\nexec sh -c "$(printf %s "$cmd" | sed "s#'/v1/repos/#'${mock}/#")"\n`,
    { mode: 0o755 },
  );
  Object.assign(mockEnv, {
    GIT_EXEC_PATH: exec,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_SSH_COMMAND: join(bin, "ssh"),
  });
  gitConfig.push(["protocol.ext.allow", "always"]);
}

const baseEnv = {
  ...process.env,
  AWS_REGION: region,
  ...(opt.profile ? { AWS_PROFILE: opt.profile } : {}),
  // lazycc's config and state stay inside the work directory.
  XDG_CONFIG_HOME: join(work, "config"),
  XDG_STATE_HOME: join(work, "state"),
  GIT_AUTHOR_NAME: "lazycc realcheck",
  GIT_AUTHOR_EMAIL: "realcheck@example.invalid",
  GIT_COMMITTER_NAME: "lazycc realcheck",
  GIT_COMMITTER_EMAIL: "realcheck@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
  ...mockEnv,
};
function applyGitConfig() {
  baseEnv.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([k, v], i) => {
    baseEnv[`GIT_CONFIG_KEY_${i}`] = k;
    baseEnv[`GIT_CONFIG_VALUE_${i}`] = v;
  });
}

function sh(cmd, args, { cwd = work, env = baseEnv, input = "", timeout = 120_000 } = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8", timeout });
  return {
    exit: r.status ?? (r.error ? -1 : 128),
    stdout: r.stdout ?? "",
    stderr: (r.stderr ?? "") + (r.error ? `\n${r.error.message}` : ""),
    ms: Date.now() - started,
  };
}
const git = (cwd, ...args) => sh("git", args, { cwd });
const which = (bin) => sh("sh", ["-c", `command -v ${bin}`]).exit === 0;

/** Runs lazycc and keeps the run for the report. */
function lazy(label, args, { cwd = work, profile } = {}) {
  const argv = profile ? [...args, "--profile", profile] : args;
  const r = sh(process.execPath, [cli, ...argv], { cwd });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  runs.push({ label, argv: ["lazycc", ...argv].join(" "), cwd: cwd.replace(work, "$WORK"), ...r });
  return { ...r, json };
}

const client = (profile) =>
  new cc.CodeCommitClient({ region, ...(profile ? { profile } : {}), maxAttempts: 2 });
const main = client(opt.profile);
const other = opt["other-profile"] ? client(opt["other-profile"]) : undefined;

/** Sends one CodeCommit call; keeps the first response of each operation for the report. */
async function api(label, command, via = main) {
  try {
    const out = await via.send(command);
    const { $metadata: _, ...body } = out;
    captures[label] ??= body;
    return { ok: true, out: body };
  } catch (error) {
    captures[label] ??= { error: error.name, message: error.message };
    return { ok: false, name: error.name, message: error.message };
  }
}

/** Compares an error CodeCommit returned with the one lazycc's code waits for. */
function expectError(id, title, r, expected, where) {
  const want = [expected].flat();
  if (r.ok) record(id, title, "DIFF", `succeeded; lazycc expects ${want.join(" or ")} (${where})`);
  else if (want.includes(r.name)) record(id, title, "PASS", r.name);
  else
    record(
      id,
      title,
      "DIFF",
      `${r.name}: ${r.message} — lazycc expects ${want.join(" or ")} (${where})`,
    );
}

/** The lazycc run failed or passed as expected, with `needle` in its output. */
function expectRun(id, title, r, { exit = 0, needle } = {}) {
  const text = r.stdout + r.stderr;
  if (r.exit !== exit)
    record(id, title, "FAIL", `exit ${r.exit}, want ${exit}: ${trim(text.trim(), 300)}`);
  else if (needle && !(needle instanceof RegExp ? needle.test(text) : text.includes(needle)))
    record(id, title, "FAIL", `output lacks ${needle}: ${trim(text.trim(), 300)}`);
  else record(id, title, "PASS", `exit ${r.exit}, ${r.ms} ms`);
}

// ---------------------------------------------------------------- steps

const state = {};

async function confirm() {
  const plan = [
    `realcheck will, in ${region}${opt.profile ? ` as profile ${opt.profile}` : ""}:`,
    `  create CodeCommit repository ${repoName} (it must not exist yet),`,
    "  push branches main, feature/one, feature/two, feature/rename to it, open up to 4 pull requests,",
    "  comment (including retried posts with a client request token), approve,",
    "  merge and close them, delete branch feature/two,",
    opt.keep
      ? "  and keep the repository (--keep)."
      : `  then delete repository ${repoName}. No other repository is touched.`,
    `  Local files: ${work} (deleted at the end${opt.keep ? ", kept with --keep" : ""}), report: ${reportPath}`,
  ].join("\n");
  console.log(plan);
  if (opt.yes) return true;
  if (!process.stdin.isTTY) {
    console.error("realcheck: not a terminal; pass --yes to proceed");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Proceed? Type yes: ");
  rl.close();
  return answer.trim() === "yes";
}

async function environment() {
  const node = process.versions.node;
  const major = Number(node.split(".")[0]);
  record("env.node", "Node.js version (engines: >=20)", major >= 20 ? "PASS" : "FAIL", `v${node}`);
  const cloudShell = process.env.AWS_EXECUTION_ENV === "CloudShell";
  record(
    "env.cloudshell",
    "Running in CloudShell",
    "INFO",
    cloudShell ? "yes" : `no (${process.platform})`,
  );
  record("env.git", "git version", "INFO", sh("git", ["--version"]).stdout.trim());
  record(
    "env.aws",
    "AWS CLI",
    "INFO",
    which("aws") ? sh("aws", ["--version"]).stdout.trim() || "present" : "absent",
  );
  record(
    "env.grc",
    "git-remote-codecommit",
    "INFO",
    which("git-remote-codecommit") ? "present" : "absent",
  );
  record(
    "env.mode",
    "Target",
    "INFO",
    mock ? `mock (${process.env.AWS_ENDPOINT_URL_CODECOMMIT})` : targetName,
  );

  const sts = new STSClient({ region, ...(opt.profile ? { profile: opt.profile } : {}) });
  const me = await sts.send(new GetCallerIdentityCommand({}));
  account = me.Account;
  state.me = me.Arn;
  const kind = /:assumed-role\//.test(me.Arn)
    ? "assumed-role"
    : /:user\//.test(me.Arn)
      ? "user"
      : "other";
  record(
    "env.identity",
    "Caller identity (lazycc matches user/… and assumed-role/Role/Session)",
    kind === "other" ? "DIFF" : "PASS",
    me.Arn,
  );
  if (other) {
    const them = await new STSClient({ region, profile: opt["other-profile"] }).send(
      new GetCallerIdentityCommand({}),
    );
    state.other = them.Arn;
    record(
      "env.other",
      "Second identity",
      them.Arn === me.Arn ? "FAIL" : "PASS",
      them.Arn === me.Arn ? "same ARN as --profile" : them.Arn,
    );
  }

  // HTTPS clones need a credential helper. Use the user's own if there is one.
  const helper = git(
    work,
    "config",
    "--get-urlmatch",
    "credential.helper",
    `https://git-codecommit.${region}.amazonaws.com/v1/repos/x`,
  );
  if (mock) state.helper = "mock (local transports)";
  else if (emulator) state.helper = "AWS Emulator (scripts/emulator/env.sh)";
  // Only whether one exists: a helper's command line can hold a secret.
  else if (helper.stdout.includes("codecommit")) state.helper = "existing CodeCommit helper";
  else if (which("aws")) {
    // Added after any helper already configured (git tries them in order).
    const host = `https://git-codecommit.${region}.amazonaws.com`;
    gitConfig.push([`credential.${host}.helper`, "!aws codecommit credential-helper $@"]);
    gitConfig.push([`credential.${host}.usehttppath`, "true"]);
    state.helper = "added for this run only: aws codecommit credential-helper";
  } else state.helper = "none (HTTPS clone will likely fail)";
  applyGitConfig();
  record("env.helper", "git credential helper for HTTPS", "INFO", state.helper);
}

function pack() {
  if (opt["no-pack"]) return record("npx", "npm pack + npx start", "SKIP", "--no-pack");
  const dest = join(work, "pack");
  mkdirSync(dest);
  const p = sh("npm", ["pack", "--silent", "--pack-destination", dest], { cwd: ROOT });
  if (p.exit !== 0) return record("npx", "npm pack", "FAIL", p.stderr);
  const tgz = join(dest, p.stdout.trim().split("\n").pop());
  const npx = sh("npx", ["--yes", "--package", tgz, "--", "lazycc", "--version"], { cwd: dest });
  runs.push({
    label: "npx tarball",
    argv: "npx --yes --package <tgz> -- lazycc --version",
    cwd: "$WORK/pack",
    ...npx,
  });
  if (npx.exit !== 0)
    return record("npx", "npx --package <tarball> lazycc --version", "FAIL", npx.stderr);
  record(
    "npx",
    "npx --package <tarball> lazycc --version (first run, installs)",
    "PASS",
    `${npx.stdout.trim()} in ${npx.ms} ms`,
  );
  const prefix = join(dest, "prefix");
  sh("npm", ["install", "--silent", "--no-audit", "--no-fund", "--prefix", prefix, tgz]);
  const bin = join(prefix, "node_modules/.bin/lazycc");
  const times = [];
  for (let i = 0; i < 7; i++) times.push(sh(bin, ["--version"]).ms);
  const median = times.toSorted((a, b) => a - b)[3];
  record(
    "startup",
    "Cold start, median of 7 `lazycc --version` (spec: 300 ms)",
    median <= 300 ? "PASS" : "DIFF",
    `${median} ms (${times.join(", ")})`,
  );
}

async function createRepository() {
  const exists = await api(
    "GetRepository (planned name)",
    new cc.GetRepositoryCommand({ repositoryName: repoName }),
  );
  if (exists.ok) throw new Error(`${repoName} already exists; refusing to touch it`);
  expectError(
    "repo.missing",
    "GetRepository on a missing repository",
    exists,
    "RepositoryDoesNotExistException",
    "formatError.ts",
  );
  const r = await api(
    "CreateRepository",
    new cc.CreateRepositoryCommand({
      repositoryName: repoName,
      repositoryDescription:
        "Temporary repository made by lazycodecommit's realcheck. Safe to delete.",
    }),
  );
  if (r.name === "RepositoryNameExistsException")
    // It did not exist a moment ago, so a timed-out first attempt probably created it.
    throw new Error(
      `CreateRepository: ${repoName} exists now; a retried call may have created it. Check it and delete it by hand: aws codecommit delete-repository --repository-name ${repoName}`,
    );
  if (!r.ok) throw new Error(`CreateRepository failed: ${r.name}: ${r.message}`);
  state.created = true;
  record("repo.create", "Create the test repository", "PASS", repoName);
  const urls = r.out.repositoryMetadata;
  // The same pattern as src/core/remote.ts.
  const remote =
    /^(?:https|ssh):\/\/(?:[^@/]+@)?git-codecommit(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/v1\/repos\/([^/?#]+?)\/?$/;
  for (const key of ["cloneUrlHttp", "cloneUrlSsh"]) {
    const m = remote.exec(urls[key] ?? "");
    record(
      `repo.${key}`,
      `${key} parses as a CodeCommit remote (core/remote.ts)`,
      m && m[2] === repoName ? "PASS" : "DIFF",
      urls[key],
    );
  }
}

function seed() {
  const dir = join(work, "seed");
  const protocol = emulator ? "grc" : "https";
  const c = lazy(`clone ${protocol} (empty repository)`, [
    "clone",
    repoName,
    dir,
    "--protocol",
    protocol,
  ]);
  expectRun(`clone.${protocol}`, `lazycc clone --protocol ${protocol} (empty repository)`, c);
  if (c.exit !== 0) throw new Error("cannot clone the test repository");
  git(dir, "checkout", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "README.md"), "# realcheck\n\nMade by lazycodecommit realcheck.\n");
  writeFileSync(join(dir, "src/a.txt"), "line 1\nline 2\nline 3\n");
  writeFileSync(join(dir, "docs/b.md"), "docs\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Initial commit");
  const push = git(dir, "push", "-q", "-u", "origin", "main");
  if (push.exit !== 0) throw new Error(`git push main failed: ${push.stderr}`);
  state.seed = dir;
  state.mainTip = git(dir, "rev-parse", "HEAD").stdout.trim();
  record(
    "seed",
    "Push main with README.md, src/a.txt, docs/b.md",
    "PASS",
    state.mainTip.slice(0, 12),
  );
}

function commit(dir, file, text, message) {
  writeFileSync(join(dir, file), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD").stdout.trim();
}

async function getPr(id, via = main) {
  return (await api("GetPullRequest", new cc.GetPullRequestCommand({ pullRequestId: id }), via)).out
    ?.pullRequest;
}

async function pullRequests() {
  const dir = state.seed;
  git(dir, "checkout", "-q", "-b", "feature/one");
  commit(dir, "src/a.txt", "line 1\nline 2 changed\nline 3\n", "Change line 2");
  const created = lazy("pr create", ["pr", "create", "--fill", "--push", "--json"], { cwd: dir });
  expectRun("pr.create", "lazycc pr create --fill --push --json", created);
  if (!created.json?.id) throw new Error("pr create did not return an id");
  state.pr1 = created.json.id;
  manual.push(`Pull request page: ${created.json.url}`);

  const pr = await getPr(state.pr1);
  // The fields lazycc reads (aws/codecommit.ts toPullRequest, core/inbox.ts).
  const fields = [
    "pullRequestId",
    "title",
    "pullRequestStatus",
    "authorArn",
    "creationDate",
    "lastActivityDate",
    "revisionId",
    "approvalRules",
    "pullRequestTargets.0.repositoryName",
    "pullRequestTargets.0.sourceReference",
    "pullRequestTargets.0.destinationReference",
    "pullRequestTargets.0.sourceCommit",
    "pullRequestTargets.0.destinationCommit",
    "pullRequestTargets.0.mergeBase",
    "pullRequestTargets.0.mergeMetadata.isMerged",
  ];
  const missing = fields.filter((f) => !has(pr, f));
  record(
    "pr.shape",
    "GetPullRequest has every field lazycc reads",
    missing.length ? "DIFF" : "PASS",
    missing.length ? `missing: ${missing.join(", ")}` : "",
  );
  const ref = pr?.pullRequestTargets?.[0]?.sourceReference ?? "";
  record(
    "pr.ref",
    "sourceReference is refs/heads/<branch>",
    ref === "refs/heads/feature/one" ? "PASS" : "DIFF",
    ref,
  );
  record(
    "pr.author",
    "authorArn equals the caller ARN (inbox: mine)",
    pr?.authorArn === state.me ? "PASS" : "DIFF",
    pr?.authorArn,
  );

  expectRun(
    "pr.list",
    "lazycc pr list --json",
    lazy("pr list", ["pr", "list", "--json"], { cwd: dir }),
  );
  expectRun(
    "pr.view",
    "lazycc pr view <id> --json",
    lazy("pr view", ["pr", "view", state.pr1, "--json"], { cwd: dir }),
  );
  expectRun(
    "pr.view.branch",
    "lazycc pr view (current branch) --json",
    lazy("pr view (branch)", ["pr", "view", "--json"], { cwd: dir }),
  );
  expectRun(
    "pr.status",
    "lazycc pr status --json",
    lazy("pr status", ["pr", "status", "--json"], { cwd: dir }),
  );
  expectRun(
    "pr.outside",
    "lazycc pr view --repo outside a clone",
    lazy("pr view outside", ["pr", "view", state.pr1, "--repo", repoName, "--json"]),
  );
  expectRun(
    "pr.view.missing",
    "lazycc pr view 999999 fails cleanly",
    lazy("pr view missing", ["pr", "view", "999999", "--repo", repoName]),
    { exit: 1 },
  );
  expectError(
    "pr.missing",
    "GetPullRequest on a missing id",
    await api(
      "GetPullRequest (missing)",
      new cc.GetPullRequestCommand({ pullRequestId: "999999" }),
    ),
    "PullRequestDoesNotExistException",
    "core/inbox.ts",
  );

  git(dir, "checkout", "-q", "main");
  git(dir, "checkout", "-q", "-b", "feature/two");
  state.two1 = commit(dir, "docs/b.md", "docs\nmore docs\n", "Add more docs");
  const two = lazy("pr create (2)", ["pr", "create", "--fill", "--push", "--json"], { cwd: dir });
  expectRun("pr.create.2", "lazycc pr create for feature/two", two);
  state.pr2 = two.json?.id;
}

/** ADR 0006: does each action move lastActivityDate? */
async function lastActivity() {
  const id = state.pr1;
  const dir = state.seed;
  git(dir, "checkout", "-q", "feature/one");
  let base = await getPr(id);
  const comments = {};
  const step = async (actor, action, run) => {
    const before = (await getPr(id))?.lastActivityDate;
    await sleep(1500);
    const outcome = await run();
    await sleep(2500);
    const after = (await getPr(id))?.lastActivityDate;
    const moved = before && after && after.getTime() > before.getTime();
    activity.push({
      actor,
      action,
      outcome,
      before: before?.toISOString(),
      after: after?.toISOString(),
      moved,
    });
    record(
      `activity.${actor}.${action}`,
      `lastActivityDate moves on ${action} by ${actor}`,
      outcome !== "ok" ? "FAIL" : moved ? "PASS" : action === "reaction" ? "INFO" : "DIFF",
      outcome !== "ok"
        ? outcome
        : moved
          ? ""
          : action === "reaction"
            ? "not updated (ADR 0006: a reaction does not make a PR unread)"
            : "not updated (ADR 0006: needs a fallback)",
    );
  };
  const target = () => ({
    pullRequestId: id,
    repositoryName: repoName,
    beforeCommitId: base.pullRequestTargets[0].destinationCommit,
    afterCommitId: base.pullRequestTargets[0].sourceCommit,
  });

  await step("self", "comment (lazycc pr comment)", async () => {
    const r = lazy("pr comment", ["pr", "comment", id, "-b", "realcheck: a comment", "--json"], {
      cwd: dir,
    });
    return r.exit === 0 ? "ok" : `exit ${r.exit}: ${r.stderr.trim()}`;
  });
  await step("self", "inline comment", async () => {
    const r = await api(
      "PostCommentForPullRequest (inline)",
      new cc.PostCommentForPullRequestCommand({
        ...target(),
        content: "realcheck: inline",
        location: { filePath: "src/a.txt", filePosition: 2, relativeFileVersion: "AFTER" },
      }),
    );
    comments.inline = r.out?.comment?.commentId;
    return ok(r);
  });
  await step("self", "reply", async () =>
    ok(
      await api(
        "PostCommentReply",
        new cc.PostCommentReplyCommand({ inReplyTo: comments.inline, content: "realcheck: reply" }),
      ),
    ),
  );
  await step("self", "reaction", async () =>
    ok(
      await api(
        "PutCommentReaction",
        new cc.PutCommentReactionCommand({
          commentId: comments.inline,
          reactionValue: ":thumbsup:",
        }),
      ),
    ),
  );
  await reactionCounts(id, comments.inline);
  await step("self", "title update", async () =>
    ok(
      await api(
        "UpdatePullRequestTitle",
        new cc.UpdatePullRequestTitleCommand({
          pullRequestId: id,
          title: "Change line 2 (edited)",
        }),
      ),
    ),
  );
  await step("self", "push to source branch", async () => {
    commit(dir, "src/a.txt", "line 1\nline 2 changed\nline 3\nline 4\n", "Add line 4");
    const r = git(dir, "push", "-q", "origin", "feature/one");
    return r.exit === 0 ? "ok" : r.stderr.trim();
  });
  base = await getPr(id);
  await commentsAfterPush(id, [comments.inline], base);
  if (!other) {
    record(
      "activity.other",
      "lastActivityDate on another person's actions",
      "SKIP",
      "pass --other-profile",
    );
  } else {
    await step("other", "comment", async () =>
      ok(
        await api(
          "PostCommentForPullRequest (other)",
          new cc.PostCommentForPullRequestCommand({
            ...target(),
            content: "realcheck: other's comment",
          }),
          other,
        ),
      ),
    );
    await step("other", "inline comment", async () => {
      const r = await api(
        "PostCommentForPullRequest (other inline)",
        new cc.PostCommentForPullRequestCommand({
          ...target(),
          content: "realcheck: other's inline",
          location: { filePath: "src/a.txt", filePosition: 1, relativeFileVersion: "BEFORE" },
        }),
        other,
      );
      comments.otherInline = r.out?.comment?.commentId;
      return ok(r);
    });
    await step("other", "reply", async () =>
      ok(
        await api(
          "PostCommentReply (other)",
          new cc.PostCommentReplyCommand({
            inReplyTo: comments.inline,
            content: "realcheck: other's reply",
          }),
          other,
        ),
      ),
    );
    // ADR 0005: before approving, the PR is awaiting their approval.
    const inbox = lazy("status as other", ["status", "--repo", repoName, "--json"], {
      profile: opt["other-profile"],
    });
    const awaiting = inbox.json?.awaiting?.some((p) => p.id === id);
    record(
      "inbox.awaiting",
      "The other identity sees the PR under awaiting approval (ADR 0005)",
      inbox.exit === 0 && awaiting ? "PASS" : "FAIL",
      inbox.exit === 0
        ? JSON.stringify(inbox.json?.awaiting?.map((p) => p.id))
        : inbox.stderr.trim(),
    );
    await step("other", "approve (lazycc pr approve)", async () => {
      const r = lazy("pr approve as other", ["pr", "approve", id, "--repo", repoName, "--json"], {
        profile: opt["other-profile"],
      });
      return r.exit === 0 ? "ok" : `exit ${r.exit}: ${r.stderr.trim()}`;
    });
    const states = await api(
      "GetPullRequestApprovalStates",
      new cc.GetPullRequestApprovalStatesCommand({
        pullRequestId: id,
        revisionId: (await getPr(id)).revisionId,
      }),
    );
    const approved = states.out?.approvals?.some(
      (a) => a.userArn === state.other && a.approvalState === "APPROVE",
    );
    record(
      "approve.other",
      "Approval is listed under the other identity's ARN",
      approved ? "PASS" : "DIFF",
      JSON.stringify(states.out?.approvals ?? states.name),
    );
    await step("other", "revoke (lazycc pr approve --revoke)", async () => {
      const r = lazy(
        "pr approve --revoke as other",
        ["pr", "approve", id, "--revoke", "--repo", repoName, "--json"],
        { profile: opt["other-profile"] },
      );
      return r.exit === 0 ? "ok" : `exit ${r.exit}: ${r.stderr.trim()}`;
    });
  }
  const events = await api(
    "DescribePullRequestEvents",
    new cc.DescribePullRequestEventsCommand({ pullRequestId: id }),
  );
  record(
    "activity.events",
    "Event types CodeCommit recorded",
    "INFO",
    [...new Set((events.out?.pullRequestEvents ?? []).map((e) => e.pullRequestEventType))].join(
      ", ",
    ) || events.name,
  );
  const thread = await api(
    "GetCommentsForPullRequest",
    new cc.GetCommentsForPullRequestCommand({ pullRequestId: id }),
  );
  const latest = (thread.out?.commentsForPullRequestData ?? [])
    .flatMap((d) => d.comments ?? [])
    .map((c) => c.creationDate?.getTime() ?? 0);
  record(
    "activity.comments",
    "Newest comment time (the ADR 0006 fallback)",
    "INFO",
    latest.length ? new Date(Math.max(...latest)).toISOString() : (thread.name ?? "none"),
  );
}

/**
 * The review screen calls GetCommentReactions only for comments whose
 * reactionCounts count something (#101), so a reacted comment must carry them.
 */
async function reactionCounts(id, commentId) {
  const r = await api(
    "GetCommentsForPullRequest (after reaction)",
    new cc.GetCommentsForPullRequestCommand({ pullRequestId: id }),
  );
  const title = "A reacted comment's reactionCounts in GetCommentsForPullRequest";
  if (!r.ok) return record("comments.reactionCounts", title, "FAIL", ok(r));
  const comment = (r.out.commentsForPullRequestData ?? [])
    .flatMap((d) => d.comments ?? [])
    .find((c) => c.commentId === commentId);
  const counts = comment?.reactionCounts;
  if (!comment)
    return record("comments.reactionCounts", title, "SKIP", "reacted comment not found");
  if (counts === undefined)
    return record("comments.reactionCounts", title, "PASS", "field left out: lazycc reads it");
  const counted = Object.values(counts).some((n) => n > 0);
  record(
    "comments.reactionCounts",
    title,
    counted ? "PASS" : "DIFF",
    counted
      ? JSON.stringify(counts)
      : `${JSON.stringify(counts)} — the review screen would not show this comment's reactions`,
  );
}

/** Every comment id GetCommentsForPullRequest returns for `input`, or the error. */
async function commentIds(input) {
  const found = [];
  let nextToken;
  do {
    const r = await api(
      "GetCommentsForPullRequest (after push)",
      new cc.GetCommentsForPullRequestCommand({ ...input, nextToken }),
    );
    if (!r.ok) return ok(r);
    for (const d of r.out.commentsForPullRequestData ?? [])
      for (const c of d.comments ?? []) found.push(c.commentId);
    nextToken = r.out.nextToken;
  } while (nextToken);
  return found;
}

/**
 * aws/review.ts getComments asks with the pull request id alone: filtered by
 * the current tips, CodeCommit leaves out the comments made before a push
 * (seen on 2026-11-18), and repositoryName without commit ids is refused.
 */
async function commentsAfterPush(id, before, pr) {
  const t = pr?.pullRequestTargets?.[0];
  const wanted = before.filter(Boolean);
  if (!t || wanted.length === 0)
    return record("comments.after-push", "Comments made before a push", "SKIP", "no comment or PR");
  const all = await commentIds({ pullRequestId: id });
  const pair = await commentIds({
    pullRequestId: id,
    repositoryName: repoName,
    beforeCommitId: t.destinationCommit,
    afterCommitId: t.sourceCommit,
  });
  const holds = (list) => Array.isArray(list) && wanted.every((c) => list.includes(c));
  record(
    "comments.after-push",
    "GetCommentsForPullRequest by pull request id alone returns comments made before a push (aws/review.ts getComments)",
    typeof all === "string" ? "FAIL" : holds(all) ? "PASS" : "DIFF",
    typeof all === "string" ? all : holds(all) ? "" : `lacks them (${all.length} comments)`,
  );
  record(
    "comments.after-push.filtered",
    "The same, filtered by the new tips, for comparison",
    "INFO",
    typeof pair === "string"
      ? pair
      : `${holds(pair) ? "returns" : "lacks"} them (${pair.length} comments)`,
  );
}

/**
 * Two questions lazycc leaves open: which path a comment on the old side of a
 * renamed file takes (the review screen sends the new path, commentDrafts.ts
 * lineReader looks for the old one), and whether the 150-character title limit
 * counts characters or bytes (core/pr.ts checkLengths counts characters).
 */
async function renames() {
  const dir = state.seed;
  git(dir, "checkout", "-q", "main");
  git(dir, "checkout", "-q", "-b", "feature/rename");
  git(dir, "mv", "docs/b.md", "docs/renamed.md");
  git(dir, "commit", "-q", "-m", "Rename b.md");
  const push = git(dir, "push", "-q", "origin", "feature/rename");
  if (push.exit !== 0) return record("rename", "Rename checks", "SKIP", push.stderr.trim());
  const create = (title) =>
    api(
      "CreatePullRequest (rename)",
      new cc.CreatePullRequestCommand({
        title,
        targets: [
          {
            repositoryName: repoName,
            sourceReference: "feature/rename",
            destinationReference: "main",
          },
        ],
      }),
    );
  const long = await create("x".repeat(151));
  record(
    "title.151",
    "CreatePullRequest with a 151-character title (core/pr.ts refuses it before pushing)",
    "INFO",
    long.ok ? "accepted" : `${long.name}: ${long.message}`,
  );
  if (long.ok)
    await api(
      "UpdatePullRequestStatus (151)",
      new cc.UpdatePullRequestStatusCommand({
        pullRequestId: long.out.pullRequest.pullRequestId,
        pullRequestStatus: "CLOSED",
      }),
    );
  const r = await create("あ".repeat(150));
  record(
    "title.150-multibyte",
    "CreatePullRequest with 150 three-byte characters (450 bytes)",
    "INFO",
    r.ok ? "accepted" : `${r.name}: ${r.message}`,
  );
  const pr = r.out?.pullRequest;
  const t = pr?.pullRequestTargets?.[0];
  if (!t) return record("rename", "Rename checks", "SKIP", "no PR");
  const diff = await api(
    "GetDifferences (rename)",
    new cc.GetDifferencesCommand({
      repositoryName: repoName,
      beforeCommitSpecifier: t.mergeBase ?? t.destinationCommit,
      afterCommitSpecifier: t.sourceCommit,
    }),
  );
  record(
    "rename.differences",
    "GetDifferences on a renamed file",
    "INFO",
    diff.ok
      ? (diff.out.differences ?? [])
          .map((d) => `${d.changeType} ${d.beforeBlob?.path ?? "-"} -> ${d.afterBlob?.path ?? "-"}`)
          .join("; ")
      : ok(diff),
  );
  for (const [side, filePath] of [
    ["old", "docs/b.md"],
    ["new", "docs/renamed.md"],
  ]) {
    const posted = await api(
      `PostCommentForPullRequest (rename, ${side} path)`,
      new cc.PostCommentForPullRequestCommand({
        pullRequestId: pr.pullRequestId,
        repositoryName: repoName,
        beforeCommitId: t.destinationCommit,
        afterCommitId: t.sourceCommit,
        content: `realcheck: BEFORE side, ${side} path`,
        location: { filePath, filePosition: 1, relativeFileVersion: "BEFORE" },
      }),
    );
    record(
      `rename.before.${side}-path`,
      `A BEFORE-side comment on the renamed file with the ${side} path`,
      "INFO",
      posted.ok ? `accepted, stored as ${JSON.stringify(posted.out.location)}` : ok(posted),
    );
  }
  manual.push(
    `Renamed file: open PR ${pr.pullRequestId} in the console during --keep and note which of the two BEFORE-side comments on docs/renamed.md it shows, and where.`,
  );
  await api(
    "UpdatePullRequestStatus (rename)",
    new cc.UpdatePullRequestStatusCommand({
      pullRequestId: pr.pullRequestId,
      pullRequestStatus: "CLOSED",
    }),
  );
}

async function approvals() {
  const id = state.pr1;
  const r = lazy("pr approve own", ["pr", "approve", id, "--json"], { cwd: state.seed });
  expectRun("approve.own.cli", "lazycc pr approve on your own PR explains it", r, {
    exit: 1,
    needle: "cannot approve your own",
  });
  const pr = await getPr(id);
  const raw = await api(
    "UpdatePullRequestApprovalState (own)",
    new cc.UpdatePullRequestApprovalStateCommand({
      pullRequestId: id,
      revisionId: pr.revisionId,
      approvalState: "APPROVE",
    }),
  );
  expectError(
    "approve.own",
    "Approving your own PR",
    raw,
    "PullRequestCannotBeApprovedByAuthorException",
    "aws/errors.ts",
  );
  if (raw.ok)
    await api(
      "UpdatePullRequestApprovalState (undo)",
      new cc.UpdatePullRequestApprovalStateCommand({
        pullRequestId: id,
        revisionId: pr.revisionId,
        approvalState: "REVOKE",
      }),
    );
}

/** ADR 0009: drafts are posted one at a time with a clientRequestToken; a retry must not post twice. */
async function draftTokens() {
  const id = state.pr1;
  const dir = state.seed;
  const old = (await getPr(id))?.pullRequestTargets?.[0];
  if (!old) return record("drafts", "Draft posting checks", "SKIP", "PR 1 unreadable");
  const at = (t) => ({
    pullRequestId: id,
    repositoryName: repoName,
    beforeCommitId: t.destinationCommit,
    afterCommitId: t.sourceCommit,
  });
  const token = randomUUID();
  const send = (t, content, tok = token) =>
    api(
      "PostCommentForPullRequest (token)",
      new cc.PostCommentForPullRequestCommand({
        ...at(t),
        content,
        location: { filePath: "src/a.txt", filePosition: 1, relativeFileVersion: "AFTER" },
        clientRequestToken: tok,
      }),
    );
  const first = await send(old, "realcheck: draft");
  const again = await send(old, "realcheck: draft");
  const firstId = first.out?.comment?.commentId;
  record(
    "drafts.token.same",
    "Same token and parameters return the first comment (no second post)",
    !first.ok ? "FAIL" : again.out?.comment?.commentId === firstId ? "PASS" : "DIFF",
    !first.ok
      ? ok(first)
      : again.ok
        ? `ids ${firstId} / ${again.out?.comment?.commentId}`
        : ok(again),
  );
  expectError(
    "drafts.token.changed",
    "Same token, other content",
    await send(old, "realcheck: draft (edited)"),
    "IdempotencyParameterMismatchException",
    "core/commentDrafts.ts editDraft",
  );
  const replyToken = randomUUID();
  const reply = () =>
    api(
      "PostCommentReply (token)",
      new cc.PostCommentReplyCommand({
        inReplyTo: firstId,
        content: "realcheck: draft reply",
        clientRequestToken: replyToken,
      }),
    );
  const r1 = await reply();
  const r2 = await reply();
  record(
    "drafts.token.reply",
    "Same reply token returns the first reply",
    !r1.ok ? "FAIL" : r2.out?.comment?.commentId === r1.out?.comment?.commentId ? "PASS" : "DIFF",
    r1.ok ? (r2.ok ? "" : ok(r2)) : ok(r1),
  );

  git(dir, "checkout", "-q", "feature/one");
  commit(dir, "src/a.txt", "line 0\nline 1\nline 2 changed\nline 3\nline 4\n", "Add line 0");
  git(dir, "push", "-q", "origin", "feature/one");
  await sleep(2000);
  const retried = await send(old, "realcheck: draft");
  record(
    "drafts.token.after-push",
    "After the tip moves, retrying with the old token and commits returns the first comment",
    retried.out?.comment?.commentId === firstId ? "PASS" : "DIFF",
    retried.ok ? `id ${retried.out?.comment?.commentId}` : ok(retried),
  );
  const stale = await send(old, "realcheck: on the old tip", randomUUID());
  record(
    "drafts.stale-tip",
    "Posting a new comment against the old source tip (ADR 0009 posts on the current tip)",
    "INFO",
    stale.ok ? `accepted, afterCommitId ${stale.out?.afterCommitId}` : ok(stale),
  );
}

/**
 * #99: CommentInput (COMMENT_MAX_LENGTH) counts UTF-16 code units, so it lets
 * through 10,240 ASCII or Japanese characters and 5,120 emoji (2 units each),
 * and stops at 10,241. Whether CodeCommit counts the same way is unknown.
 */
async function commentLimits() {
  const t = (await getPr(state.pr1))?.pullRequestTargets?.[0];
  if (!t) return record("comment.limit", "Comment length limit", "SKIP", "PR 1 unreadable");
  const cases = [
    ["ascii-10240", "10,240 ASCII characters", "a".repeat(10240), true],
    ["ascii-10241", "10,241 ASCII characters", "a".repeat(10241), false],
    ["japanese-10240", "10,240 Japanese characters (30,720 UTF-8 bytes)", "あ".repeat(10240), true],
    ["emoji-5120", "5,120 emoji (10,240 UTF-16 units, 20,480 bytes)", "😀".repeat(5120), true],
  ];
  for (const [id, what, content, fits] of cases) {
    const r = await api(
      "PostCommentForPullRequest (limit)",
      new cc.PostCommentForPullRequestCommand({
        pullRequestId: state.pr1,
        repositoryName: repoName,
        beforeCommitId: t.destinationCommit,
        afterCommitId: t.sourceCommit,
        content,
      }),
    );
    // Accepted but stored shorter would mean CodeCommit cuts instead of refusing.
    const kept = r.ok && r.out.comment?.content === content;
    record(
      `comment.limit.${id}`,
      `A comment of ${what}: lazycc ${fits ? "lets it through" : "stops it"} (tui/components/CommentInput.tsx)`,
      r.ok === fits && (!r.ok || kept) ? "PASS" : "DIFF",
      r.ok
        ? `accepted, stored ${kept ? "whole" : `as ${r.out.comment?.content?.length} UTF-16 units`}`
        : ok(r),
    );
  }
}

async function merges() {
  const dir = state.seed;
  if (!state.pr2) return record("merge", "Merge checks", "SKIP", "no second PR");
  // A stale source commit must be refused. If CodeCommit merges anyway, PR 2 is spent, which is fine.
  git(dir, "checkout", "-q", "feature/two");
  commit(dir, "docs/b.md", "docs\nmore docs\neven more\n", "Even more docs");
  git(dir, "push", "-q", "origin", "feature/two");
  await sleep(2000);
  await getPr(state.pr2);
  const stale = await api(
    "MergePullRequestByFastForward (stale source)",
    new cc.MergePullRequestByFastForwardCommand({
      pullRequestId: state.pr2,
      repositoryName: repoName,
      sourceCommitId: state.two1,
    }),
  );
  expectError(
    "merge.stale",
    "Merging with a stale sourceCommitId",
    stale,
    "TipOfSourceReferenceIsDifferentException",
    "aws/errors.ts",
  );
  if (!stale.ok) {
    const m = lazy("pr merge --squash", ["pr", "merge", state.pr2, "--squash", "--json"], {
      cwd: dir,
    });
    expectRun("merge.squash", "lazycc pr merge --squash", m);
  }
  const merged = lazy("pr view merged", ["pr", "view", state.pr2, "--json"], { cwd: dir });
  record(
    "merge.state",
    "pr view shows MERGED",
    merged.json?.status === "MERGED" ? "PASS" : "FAIL",
    merged.json?.status ?? merged.stderr.trim(),
  );

  // main moved, so PR 1 cannot fast-forward.
  const ff = lazy("pr merge --ff (diverged)", ["pr", "merge", state.pr1, "--ff", "--json"], {
    cwd: dir,
  });
  expectRun("merge.ff.cli", "lazycc pr merge --ff on a diverged PR explains it", ff, {
    exit: 1,
    needle: /cannot be merged automatically|fast-forward/,
  });
  const pr = await getPr(state.pr1);
  const raw = await api(
    "MergePullRequestByFastForward (diverged)",
    new cc.MergePullRequestByFastForwardCommand({
      pullRequestId: state.pr1,
      repositoryName: repoName,
      sourceCommitId: pr.pullRequestTargets[0].sourceCommit,
    }),
  );
  expectError(
    "merge.ff",
    "Fast-forward when the destination moved",
    raw,
    "ManualMergeRequiredException",
    "aws/errors.ts",
  );

  const branch = lazy("branch", ["branch", "--json"], { cwd: dir });
  expectRun("branch", "lazycc branch --json", branch);
  const two = branch.json?.branches?.find((b) => b.name === "feature/two");
  record(
    "branch.merged",
    "feature/two shows as merged in the branch table",
    two?.state === "merged" ? "PASS" : "FAIL",
    two ? two.state : "not listed",
  );
  const del = await api(
    "DeleteBranch",
    new cc.DeleteBranchCommand({ repositoryName: repoName, branchName: "feature/two" }),
  );
  record(
    "branch.delete",
    "DeleteBranch on a merged branch",
    del.ok ? "PASS" : "FAIL",
    del.ok ? "" : `${del.name}: ${del.message}`,
  );
  expectError(
    "branch.missing",
    "GetBranch on a deleted branch",
    await api(
      "GetBranch (missing)",
      new cc.GetBranchCommand({ repositoryName: repoName, branchName: "feature/two" }),
    ),
    "BranchDoesNotExistException",
    "aws/codecommit.ts branchCommit",
  );
}

async function browse() {
  const short = state.mainTip.slice(0, 7);
  const get = (label, folderPath, commitSpecifier = "main") =>
    api(label, new cc.GetFolderCommand({ repositoryName: repoName, commitSpecifier, folderPath }));
  expectError(
    "browse.folderOnFile",
    "GetFolder on a file path",
    await get("GetFolder (file path)", "src/a.txt"),
    ["InvalidPathException", "FolderDoesNotExistException"],
    "aws/codecommit.ts getFolder",
  );
  expectError(
    "browse.fileMissing",
    "GetFile on a missing path",
    await api(
      "GetFile (missing)",
      new cc.GetFileCommand({
        repositoryName: repoName,
        commitSpecifier: "main",
        filePath: "nope.txt",
      }),
    ),
    "FileDoesNotExistException",
    "aws/codecommit.ts getFile",
  );
  expectError(
    "browse.badRef",
    "GetFolder at a ref that does not exist",
    await get("GetFolder (bad ref)", "/", "no-such-branch"),
    ["CommitDoesNotExistException", "InvalidCommitException"],
    "core/browse.ts BAD_REF",
  );
  const s = await get("GetFolder (short commit id)", "/", short);
  expectError(
    "browse.shortRef",
    "GetFolder refuses a 7-character commit id",
    s,
    "CommitDoesNotExistException",
    "core/browse.ts openPath",
  );
  const c = await api(
    "GetCommit (short id)",
    new cc.GetCommitCommand({ repositoryName: repoName, commitId: short }),
  );
  record(
    "browse.shortCommit",
    "GetCommit with a 7-character id",
    "INFO",
    c.ok ? "accepted" : `${c.name}: ${c.message}`,
  );
  await get("GetFolder (root)", "/");
  await api(
    "GetFile",
    new cc.GetFileCommand({
      repositoryName: repoName,
      commitSpecifier: "main",
      filePath: "src/a.txt",
    }),
  );

  const root = lazy("browse root", ["browse", repoName, "--json"]);
  expectRun("browse.root", "lazycc browse <repo> --json", root);
  const file = lazy("browse file", ["browse", repoName, "--path", "src/a.txt", "--json"]);
  expectRun("browse.file", "lazycc browse --path <file> (GetFolder falls back to GetFile)", file, {
    needle: "line 2",
  });
  const atShort = lazy("browse short ref", [
    "browse",
    repoName,
    "--ref",
    short,
    "--path",
    "src",
    "--json",
  ]);
  expectRun("browse.short", "lazycc browse --ref <short id> asks for the full id", atShort, {
    exit: 1,
    needle: "full 40-character",
  });
  expectRun(
    "browse.bad",
    "lazycc browse --ref <missing> explains it",
    lazy("browse bad ref", ["browse", repoName, "--ref", "no-such-branch"]),
    { exit: 1, needle: "has no branch or commit" },
  );
  for (const r of [root, file, atShort]) if (r.json?.url) manual.push(`Browse page: ${r.json.url}`);
}

function clones() {
  const id = state.pr1;
  const tryClone = (protocol, why) => {
    if (why)
      return record(
        `clone.${protocol}`,
        `lazycc clone --protocol ${protocol} + pr checkout`,
        "SKIP",
        why,
      );
    const dir = join(work, `clone-${protocol}`);
    const c = lazy(`clone ${protocol}`, ["clone", repoName, dir, "--protocol", protocol]);
    expectRun(`clone.${protocol}`, `lazycc clone --protocol ${protocol}`, c);
    if (c.exit !== 0) return;
    record(
      `clone.${protocol}.url`,
      `origin URL of the ${protocol} clone`,
      "INFO",
      git(dir, "remote", "get-url", "origin").stdout.trim(),
    );
    const list = lazy(`pr list in ${protocol} clone`, ["pr", "list", "--json"], { cwd: dir });
    expectRun(
      `clone.${protocol}.context`,
      `lazycc pr list reads repository/region from the ${protocol} origin`,
      list,
    );
    const co = lazy(`pr checkout in ${protocol} clone`, ["pr", "checkout", id, "--json"], {
      cwd: dir,
    });
    expectRun(`checkout.${protocol}`, `lazycc pr checkout in the ${protocol} clone`, co);
    const head = git(dir, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    record(
      `checkout.${protocol}.branch`,
      "checked out the PR's source branch",
      head === "feature/one" ? "PASS" : "FAIL",
      head,
    );
  };
  const notCodeCommit = "AWS Emulator's clone URL is not a CodeCommit URL (repo.cloneUrlHttp)";
  tryClone("https", emulator ? notCodeCommit : undefined);
  tryClone(
    "grc",
    mock || emulator || which("git-remote-codecommit")
      ? undefined
      : "pip install git-remote-codecommit",
  );
  tryClone(
    "ssh",
    emulator ? notCodeCommit : opt.ssh ? undefined : "pass --ssh once an IAM SSH key is set up",
  );
}

/** Starts a TUI under `script` (a real pty), presses q, and checks it drew and quit. */
async function tui() {
  const scriptOk =
    process.platform === "linux" && sh("script", ["--version"]).stdout.includes("util-linux");
  if (opt["no-tui"] || !scriptOk)
    return record(
      "tui",
      "TUI start checks",
      "SKIP",
      opt["no-tui"] ? "--no-tui" : "needs util-linux script (Linux)",
    );
  const screens = [
    ["tui.review", "review screen (pr view)", ["pr", "view", state.pr1], "line 2"],
    ["tui.list", "PR list screen (pr list)", ["pr", "list"], "Change line 2"],
    ["tui.branch", "branch screen", ["branch"], "feature/one"],
    ["tui.browse", "browse screen", ["browse"], "README.md"],
    ["tui.home", "home screen", [], "Your PRs (2)"],
  ];
  for (const [id, title, args, needle] of screens) {
    const cmd = `stty cols 120 rows 40; exec ${[process.execPath, cli, ...args].map(quote).join(" ")}`;
    const child = spawn("script", ["-qec", cmd, "/dev/null"], {
      cwd: state.seed,
      env: { ...baseEnv, TERM: "xterm-256color" },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    const started = Date.now();
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    // Wait for the first frame, then press q (twice: the review screen backs out of a pane first).
    for (const at of [12_000, 15_000, 18_000]) {
      await Promise.race([sleep(at - (Date.now() - started)), exited]);
      if (child.exitCode !== null) break;
      child.stdin.write("q");
    }
    const code = await exited;
    clearTimeout(timer);
    const text = out.replace(ESCAPES, "");
    runs.push({
      label: id,
      argv: `script: lazycc ${args.join(" ")}`,
      cwd: "$WORK/seed",
      exit: code,
      ms: Date.now() - started,
      stdout: text.slice(-3000),
      stderr: "",
    });
    const drew = text.includes(needle);
    record(
      id,
      `${title} draws and quits on q`,
      code === 0 && drew ? "PASS" : "FAIL",
      `exit ${code}${drew ? "" : `, no "${needle}" on screen`}`,
    );
  }
}

async function failures() {
  const sso = opt["sso-expired-profile"];
  if (!sso)
    record(
      "sso",
      "Expired SSO session message",
      "SKIP",
      "pass --sso-expired-profile after aws sso logout",
    );
  else {
    const r = lazy("pr list (expired SSO)", ["pr", "list", "--repo", repoName], { profile: sso });
    expectRun("sso", "lazycc with an expired SSO session says to sign in again", r, {
      exit: 1,
      needle: "aws sso login",
    });
    const raw = await api(
      "GetRepository (expired SSO)",
      new cc.GetRepositoryCommand({ repositoryName: repoName }),
      client(sso),
    );
    record(
      "sso.raw",
      "SDK error for the expired SSO session",
      "INFO",
      raw.ok ? "succeeded (still signed in?)" : `${raw.name}: ${raw.message}`,
    );
  }
  const limited = opt["limited-profile"];
  if (!limited)
    record("denied", "Access denied names the missing action", "SKIP", "pass --limited-profile");
  else {
    const r = lazy("pr list (no permission)", ["pr", "list", "--repo", repoName], {
      profile: limited,
    });
    expectRun("denied", "lazycc names the refused codecommit: action", r, {
      exit: 1,
      needle: /codecommit:\w+/,
    });
  }
  expectRun(
    "repo.unknown",
    "lazycc pr list on a repository that does not exist",
    lazy("pr list (no repo)", ["pr", "list", "--repo", `${repoName}-absent`]),
    { exit: 1 },
  );
  manual.push(
    "GovCloud / China only: lazycc builds https://<region>.console.aws.amazon.com/... (cn-*: console.amazonaws.cn); compare with the real console URL.",
  );
  manual.push(
    "Review screen (inline comments): run `lazycc pr view <id>` inside a clone during --keep and check that the BEFORE-side comment on src/a.txt line 1 sits on the same line as in the console.",
  );
}

// ADR 0010: CI results. Reads an existing project's and pipeline's recent runs
// (nothing is started or changed there), checks the fields lazycc matches on,
// then runs pr view with the config's ci pointing at them.
const SHA = /^[0-9a-f]{40}$/;
const BUILD_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "FAULT",
  "TIMED_OUT",
  "IN_PROGRESS",
  "STOPPED",
]);
const EXECUTION_STATUSES = new Set([
  "Succeeded",
  "Failed",
  "InProgress",
  "Stopping",
  "Stopped",
  "Cancelled",
  "Superseded",
]);

/** Who started a build, by kind only: a hand-started build names the IAM user or session. */
function initiatorKind(initiator) {
  if (!initiator) return "none";
  const service = /^(codepipeline|events\.amazonaws\.com|GitHub-Hookshot)/.exec(initiator);
  return service ? service[1] : "principal";
}

async function ciResults() {
  const project = opt["ci-project"];
  const pipeline = opt["ci-pipeline"];
  if (!project && !pipeline)
    return record(
      "ci",
      "CI results (ADR 0010)",
      "SKIP",
      "pass --ci-project and/or --ci-pipeline (existing ones; realcheck only reads them)",
    );
  const sdk = { region, ...(opt.profile ? { profile: opt.profile } : {}), maxAttempts: 2 };
  if (project) {
    const cb = new CodeBuildClient(sdk);
    const list = await api(
      "ListBuildsForProject",
      new ListBuildsForProjectCommand({ projectName: project, sortOrder: "DESCENDING" }),
      cb,
    );
    const ids = list.ok ? (list.out.ids ?? []).slice(0, 5) : [];
    if (!list.ok) record("ci.codebuild", `Builds of ${project}`, "FAIL", ok(list));
    else if (ids.length === 0)
      record("ci.codebuild", `Builds of ${project}`, "SKIP", "no builds yet");
    else {
      const got = await api("BatchGetBuilds", new BatchGetBuildsCommand({ ids }), cb);
      const builds = got.ok ? (got.out.builds ?? []) : [];
      const odd = builds.flatMap((b) => {
        const why = [];
        if (!BUILD_STATUSES.has(b.buildStatus)) why.push(`buildStatus ${b.buildStatus}`);
        if (!/^\d{12}$/.test(String(b.arn).split(":")[4] ?? "")) why.push("arn without an account");
        if (!SHA.test(b.resolvedSourceVersion ?? ""))
          why.push(`resolvedSourceVersion ${b.resolvedSourceVersion}`);
        return why.length ? [`${b.id}: ${why.join(", ")}`] : [];
      });
      if (!got.ok) record("ci.codebuild", `Builds of ${project}`, "FAIL", ok(got));
      else
        record(
          "ci.codebuild",
          "Builds carry a known buildStatus, an ARN with the account, and a 40-hex resolvedSourceVersion (aws/ci.ts)",
          odd.length ? "DIFF" : "PASS",
          odd.length ? odd.join("; ") : `${builds.length} builds`,
        );
      record(
        "ci.codebuild.source",
        "Source types and initiator kinds of those builds",
        "INFO",
        builds.map((b) => `${b.source?.type}/${initiatorKind(b.initiator)}`).join(", "),
      );
    }
  }
  if (pipeline) {
    const cp = new CodePipelineClient(sdk);
    const list = await api(
      "ListPipelineExecutions",
      new ListPipelineExecutionsCommand({ pipelineName: pipeline, maxResults: 5 }),
      cp,
    );
    const executions = list.ok ? (list.out.pipelineExecutionSummaries ?? []) : [];
    if (!list.ok) record("ci.codepipeline", `Executions of ${pipeline}`, "FAIL", ok(list));
    else if (executions.length === 0)
      record("ci.codepipeline", `Executions of ${pipeline}`, "SKIP", "no executions yet");
    else {
      const odd = executions.flatMap((e) => {
        const why = [];
        if (!EXECUTION_STATUSES.has(e.status)) why.push(`status ${e.status}`);
        const revs = (e.sourceRevisions ?? []).map((r) => r.revisionId);
        if (!revs.some((r) => SHA.test(r ?? "")))
          why.push(`no 40-hex revisionId in [${revs.join(", ")}]`);
        return why.length ? [`${e.pipelineExecutionId}: ${why.join(", ")}`] : [];
      });
      record(
        "ci.codepipeline",
        "Executions carry a known status and a commit ID among sourceRevisions (aws/ci.ts)",
        odd.length ? "DIFF" : "PASS",
        odd.length ? odd.join("; ") : `${executions.length} executions`,
      );
    }
  }

  const configFile = join(work, "config", "lazycc", "config.json");
  const ci = (suffix) => ({
    ...(project ? { codebuild: [`${project}${suffix}`] } : {}),
    ...(pipeline ? { codepipeline: [`${pipeline}${suffix}`] } : {}),
  });
  mkdirSync(dirname(configFile), { recursive: true });
  try {
    writeFileSync(configFile, JSON.stringify({ ci: { [repoName]: ci("") } }));
    const view = lazy("pr view (ci)", ["pr", "view", state.pr1, "--json"], { cwd: state.seed });
    const found = view.json?.checks?.runs ?? [];
    // This repository's commits are new, so no run of an existing project matches them.
    if (view.exit !== 0 || found.length === 0 || found.some((r) => r.state !== "none"))
      record(
        "ci.view",
        "pr view with ci reads the runs and finds none on the PR's commit",
        "FAIL",
        `exit ${view.exit}: ${trim(JSON.stringify(view.json?.checks ?? view.stderr), 400)}`,
      );
    else
      record(
        "ci.view",
        "pr view with ci reads the runs and finds none on the PR's commit",
        "PASS",
        `${view.ms} ms`,
      );
    writeFileSync(configFile, JSON.stringify({ ci: { [repoName]: ci("-absent") } }));
    const absent = lazy("pr view (ci, absent)", ["pr", "view", state.pr1, "--json"], {
      cwd: state.seed,
    });
    const errors = (absent.json?.checks?.runs ?? []).filter((r) => r.state === "error");
    record(
      "ci.absent",
      "A misspelt project or pipeline is an error line, and pr view still exits 0",
      absent.exit === 0 && errors.length === found.length && found.length > 0 ? "PASS" : "FAIL",
      errors.map((r) => `${r.provider}: ${r.message}`).join("; ") || `exit ${absent.exit}`,
    );
  } finally {
    rmSync(configFile, { force: true });
  }
  manual.push(
    "CI results: run `lazycc pr view <id>` on a PR whose source commit a listed project built, and open the build or execution URL it prints; it should land on that run's page.",
  );
}

async function close() {
  const r = lazy("pr close", ["pr", "close", state.pr1, "--json"], { cwd: state.seed });
  expectRun("pr.close", "lazycc pr close", r);
  expectRun(
    "pr.list.closed",
    "lazycc pr list --state closed",
    lazy("pr list closed", ["pr", "list", "--state", "closed", "--json"], { cwd: state.seed }),
  );
  expectRun(
    "status",
    "lazycc status --json",
    lazy("status", ["status", "--json"], { cwd: state.seed }),
  );
}

async function cleanup() {
  if (!state.created) return;
  if (opt.keep)
    return record(
      "cleanup",
      "Delete the test repository",
      "SKIP",
      `--keep: delete it later with aws codecommit delete-repository --repository-name ${repoName}`,
    );
  if (!repoName.startsWith(PREFIX))
    throw new Error("refusing to delete a repository realcheck did not name");
  const r = await api(
    "DeleteRepository",
    new cc.DeleteRepositoryCommand({ repositoryName: repoName }),
  );
  record(
    "cleanup",
    "Delete the test repository",
    r.ok ? "PASS" : "FAIL",
    r.ok ? repoName : `${r.name}: ${r.message} — delete ${repoName} by hand`,
  );
}

// ---------------------------------------------------------------- report

function report() {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const lines = [
    "# lazycc realcheck report",
    "",
    `- Date: ${new Date().toISOString()}`,
    `- lazycc: ${sh(process.execPath, [cli, "--version"]).stdout.trim()} (${cli.replace(ROOT, ".")}), commit ${sh("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).stdout.trim()}`,
    `- Target: ${targetName}, region ${region}, repository ${repoName}`,
    `- Totals: ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    "",
    "DIFF = CodeCommit answered differently from what lazycc's code assumes. FAIL = lazycc itself misbehaved.",
    "",
    ...(emulator
      ? [
          "This run talked to AWS Emulator, not AWS: a DIFF or FAIL may come from AWS Emulator, and a PASS confirms nothing about real AWS.",
          "",
        ]
      : []),
    "## Differences and failures",
    "",
    ...(results.some((r) => r.status === "DIFF" || r.status === "FAIL")
      ? results
          .filter((r) => r.status === "DIFF" || r.status === "FAIL")
          .map((r) => `- **${r.status}** \`${r.id}\` ${r.title}: ${r.detail}`)
      : ["None."]),
    "",
    "## lastActivityDate (ADR 0006)",
    "",
    row(["actor", "action", "result", "before", "after", "moved"]),
    row(["---", "---", "---", "---", "---", "---"]),
    ...activity.map((a) =>
      row([a.actor, a.action, a.outcome, a.before, a.after, a.moved ? "yes" : "**no**"]),
    ),
    "",
    "## Check by hand",
    "",
    "Open these while signed in to the console (they stay valid only with --keep), and note anything wrong when you paste this report back:",
    "",
    ...manual.map((m) => `- [ ] ${m}`),
    "",
    "## All checks",
    "",
    row(["status", "id", "check", "detail"]),
    row(["---", "---", "---", "---"]),
    ...results.map((r) => row([r.status, r.id, r.title, trim(r.detail, 300)])),
    "",
    "## lazycc runs",
    "",
    ...runs.flatMap((r) => [
      `### ${r.label}`,
      "",
      `\`${r.argv}\` in \`${r.cwd}\` → exit ${r.exit}, ${r.ms} ms`,
      "",
      ...(r.stdout.trim() ? [block("", trim(r.stdout.trim(), 3000))] : []),
      ...(r.stderr.trim() ? ["stderr:", "", block("", trim(r.stderr.trim(), 2000))] : []),
      "",
    ]),
    "## CodeCommit responses (first of each call)",
    "",
    ...Object.entries(captures).flatMap(([k, v]) => [
      `### ${k}`,
      "",
      block("json", trim(JSON.stringify(v, null, 2), 4000)),
      "",
    ]),
  ];
  let text = lines.join("\n");
  if (!opt["no-redact"]) {
    text = redactPrincipals(text);
    if (account) text = text.replaceAll(account, "<ACCOUNT>");
    text = text.replace(/(arn:aws[\w-]*:[\w-]+:[\w-]*:)\d{12}(?=:)/g, "$1<ACCOUNT>");
  }
  writeFileSync(reportPath, text);
}

/** A name is replaced only where none of these borders it; "." and "," end a sentence or list item. */
const NAME_CHAR = /[\w+=@-]/;

/**
 * The report is pasted back into chats, so IAM user and session names (often an
 * email) go: in every user/… and assumed-role/Role/… ARN, then wherever lazycc
 * printed the name alone (Author: alice, Reviewer/bob: …). Role names stay.
 */
function redactPrincipals(text) {
  const names = new Map();
  const arn =
    /(arn:aws[\w-]*:(?:iam|sts)::[^:\s]*:)(user\/|assumed-role\/[\w+=,.@-]+\/)((?:[\w+=,.@-]+\/)*[\w+=,.@-]+)/g;
  text = text.replace(arn, (_, head, kind, name) => {
    const tag = kind === "user/" ? "<USER>" : "<SESSION>";
    names.set(name.split("/").at(-1), tag);
    return `${head}${kind}${tag}`;
  });
  for (const [name, tag] of names) text = replaceName(text, name, tag);
  return text;
}

function replaceName(text, name, tag) {
  let out = "";
  let from = 0;
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1] ?? "";
    const after = text[at + name.length] ?? "";
    if (NAME_CHAR.test(before) || NAME_CHAR.test(after)) continue;
    out += text.slice(from, at) + tag;
    from = at + name.length;
  }
  return out + text.slice(from);
}

// ---------------------------------------------------------------- main

let failed = false;
if (!existsSync(cli)) {
  console.error(`realcheck: ${cli} not found; run \`bun run build\` first or pass --lazycc`);
  process.exit(2);
}
if (!(await confirm())) process.exit(1);
/** Cleanup and report run once, whether the steps end, throw, or a signal stops them. */
let finishing;
function finish() {
  finishing ??= (async () => {
    try {
      await cleanup();
    } catch (error) {
      record("cleanup", "Delete the test repository", "FAIL", error.message);
    }
    report();
    if (!opt.keep) rmSync(work, { recursive: true, force: true });
  })();
  return finishing;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    record("abort", "Run stopped early", "FAIL", `stopped by ${signal}`);
    await finish();
    console.log(`\nrealcheck: stopped. Report: ${reportPath}`);
    process.exit(130);
  });
}

try {
  await environment();
  pack();
  await createRepository();
  seed();
  await pullRequests();
  await browse();
  clones();
  await lastActivity();
  await approvals();
  await draftTokens();
  await tui();
  await merges();
  await failures();
  await ciResults();
  await commentLimits();
  await close();
  await renames();
} catch (error) {
  failed = true;
  record("abort", "Run stopped early", "FAIL", error.stack ?? error);
}
await finish();
const bad = results.filter((r) => r.status === "FAIL").length;
const diff = results.filter((r) => r.status === "DIFF").length;
console.log(`\nrealcheck: ${bad} FAIL, ${diff} DIFF. Report: ${reportPath}`);
if (failed || bad > 0) process.exit(1);
