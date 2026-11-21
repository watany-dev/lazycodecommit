#!/usr/bin/env node
// lazycc perf check on real CodeCommit (docs/dev/real-aws-check.md). Read-only:
// lists, gets and reads; creates, changes and deletes nothing. After `bun run build`:
//   bun run perf:real -- --region ap-northeast-1 [--repo <name>] [--pr <id>] [--profile <p>]
// Prints about 35 lines, sized for a photo of the terminal. Takes 1–3 minutes.
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  CodeCommitClient,
  GetCommentReactionsCommand,
  GetCommentsForPullRequestCommand,
  GetPullRequestCommand,
  ListPullRequestsCommand,
  ListRepositoriesCommand,
} from "@aws-sdk/client-codecommit";

const { values: opt } = parseArgs({
  options: {
    region: { type: "string" },
    repo: { type: "string" },
    pr: { type: "string" },
    profile: { type: "string" },
  },
});
if (!opt.region) throw new Error("pass --region");
const client = new CodeCommitClient({
  region: opt.region,
  ...(opt.profile ? { profile: opt.profile } : {}),
  maxAttempts: 1,
});
const out = [];
const log = (s) => out.push(s);
const ms = (a) => `${a.toFixed(0)} ms`;
const pct = (xs, p) =>
  xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

async function timed(fn) {
  const t = performance.now();
  try {
    await fn();
    return { ms: performance.now() - t };
  } catch (e) {
    return { ms: performance.now() - t, error: e.name };
  }
}

log(`# lazycc perf (real CodeCommit, ${opt.region}, Node ${process.version})\n`);
const repos =
  (await client.send(new ListRepositoriesCommand({}))).repositories?.map((r) => r.repositoryName) ??
  [];
const repo = opt.repo ?? repos[0];
if (!repo) throw new Error("no repository in this region");
const open =
  (
    await client.send(
      new ListPullRequestsCommand({ repositoryName: repo, pullRequestStatus: "OPEN" }),
    )
  ).pullRequestIds ?? [];
const closed =
  (
    await client.send(
      new ListPullRequestsCommand({ repositoryName: repo, pullRequestStatus: "CLOSED" }),
    )
  ).pullRequestIds ?? [];
const ids = [...open, ...closed].slice(0, 40);
log(
  `Repository: (redacted), ${repos.length} repositories in region, ${open.length} open / ${closed.length}+ closed PRs\n`,
);

log(
  "## 1. Latency per call (serial)\n\n| Call | n | p50 | p90 | max | errors |\n| --- | --- | --- | --- | --- | --- |",
);
async function serial(label, n, make) {
  const t = [],
    errs = [];
  for (let i = 0; i < n; i++) {
    const r = await timed(() => client.send(make(i)));
    t.push(r.ms);
    if (r.error) errs.push(r.error);
  }
  log(
    `| ${label} | ${n} | ${ms(pct(t, 0.5))} | ${ms(pct(t, 0.9))} | ${ms(Math.max(...t))} | ${[...new Set(errs)].join(", ") || "-"} |`,
  );
}
await serial(
  "ListPullRequests",
  10,
  () => new ListPullRequestsCommand({ repositoryName: repo, pullRequestStatus: "OPEN" }),
);
if (ids.length)
  await serial(
    "GetPullRequest",
    20,
    (i) => new GetPullRequestCommand({ pullRequestId: ids[i % ids.length] }),
  );

log(
  "\n## 2. GetPullRequest burst at rising concurrency\n\n| in flight | calls | wall | per call | throttled |\n| --- | --- | --- | --- | --- |",
);
for (const c of ids.length ? [1, 4, 8, 16, 32] : []) {
  const n = Math.max(c * 4, 20);
  let next = 0,
    throttled = 0;
  const t = performance.now();
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (next < n) {
        const i = next++;
        const r = await timed(() =>
          client.send(new GetPullRequestCommand({ pullRequestId: ids[i % ids.length] })),
        );
        if (r.error === "ThrottlingException") throttled++;
      }
    }),
  );
  const wall = performance.now() - t;
  log(`| ${c} | ${n} | ${ms(wall)} | ${ms(wall / n)} | ${throttled} |`);
}

log("\n## 3. Comments and reactions (#101)\n");
let best;
for (const id of opt.pr ? [opt.pr] : ids.slice(0, 10)) {
  const all = [];
  let nextToken;
  do {
    const r = await client.send(
      new GetCommentsForPullRequestCommand({ pullRequestId: id, nextToken }),
    );
    for (const d of r.commentsForPullRequestData ?? []) all.push(...(d.comments ?? []));
    nextToken = r.nextToken;
  } while (nextToken);
  if (!best || all.length > best.comments.length) best = { id, comments: all };
}
if (best?.comments.length) {
  const withField = best.comments.filter((c) => c.reactionCounts !== undefined).length;
  const reacted = best.comments.filter((c) =>
    Object.values(c.reactionCounts ?? {}).some((n) => n > 0),
  );
  log(
    `PR with most comments: ${best.comments.length} comments; reactionCounts present on ${withField}; counting a reaction on ${reacted.length}.`,
  );
  const sample = best.comments.slice(0, 15);
  let mismatch = 0;
  for (const c of sample) {
    const r = await client.send(new GetCommentReactionsCommand({ commentId: c.commentId }));
    const has = (r.reactionsForComment ?? []).some(
      (x) => (x.reactionUsers?.length ?? 0) + (x.reactionsFromDeletedUsersCount ?? 0) > 0,
    );
    const counted =
      c.reactionCounts === undefined || Object.values(c.reactionCounts).some((n) => n > 0);
    if (has && !counted) mismatch++;
  }
  log(
    `GetCommentReactions on ${sample.length} comments: ${mismatch} have reactions that reactionCounts does not count (must be 0).`,
  );
  if (reacted[0]) log(`Example reactionCounts: \`${JSON.stringify(reacted[0].reactionCounts)}\``);
} else log("No comments found on the first 10 PRs; pass --pr <id> of a PR with comments.");

log("\n## 4. lazycc commands (median of 3)\n\n| Command | wall | exit |\n| --- | --- | --- |");
const lazy = (args) => {
  const t = performance.now();
  const r = spawnSync(
    process.execPath,
    [
      "dist/cli.mjs",
      ...args,
      "--region",
      opt.region,
      ...(opt.profile ? ["--profile", opt.profile] : []),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return { ms: performance.now() - t, code: r.status };
};
for (const args of [
  ["--version"],
  ["status", "--json", "-R", repo],
  ["pr", "list", "-R", repo],
  ["pr", "list", "--state", "closed", "-R", repo],
  ...(ids[0] ? [["pr", "view", ids[0], "-R", repo, "--json"]] : []),
]) {
  const runs = [lazy(args), lazy(args), lazy(args)];
  log(
    `| lazycc ${args.join(" ").replace(repo, "<repo>")} | ${ms(
      pct(
        runs.map((r) => r.ms),
        0.5,
      ),
    )} | ${runs.map((r) => r.code).join("/")} |`,
  );
}
console.log(out.join("\n"));
