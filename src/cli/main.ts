import { type ParseArgsConfig, parseArgs } from "node:util";
import { version } from "../../package.json" with { type: "json" };
import type { CodeCommitApi } from "../aws/codecommit.js";
import { explainAwsError } from "../aws/errors.js";
import { type RepoContext, resolveContext } from "../core/context.js";
import { UsageError, UserError } from "../core/errors.js";
import {
  consoleUrl,
  createPullRequest,
  listPullRequests,
  type PrDeps,
  pullRequestStatus,
  resolvePullRequest,
} from "../core/pr.js";
import { type Git, GitError } from "../git/git.js";
import { type Config, ConfigError } from "../state/config.js";
import { listLines, prJson, statusLines, viewLines } from "./format.js";

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
}

export const USAGE = `lazycc - a daily-driver client for AWS CodeCommit

Usage:
  lazycc pr create [-B base] [-H head] [-t title] [-b body | -F file] [--fill] [--push | --no-push] [--dry-run]
  lazycc pr list [--state open|closed] [-L limit]
  lazycc pr view [<id>]
  lazycc pr status
  lazycc --version

Flags for every pr command:
  -R, --repo <name>     repository (default: the origin remote of this clone)
      --profile <name>  AWS profile
      --region <region> AWS region
      --json            print JSON

Exit codes: 0 success, 1 error, 2 bad arguments.`;

type Options = NonNullable<ParseArgsConfig["options"]>;

const COMMON: Options = {
  repo: { type: "string", short: "R" },
  profile: { type: "string" },
  region: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const COMMANDS: Record<string, { options: Options; positionals: number }> = {
  create: {
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
  list: {
    positionals: 0,
    options: { state: { type: "string", short: "s" }, limit: { type: "string", short: "L" } },
  },
  view: { positionals: 1, options: {} },
  status: { positionals: 0, options: {} },
};

type Values = Record<string, string | boolean | undefined>;

function parse(verb: string, args: readonly string[]): { values: Values; positionals: string[] } {
  const spec = COMMANDS[verb];
  if (!spec) throw new UsageError(`Unknown command: pr ${verb}`);
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
    if (noun !== "pr") throw new UsageError(`Unknown command: ${noun}`);
    if (verb === undefined || verb === "--help" || verb === "-h") {
      io.out(USAGE);
      return verb === undefined ? 2 : 0;
    }
    const { values, positionals } = parse(verb, rest);
    if (values["help"]) {
      io.out(USAGE);
      return 0;
    }
    return await runPr(verb, values, positionals, deps, (ctx) => {
      profile = ctx.profile;
    });
  } catch (error) {
    return report(error, io, profile);
  }
}

async function runPr(
  verb: string,
  values: Values,
  positionals: string[],
  deps: Deps,
  onContext: (ctx: RepoContext) => void,
): Promise<number> {
  const { io } = deps;
  const json = values["json"] === true;
  const config = await deps.loadConfig(io.env);
  const git = deps.createGit(io.cwd);
  const ctx: RepoContext = await resolveContext({
    ...optional("repo", str(values, "repo")),
    ...optional("region", str(values, "region")),
    ...optional("profile", str(values, "profile")),
    git,
    env: io.env,
    config,
  });
  onContext(ctx);
  const api = await deps.createApi({
    ...optional("region", ctx.region),
    ...optional("profile", ctx.profile),
  });
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

  switch (verb) {
    case "create": {
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
      const url = consoleUrl(ctx.region, result.pr.repository, result.pr.id);
      if (result.kind === "exists") {
        if (json) print({ existing: true, ...prJson(result.pr, ctx.region) });
        io.err(
          `A pull request from ${result.pr.sourceBranch} into ${result.pr.destinationBranch} is already open: #${result.pr.id} ${result.pr.title}`,
        );
        if (!json) io.err(url);
        return 1;
      }
      if (json) print(prJson(result.pr, ctx.region));
      else {
        io.out(`Created pull request #${result.pr.id}: ${result.pr.title}`);
        io.out(url);
      }
      return 0;
    }
    case "list": {
      const state = (str(values, "state") ?? "open").toUpperCase();
      if (state !== "OPEN" && state !== "CLOSED")
        throw new UsageError("--state must be open or closed");
      const limitText = str(values, "limit") ?? "30";
      const limit = Number(limitText);
      if (!Number.isInteger(limit) || limit < 1)
        throw new UsageError(`--limit must be a positive integer: ${limitText}`);
      const prs = await listPullRequests({ state, limit }, prDeps);
      if (json) print(prs.map((pr) => prJson(pr, ctx.region)));
      else if (prs.length === 0)
        io.err(`No ${state.toLowerCase()} pull requests in ${ctx.repository}.`);
      else for (const line of listLines(prs)) io.out(line);
      return 0;
    }
    case "view": {
      const pr = await resolvePullRequest(positionals[0], prDeps);
      if (json) print(prJson(pr, ctx.region));
      else for (const line of viewLines(pr, ctx.region)) io.out(line);
      return 0;
    }
    default: {
      const status = await pullRequestStatus(prDeps);
      if (json) {
        print({
          branch: status.branch,
          pullRequest: status.pr ? prJson(status.pr, ctx.region) : null,
          ...(status.pr
            ? {
                approvedBy: status.approvers,
                approvalRules: status.rules,
                mergeable: status.mergeable,
              }
            : {}),
        });
      } else for (const line of statusLines(status, ctx.region)) io.out(line);
      return 0;
    }
  }
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
  if (error instanceof UserError || error instanceof ConfigError || error instanceof GitError) {
    io.err(`lazycc: ${error.message}`);
    return 1;
  }
  const explained = explainAwsError(error, profile);
  if (explained) {
    io.err(`lazycc: ${explained}`);
    return 1;
  }
  const e = error instanceof Error ? error : new Error(String(error));
  io.err(`lazycc: ${e.name === "Error" ? "" : `${e.name}: `}${e.message}`);
  if (io.env["LAZYCC_DEBUG"] && e.stack) io.err(e.stack);
  return 1;
}
