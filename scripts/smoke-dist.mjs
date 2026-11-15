// Runs the parts of a built package that `--version` never loads: the AWS SDK
// chunks (real requests and responses against a stand-in endpoint for
// CodeCommit, and for CodeBuild and CodePipeline, which only the config's ci loads)
// and the TUI chunk (Ink and React, opened on a pseudo-terminal and quit with
// `q`). The unit tests run the sources; this runs what the bundler produced.
// Usage: node scripts/smoke-dist.mjs [path/to/bin]   (default: dist/cli.mjs)
// Needs python3 for the pseudo-terminal (its pty module; Linux and macOS).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = process.argv[2] ?? fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const TIMEOUT_MS = 15_000;

// CodeCommit speaks JSON 1.1: POST / with the operation in X-Amz-Target.
const RESPONSES = {
  ListPullRequests: { pullRequestIds: [] },
  GetPullRequest: {
    pullRequest: {
      pullRequestId: "1",
      title: "smoke",
      pullRequestStatus: "OPEN",
      pullRequestTargets: [
        { repositoryName: "smoke", sourceReference: "refs/heads/topic", sourceCommit: "c1" },
      ],
    },
  },
  ListBuildsForProject: { ids: ["check:1"] },
  BatchGetBuilds: {
    builds: [{ id: "check:1", buildStatus: "SUCCEEDED", resolvedSourceVersion: "c1" }],
  },
  ListPipelineExecutions: { pipelineExecutionSummaries: [] },
};
const seen = [];
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const op =
      String(req.headers["x-amz-target"] ?? "")
        .split(".")
        .pop() ?? "";
    seen.push(op);
    const body = RESPONSES[op];
    res.writeHead(body ? 200 : 400, { "content-type": "application/x-amz-json-1.1" });
    res.end(JSON.stringify(body ?? { __type: "InvalidRequestException", message: `smoke: ${op}` }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// Static keys, no profile files and no retries: nothing reaches AWS or the
// user's own configuration.
const config = mkdtempSync(join(tmpdir(), "lazycc-smoke-"));
mkdirSync(join(config, "lazycc"));
writeFileSync(
  join(config, "lazycc", "config.json"),
  JSON.stringify({ ci: { smoke: { codebuild: ["check"], codepipeline: ["release"] } } }),
);
const env = {
  XDG_CONFIG_HOME: config,
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TERM: "xterm-256color",
  AWS_ACCESS_KEY_ID: "smoke",
  AWS_SECRET_ACCESS_KEY: "smoke",
  AWS_REGION: "us-east-1",
  AWS_ENDPOINT_URL: `http://127.0.0.1:${port}`,
  AWS_MAX_ATTEMPTS: "1",
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
};

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

function fail(what, r) {
  console.error(
    "smoke-dist: %s (exit %s%s)\n%s",
    what,
    r.code,
    r.signal ? `, ${r.signal}` : "",
    r.out,
  );
  server.close();
  rmSync(config, { recursive: true, force: true });
  process.exit(1);
}

// 1. The SDK chunk: pr list off a terminal sends ListPullRequests and reads the answer.
const list = await run(process.execPath, [bin, "pr", "list", "--repo", "smoke"]);
if (list.code !== 0 || !list.out.includes("No open pull requests in smoke."))
  fail("pr list did not complete against the stand-in endpoint", list);
if (!seen.includes("ListPullRequests")) fail("pr list sent no ListPullRequests", list);

// 2. The CI chunk: pr view on a repository the config's ci lists reads its runs.
seen.length = 0;
const view = await run(process.execPath, [bin, "pr", "view", "1", "--repo", "smoke", "--json"]);
let checks;
try {
  checks = JSON.parse(view.out).checks;
} catch {}
if (view.code !== 0 || checks?.state !== "pass")
  fail("pr view did not read CI results from the stand-in endpoint", view);
if (!seen.includes("ListPipelineExecutions")) fail("pr view sent no ListPipelineExecutions", view);

// 3. The TUI chunk: on a terminal a bare pr list opens the review screen. The
// pty helper (120x40) waits for the list to draw, presses q, and exits with
// the program's status, or 3 when the list never drew.
const PTY = `
import fcntl, os, pty, select, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])
buf, sent, deadline = b"", False, time.time() + 10
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
    if not sent and b"Open Pull Requests" in buf:
        time.sleep(0.3)
        os.write(fd, b"q")
        sent = True
sys.stdout.write(buf.decode("utf-8", "replace"))
if not sent:
    os.kill(pid, 9)
    sys.exit(3)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
seen.length = 0;
const tui = await run("python3", [
  "-c",
  PTY,
  process.execPath,
  bin,
  "pr",
  "list",
  "--repo",
  "smoke",
]);
if (tui.code !== 0) fail("the review screen did not open and quit on q", tui);
if (!seen.includes("ListPullRequests")) fail("the review screen sent no ListPullRequests", tui);

server.close();
rmSync(config, { recursive: true, force: true });
console.log(`smoke-dist: ok (${process.version}; SDK requests, CI results and the review screen)`);
