import { type ParseArgsConfig, parseArgs } from "node:util";
import { version } from "../../package.json" with { type: "json" };
import type { CodeCommitApi } from "../aws/codecommit.js";
import { explainAwsError } from "../aws/errors.js";
import { branchActions, loadBranchTable } from "../core/branch.js";
import { cloneRepository } from "../core/clone.js";
import { type AccountContext, resolveAccountContext, resolveContext } from "../core/context.js";
import { UsageError, UserError } from "../core/errors.js";
import {
  fetchInbox,
  isPending,
  loadAllDetails,
  resolveMe,
  toCache,
  watchedRepositories,
} from "../core/inbox.js";
import {
  checkoutPullRequest,
  concurrency,
  consoleUrl,
  createPullRequest,
  listPullRequests,
  type PrDeps,
  pullRequestStatus,
  resolvePullRequest,
} from "../core/pr.js";
import { type Git, GitError } from "../git/git.js";
import { type Config, ConfigError, configPath } from "../state/config.js";
import type { LocalState } from "../state/local.js";
import type { BranchesRequest, ReviewRequest } from "../tui/index.js";
import {
  branchJson,
  branchLines,
  inboxJson,
  inboxLines,
  listLines,
  printable,
  prJson,
  statusLines,
  viewLines,
} from "./format.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** stdin and stdout are both a terminal. */
  readonly interactive: boolean;
  confirm(question: string): Promise<boolean>;
  edit(text: string): Promise<string>;
  readFile(path: string): Promise<string | null>;
}

export interface Deps {
  readonly io: Io;
  createGit(cwd: string): Git;
  createApi(options: { region?: string; profile?: string }): Promise<CodeCommitApi>;
  loadConfig(env: Readonly<Record<string, string | undefined>>): Promise<Config>;
  createState(env: Readonly<Record<string, string | undefined>>): LocalState;
  /** Open the TUI; cli.ts loads it lazily so other commands never load Ink. */
  openReview(request: ReviewRequest): Promise<void>;
  openBranches(request: BranchesRequest): Promise<void>;
}

export const USAGE = `lazycc - a daily-driver client for AWS CodeCommit

Usage:
  lazycc status
  lazycc pr create [-B base] [-H head] [-t title] [-b body | -F file] [--fill] [--push | --no-push] [--dry-run]
  lazycc pr list [--state open|closed] [-L limit]
  lazycc pr view [<id>]
  lazycc pr status
  lazycc pr checkout <id>
  lazycc branch
  lazycc clone <repo> [<dir>] [--protocol https|ssh|grc] [-- <git clone flags>]
  lazycc --version

Flags for every command:
  -R, --repo <name>     repository (default: the origin remote of this clone; not for clone)
      --profile <name>  AWS profile
      --region <region> AWS region
      --json            print JSON

Exit codes: 0 success, 1 error, 2 bad arguments.`;

type Options = NonNullable<ParseArgsConfig["options"]>;

const COMMON: Options = {
  profile: { type: "string" },
  region: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const REPO: Options = { repo: { type: "string", short: "R" } };

const COMMANDS: Record<string, { options: Options; positionals: number }> = {
  "pr create": {
    positionals: 0,
    options: {
      base: { type: "string", short: "B" },
      head: { type: "string", short: "H" },
      title: { type: "string", short: "t" },
      body: { type: "string", short: "b" },
      "body-file": { type: "string", short: "F" },
      fill: { type: "boolean" },
      push: { type: "boolean" },
      "no-push": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  },
  "pr list": {
    positionals: 0,
    options: { state: { type: "string", short: "s" }, limit: { type: "string", short: "L" } },
  },
  "pr view": { positionals: 1, options: {} },
  "pr status": { positionals: 0, options: {} },
  "pr checkout": { positionals: 1, options: {} },
  branch: { positionals: 0, options: {} },
  status: { positionals: 0, options: {} },
};

for (const spec of Object.values(COMMANDS)) Object.assign(spec.options, REPO);
// The repository is the positional argument, and `--` passes the rest to git clone.
COMMANDS["clone"] = { positionals: 2, options: { protocol: { type: "string" } } };

type Values = Record<string, string | boolean | undefined>;

function parse(
  command: string,
  args: readonly string[],
): { values: Values; positionals: string[] } {
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`Unknown command: ${command}`);
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...args],
      options: { ...COMMON, ...spec.options },
      allowPositionals: true,
      strict: true,
    }) as { values: Values; positionals: string[] };
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (parsed.positionals.length > spec.positionals) {
    throw new UsageError(`Unexpected argument: ${parsed.positionals[spec.positionals]}`);
  }
  return parsed;
}

const str = (v: Values, key: string) =>
  typeof v[key] === "string" ? (v[key] as string) : undefined;

export async function run(args: readonly string[], deps: Deps): Promise<number> {
  const { io } = deps;
  const [noun, verb, ...rest] = args;
  let profile: string | undefined;
  try {
    if (noun === "--version" || noun === "-v") {
      io.out(version);
      return 0;
    }
    if (noun === undefined || noun === "--help" || noun === "-h" || noun === "help") {
      io.out(USAGE);
      return 0;
    }
    let command: string;
    let commandArgs: readonly string[];
    if (noun === "pr") {
      if (verb === undefined || verb === "--help" || verb === "-h") {
        io.out(USAGE);
        return verb === undefined ? 2 : 0;
      }
      command = `pr ${verb}`;
      commandArgs = rest;
    } else {
      command = noun;
      commandArgs = args.slice(1);
    }
    let passthrough: string[] = [];
    if (command === "clone") {
      const dashes = commandArgs.indexOf("--");
      if (dashes !== -1) {
        passthrough = commandArgs.slice(dashes + 1);
        commandArgs = commandArgs.slice(0, dashes);
      }
    }
    const { values, positionals } = parse(command, commandArgs);
    if (values["help"]) {
      io.out(USAGE);
      return 0;
    }
    if (command === "clone") {
      if (positionals[0] === undefined) throw new UsageError("clone needs a repository name");
      values["repo"] = positionals[0];
      positionals.push(...passthrough);
    }
    if (command === "pr checkout" && positionals[0] === undefined) {
      throw new UsageError("pr checkout needs a pull request id");
    }
    return await runCommand(command, values, positionals, deps, (ctx) => {
      profile = ctx.profile;
    });
  } catch (error) {
    return report(error, io, profile);
  }
}

async function runCommand(
  command: string,
  values: Values,
  positionals: string[],
  deps: Deps,
  onContext: (ctx: AccountContext) => void,
): Promise<number> {
  const { io } = deps;
  const json = values["json"] === true;
  const config = await deps.loadConfig(io.env);
  const git = deps.createGit(io.cwd);
  const input = {
    ...optional("repo", str(values, "repo")),
    ...optional("region", str(values, "region")),
    ...optional("profile", str(values, "profile")),
    git,
    env: io.env,
    config,
  };
  if (command === "status") {
    // The config's repos live in the config's region and profile, not the remote's.
    const fromConfig = !input.repo && Boolean(config.repos?.length);
    const account = await resolveAccountContext({ ...input, outsideClone: fromConfig });
    onContext(account);
    return runStatus(str(values, "repo"), account, config, json, deps);
  }
  const ctx = await resolveContext(input);
  onContext(ctx);
  const api = await deps.createApi({
    ...optional("region", ctx.region),
    ...optional("profile", ctx.profile),
  });
  // For console URLs; also fails early, with advice, when no region is set anywhere.
  const region = ctx.region ?? (await api.region());
  const prDeps: PrDeps = {
    git,
    api,
    ctx,
    config,
    interactive: io.interactive,
    confirm: io.confirm,
    edit: io.edit,
    readFile: io.readFile,
    note: io.err,
  };
  const print = (value: unknown) => io.out(JSON.stringify(value, null, 2));
  // On a terminal, pr view and a bare pr list open the review screen instead of printing.
  const review = (start: ReviewRequest["start"]) =>
    deps.openReview({
      repository: ctx.repository,
      start,
      region,
      ...optional("profile", ctx.profile),
      ...(ctx.clone ? { git } : {}),
    });

  switch (command) {
    case "branch": {
      const branchDeps = { api, git, ctx, config };
      if (io.interactive && !json) {
        await deps.openBranches({
          actions: branchActions(branchDeps, region),
          region,
          ...optional("profile", ctx.profile),
          ...(ctx.clone ? { git } : {}),
          async createPullRequest(head) {
            try {
              const result = await createPullRequest(
                { head, fill: false, push: false, noPush: false, dryRun: false },
                prDeps,
              );
              // dry-run is off, so the result is a PR, new or already open.
              return { pullRequestId: (result as { pr: { id: string } }).pr.id };
            } catch (error) {
              return { message: describeError(error, ctx.profile) };
            }
          },
        });
        return 0;
      }
      const table = await loadBranchTable(branchDeps);
      if (json) print(branchJson(table));
      else for (const line of branchLines(table)) io.out(line);
      return 0;
    }
    case "clone": {
      const url = await cloneRepository(
        {
          repository: ctx.repository,
          ...optional("protocol", str(values, "protocol")),
          region,
          ...optional("profile", ctx.profile),
          args: positionals.slice(1),
        },
        { git, api },
      );
      if (json) print({ repository: ctx.repository, url });
      return 0;
    }
    case "pr checkout": {
      const result = await checkoutPullRequest(positionals[0] as string, prDeps);
      if (json)
        print({
          branch: result.branch,
          created: result.created,
          pullRequest: prJson(result.pr, region),
        });
      else
        io.err(
          result.created
            ? `Switched to a new branch ${result.branch} tracking origin/${result.branch} (#${result.pr.id}).`
            : `Switched to ${result.branch}, up to date with origin/${result.branch} (#${result.pr.id}).`,
        );
      return 0;
    }
    case "pr create": {
      const result = await createPullRequest(
        {
          ...optional("base", str(values, "base")),
          ...optional("head", str(values, "head")),
          ...optional("title", str(values, "title")),
          ...optional("body", str(values, "body")),
          ...optional("bodyFile", str(values, "body-file")),
          fill: values["fill"] === true,
          push: values["push"] === true,
          noPush: values["no-push"] === true,
          dryRun: values["dry-run"] === true,
        },
        prDeps,
      );
      if (result.kind === "dry-run") {
        const { kind: _, ...plan } = result;
        if (json) print({ dryRun: true, ...plan });
        else {
          io.out(
            `Would ${plan.wouldPush ? "push and " : ""}create a pull request in ${plan.repository}:`,
          );
          io.out(`  ${plan.head} → ${plan.base}`);
          io.out(`  title: ${plan.title}`);
          io.out(
            plan.body ? `  body:\n${plan.body.replace(/^(?=.)/gm, "    ")}` : "  body: (empty)",
          );
        }
        return 0;
      }
      const url = consoleUrl(region, result.pr.repository, result.pr.id);
      if (result.kind === "exists") {
        if (json) print({ existing: true, ...prJson(result.pr, region) });
        io.err(
          `A pull request from ${result.pr.sourceBranch} into ${result.pr.destinationBranch} is already open: #${result.pr.id} ${printable(result.pr.title)}`,
        );
        if (!json) io.err(url);
        return 1;
      }
      if (json) print(prJson(result.pr, region));
      else {
        io.out(`Created pull request #${result.pr.id}: ${result.pr.title}`);
        io.out(url);
      }
      return 0;
    }
    case "pr list": {
      if (
        io.interactive &&
        !json &&
        values["state"] === undefined &&
        values["limit"] === undefined
      ) {
        await review(null);
        return 0;
      }
      const state = (str(values, "state") ?? "open").toUpperCase();
      if (state !== "OPEN" && state !== "CLOSED")
        throw new UsageError("--state must be open or closed");
      const limitText = str(values, "limit") ?? "30";
      const limit = Number(limitText);
      if (!Number.isInteger(limit) || limit < 1)
        throw new UsageError(`--limit must be a positive integer: ${limitText}`);
      const prs = await listPullRequests({ state, limit }, prDeps);
      if (json) print(prs.map((pr) => prJson(pr, region)));
      else if (prs.length === 0)
        io.err(`No ${state.toLowerCase()} pull requests in ${ctx.repository}.`);
      else for (const line of listLines(prs)) io.out(line);
      return 0;
    }
    case "pr view": {
      const pr = await resolvePullRequest(positionals[0], prDeps);
      if (io.interactive && !json) {
        await review({ pullRequestId: pr.id });
        return 0;
      }
      if (json) print(prJson(pr, region));
      else for (const line of viewLines(pr, region)) io.out(line);
      return 0;
    }
    default: {
      const status = await pullRequestStatus(prDeps);
      if (json) {
        print({
          branch: status.branch,
          pullRequest: status.pr ? prJson(status.pr, region) : null,
          ...(status.pr
            ? {
                approvedBy: status.approvers,
                approvalRules: status.rules,
                mergeable: status.mergeable,
              }
            : {}),
        });
      } else for (const line of statusLines(status, region)) io.out(line);
      return 0;
    }
  }
}

/** `lazycc status`: the home screen as text (spec: ホーム). */
async function runStatus(
  flagRepo: string | undefined,
  ctx: AccountContext,
  config: Config,
  json: boolean,
  deps: Deps,
): Promise<number> {
  const { io } = deps;
  const repositories = watchedRepositories(
    flagRepo,
    config,
    ctx.clone ? ctx.repository : undefined,
  );
  if (!repositories) {
    throw new UserError(
      `No repositories to watch. Add "repos" to ${configPath(io.env)}, run inside a clone, or pass --repo.`,
    );
  }
  const api = await deps.createApi({
    ...optional("region", ctx.region),
    ...optional("profile", ctx.profile),
  });
  const region = ctx.region ?? (await api.region());
  const state = deps.createState(io.env);
  const me = await resolveMe(api, state.identity, ctx.profile, io.env);
  const limit = concurrency(config);
  const listed = await fetchInbox(repositories, {
    api,
    me,
    region,
    seen: await state.seen.all(),
    concurrency: limit,
  });
  const inbox = { ...listed, items: await loadAllDetails(listed.items, api, limit) };
  const items = inbox.items.filter((i) => isPending(i, me));
  if (json) io.out(JSON.stringify(inboxJson(inbox, items, region), null, 2));
  else for (const line of inboxLines(items)) io.out(line);
  for (const { repository, error } of inbox.errors) {
    io.err(`lazycc: ${repository}: ${explainAwsError(error, ctx.profile) ?? error.message}`);
  }
  const incomplete = inbox.items.filter((i) => i.detailError);
  for (const { pr, detailError } of incomplete) {
    io.err(`lazycc: ${pr.repository} #${pr.id}: could not load approvals or rules: ${detailError}`);
  }
  // The cache only speeds up the next TUI start; failing to write it is not an error.
  await state.cache.set("home", toCache(inbox, region)).catch(() => {});
  return inbox.errors.length > 0 || incomplete.length > 0 ? 1 : 0;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function report(error: unknown, io: Io, profile: string | undefined): number {
  if (error instanceof UsageError) {
    io.err(`lazycc: ${error.message}`);
    io.err("Run `lazycc --help` for usage.");
    return 2;
  }
  io.err(`lazycc: ${describeError(error, profile)}`);
  if (io.env["LAZYCC_DEBUG"] && error instanceof Error && error.stack) io.err(error.stack);
  return 1;
}

/** One line for the user, without the "lazycc: " prefix. */
function describeError(error: unknown, profile: string | undefined): string {
  if (
    error instanceof UsageError ||
    error instanceof UserError ||
    error instanceof ConfigError ||
    error instanceof GitError
  ) {
    return error.message;
  }
  const explained = explainAwsError(error, profile);
  if (explained) return explained;
  const e = error instanceof Error ? error : new Error(String(error));
  return `${e.name === "Error" ? "" : `${e.name}: `}${e.message}`;
}
