// Runs the parts of a built package that `--version` never loads, on the Node
// running this script (CI runs it on every Node in the matrix, the lowest
// being engines.node, where Vitest cannot run):
// - the AWS SDK chunks: real requests and responses against a stand-in
//   endpoint for CodeCommit and STS, and for CodeBuild and CodePipeline,
//   which only the config's ci loads;
// - git subprocesses: commands run inside a throwaway clone whose origin is a
//   CodeCommit URL;
// - state files and their locks: two `status` runs at once, against a held
//   lock and a stale one;
// - the TUI chunk (Ink and React) and its raw stdin: opened on a
//   pseudo-terminal, typed at in bursts, and quit with `q`.
// The unit tests run the sources; this runs what the bundler produced.
// Usage: node scripts/smoke-dist.mjs [path/to/bin]   (default: dist/cli.mjs)
// Needs git, and python3 for the pseudo-terminal (its pty module; Linux and macOS).
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const bin = process.argv[2] ?? fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const TIMEOUT_MS = 15_000;
const ARN = "arn:aws:iam::123456789012:user/smoke";

// CodeCommit, CodeBuild and CodePipeline speak JSON 1.1: POST / with the
// operation in X-Amz-Target. STS speaks the query protocol: a form body with
// Action=..., answered in XML. "smoke" has no open pull requests, "smoke-tui" three.
const RESPONSES = {
  ListPullRequests: (input) => ({
    pullRequestIds: input.repositoryName === "smoke-tui" ? ["1", "2", "3"] : [],
  }),
  GetPullRequest: (input) => ({
    pullRequest: {
      pullRequestId: input.pullRequestId,
      title: "smoke",
      pullRequestStatus: "OPEN",
      creationDate: 1_700_000_000,
      pullRequestTargets: [
        { repositoryName: "smoke", sourceReference: "refs/heads/topic", sourceCommit: "c1" },
      ],
    },
  }),
  ListBuildsForProject: { ids: ["check:1"] },
  BatchGetBuilds: {
    builds: [{ id: "check:1", buildStatus: "SUCCEEDED", resolvedSourceVersion: "c1" }],
  },
  ListPipelineExecutions: { pipelineExecutionSummaries: [] },
};
const CALLER_IDENTITY = `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>${ARN}</Arn><UserId>SMOKE</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>smoke</RequestId></ResponseMetadata></GetCallerIdentityResponse>`;
const seen = [];
const server = createServer((req, res) => {
  let request = "";
  req.on("data", (d) => (request += d));
  req.on("end", () => {
    const target = String(req.headers["x-amz-target"] ?? "");
    if (!target && new URLSearchParams(request).get("Action") === "GetCallerIdentity") {
      seen.push("GetCallerIdentity");
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(CALLER_IDENTITY);
      return;
    }
    const op = target.split(".").pop() ?? "";
    seen.push(op);
    const answer = RESPONSES[op];
    const body = typeof answer === "function" ? answer(parse(request) ?? {}) : answer;
    res.writeHead(body ? 200 : 400, { "content-type": "application/x-amz-json-1.1" });
    res.end(JSON.stringify(body ?? { __type: "InvalidRequestException", message: `smoke: ${op}` }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// Static keys, no profile files and no retries: nothing reaches AWS or the
// user's own configuration (git's included), and state goes to a temporary directory.
const work = mkdtempSync(join(tmpdir(), "lazycc-smoke-"));
const config = join(work, "config");
const stateDir = join(work, "state", "lazycc");
mkdirSync(join(config, "lazycc"), { recursive: true });
writeFileSync(
  join(config, "lazycc", "config.json"),
  JSON.stringify({ ci: { smoke: { codebuild: ["check"], codepipeline: ["release"] } } }),
);
const env = {
  XDG_CONFIG_HOME: config,
  XDG_STATE_HOME: join(work, "state"),
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TERM: "xterm-256color",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  AWS_ACCESS_KEY_ID: "smoke",
  AWS_SECRET_ACCESS_KEY: "smoke",
  AWS_REGION: "us-east-1",
  AWS_ENDPOINT_URL: `http://127.0.0.1:${port}`,
  AWS_MAX_ATTEMPTS: "1",
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
};

const children = new Set();
function start(cmd, args, cwd) {
  const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.result = new Promise((resolve) => {
    let out = "";
    let stdout = "";
    child.stdout.on("data", (d) => {
      out += d;
      stdout += d;
    });
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, stdout });
    });
  });
  return child;
}
const lazycc = (args, cwd) => start(process.execPath, [bin, ...args], cwd);

function fail(what, r = { code: null, signal: null, out: "" }) {
  console.error(
    "smoke-dist: %s (exit %s%s)\n%s",
    what,
    r.code,
    r.signal ? `, ${r.signal}` : "",
    r.out,
  );
  // A status still waiting on a lock would otherwise outlive this script.
  for (const child of children) child.kill("SIGKILL");
  server.close();
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// 1. The SDK chunk: pr list off a terminal sends ListPullRequests and reads the answer.
const list = await lazycc(["pr", "list", "--repo", "smoke"]).result;
if (list.code !== 0 || !list.out.includes("No open pull requests in smoke."))
  fail("pr list did not complete against the stand-in endpoint", list);
if (!seen.includes("ListPullRequests")) fail("pr list sent no ListPullRequests", list);

// 2. The CI chunk: pr view on a repository the config's ci lists reads its runs.
seen.length = 0;
const view = await lazycc(["pr", "view", "1", "--repo", "smoke", "--json"]).result;
// stdout alone: on Node 20 the SDK warns on stderr.
if (view.code !== 0 || parse(view.stdout)?.checks?.state !== "pass")
  fail("pr view did not read CI results from the stand-in endpoint", view);
if (!seen.includes("ListPipelineExecutions")) fail("pr view sent no ListPipelineExecutions", view);

// 3. git: a clone of "smoke" on a branch one commit ahead of origin/main, made
// locally (nothing is fetched). pr create --dry-run reads the repository from
// origin, then the branch, its commits and what origin lacks.
const clone = join(work, "clone");
mkdirSync(clone);
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.com", ...args], {
    cwd: clone,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
git("init", "-q", "-b", "main");
git("commit", "-q", "--allow-empty", "-m", "base");
git("update-ref", "refs/remotes/origin/main", "HEAD");
git("remote", "add", "origin", "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/smoke");
git("switch", "-q", "-c", "topic");
git("commit", "-q", "--allow-empty", "-m", "smoke subject", "-m", "smoke body");
const want = {
  dryRun: true,
  repository: "smoke",
  head: "topic",
  base: "main",
  title: "smoke subject",
  body: "smoke body",
  wouldPush: true,
};
const plan = await lazycc(["pr", "create", "--fill", "--dry-run", "--json", "-B", "main"], clone)
  .result;
if (plan.code !== 0 || JSON.stringify(parse(plan.stdout)) !== JSON.stringify(want))
  fail(`pr create --dry-run in a clone did not print ${JSON.stringify(want)}`, plan);

// 4. State files: two status runs in the clone at once. Both save the caller's
// ARN to identity.json, whose lock is held here until both have asked STS for
// it, and the home list to cache.json, whose lock a dead process left a minute
// ago. Neither may write past the held lock; both must finish, leaving the two
// files and no lock or temporary file.
seen.length = 0;
mkdirSync(stateDir, { recursive: true });
const held = join(stateDir, "identity.json.lock");
const stale = join(stateDir, "cache.json.lock");
writeFileSync(held, "");
writeFileSync(stale, "");
const minuteAgo = new Date(Date.now() - 60_000);
utimesSync(stale, minuteAgo, minuteAgo);
const statuses = [lazycc(["status"], clone), lazycc(["status"], clone)];
const ended = () => statuses.find((c) => c.exitCode !== null || c.signalCode !== null);
const deadline = Date.now() + TIMEOUT_MS;
while (seen.filter((op) => op === "GetCallerIdentity").length < 2 && !ended()) {
  if (Date.now() > deadline) fail("status never asked STS for the caller");
  await sleep(20);
}
// Long enough for a write that ignored the lock to land.
await sleep(300);
const early = ended();
if (early) fail("status ended while identity.json was locked", await early.result);
if (existsSync(join(stateDir, "identity.json")))
  fail("status wrote identity.json past the held lock");
rmSync(held);
for (const r of await Promise.all(statuses.map((c) => c.result))) {
  if (r.code !== 0) fail("status in a clone failed", r);
}
const files = readdirSync(stateDir).toSorted().join(" ");
if (files !== "cache.json identity.json") fail(`status left "${files}" in the state directory`);
const identity = Object.values(parse(readFileSync(join(stateDir, "identity.json"), "utf8")) ?? {});
if (identity.length !== 1 || identity[0] !== ARN) fail("identity.json does not hold the ARN once");
if (!parse(readFileSync(join(stateDir, "cache.json"), "utf8"))?.home)
  fail("cache.json holds no home list");

// 5. The TUI chunk and keyStream: on a terminal a bare pr list opens the
// review screen. The pty helper (120x40) runs its steps in order: wait until
// the screen shows the text (an empty one does not wait), then write the
// bytes. It exits with the program's status, or 3 when a text never showed.
// "jjk" in one write leaves the cursor on the second of three rows only if
// each key of a burst reaches the app on its own. Then the search gets "é" in
// two writes, one byte each, and Enter: it reads "é" only if a character split
// across reads is put back together.
const PTY = `
import fcntl, json, os, pty, select, struct, sys, termios, time
steps = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    os.execv(sys.argv[2], sys.argv[2:])
buf, step, deadline = b"", 0, time.time() + 10
while step < len(steps) and time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
    wait, data = steps[step]
    if wait.encode() in buf:
        time.sleep(0.3 if wait else 0)
        os.write(fd, bytes.fromhex(data))
        buf, step = b"", step + 1
sys.stdout.write(buf.decode("utf-8", "replace"))
if step < len(steps):
    print("\\npty: the screen never showed %r" % steps[step][0])
    os.kill(pid, 9)
    sys.exit(3)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
const e = Buffer.from("é");
const hex = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p))).toString("hex");
const steps = [
  ["Open Pull Requests", hex("jjk")],
  ["> #2", hex("/")],
  ["Search:", hex(e.subarray(0, 1))],
  ["", hex(e.subarray(1), "\r")],
  ['Open Pull Requests matching "é"', hex("q")],
];
seen.length = 0;
const tui = await start("python3", [
  "-c",
  PTY,
  JSON.stringify(steps),
  process.execPath,
  bin,
  "pr",
  "list",
  "--repo",
  "smoke-tui",
]).result;
if (tui.code !== 0) fail("the review screen did not open, take a burst of keys, and quit", tui);
if (!seen.includes("ListPullRequests")) fail("the review screen sent no ListPullRequests", tui);

server.close();
rmSync(work, { recursive: true, force: true });
console.log(
  `smoke-dist: ok (${process.version}; SDK requests, CI results, git, state files, the review screen and its keys)`,
);
