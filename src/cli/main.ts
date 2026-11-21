import { type ParseArgsConfig, parseArgs } from "node:util";
import { version } from "../../package.json" with { type: "json" };
import type { CiApi } from "../aws/ci.js";
import type { CodeCommitApi, MergeStrategy, PullRequest } from "../aws/codecommit.js";
import { explainAwsError } from "../aws/errors.js";
import { branchActions, loadBranchTable } from "../core/branch.js";
import { type BrowseNode, browseActions, ENTRY_MARK } from "../core/browse.js";
import { lazyCiClient, pullRequestChecks, repositoryRuns } from "../core/checks.js";
import { cloneRepository } from "../core/clone.js";
import { type DraftStorage, draftStorage } from "../core/commentDrafts.js";
import {
  type AccountContext,
  type ContextInput,
  type RepoContext,
  resolveAccountContext,
  resolveContext,
} from "../core/context.js";
import { pullRequestDiff } from "../core/diff.js";
import { UsageError, UserError } from "../core/errors.js";
import { type HomeActions, homeActions } from "../core/home.js";
import {
  fetchInbox,
  isPending,
  loadAllDetails,
  loadDetails,
  resolveMe,
  toCache,
  watchedRepositories,
} from "../core/inbox.js";
import {
  approvePullRequest,
  checkoutPullRequest,
  closePullRequest,
  commentOnPullRequest,
  concurrency,
  consoleUrl,
  createPullRequest,
  listPullRequests,
  mergePullRequest,
  type PrDeps,
  pullRequestStatus,
  resolvePullRequest,
} from "../core/pr.js";
import { printable } from "../core/text.js";
import { type Git, GitError } from "../git/git.js";
import { type Config, ConfigError, configPath } from "../state/config.js";
import { type LocalState, markSeen as markSeenIn, type SeenPr } from "../state/local.js";
import type { ReviewRequest, TopRequest, TopViews } from "../tui/index.js";
import { completionScript, SHELLS, type Shell } from "./completion.js";
import {
  branchJson,
  branchLines,
  checksJson,
  inboxJson,
  inboxLines,
  listLines,
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
  readFile(path: string, within?: string): Promise<string | null>;
  readStdin(): Promise<string>;
}

export interface Deps {
  readonly io: Io;
  createGit(cwd: string): Git;
  /** `concurrency` caps the client's calls in flight (docs/configuration.md). */
  createApi(options: {
    region?: string;
    profile?: string;
    concurrency: number;
  }): Promise<CodeCommitApi>;
  /** CodeBuild and CodePipeline; loaded only for a repository the config's ci lists (ADR 0010). */
  createCiApi(options: { region?: string; profile?: string }): Promise<CiApi>;
  loadConfig(env: Readonly<Record<string, string | undefined>>): Promise<Config>;
  createState(env: Readonly<Record<string, string | undefined>>): LocalState;
  /** Open the TUI; cli.ts loads it lazily so other commands never load Ink. */
  openReview(request: ReviewRequest): Promise<void>;
  /** Home, the branch table and browse, switched with 1/2/3 (spec: 画面遷移). */
  openTop(request: TopRequest): Promise<void>;
}

export const USAGE = `lazycc - a daily-driver client for AWS CodeCommit

Usage:
  lazycc                 home: PRs awaiting your approval and your own, across repositories
  lazycc status
  lazycc pr create [-B base] [-H head] [-t title] [-b body | -F file] [--fill] [--push | --no-push] [--dry-run]
  lazycc pr list [--state open|closed] [-L limit]   the newest N created, most recently active first
  lazycc pr view [<id>]
  lazycc pr diff [<id>]   the changes as a unified diff, from the merge base
  lazycc pr status
  lazycc pr checkout <id>
  lazycc pr comment [<id>] [-b body | -F file]
  lazycc pr approve [<id>] [--revoke]
  lazycc pr merge [<id>] [--ff | --squash | --three-way]
  lazycc pr close [<id>]
  lazycc branch
  lazycc browse [<repo>] [--ref branch|commit] [--path path]
  lazycc clone <repo> [<dir>] [--protocol https|ssh|grc] [-- <git clone flags>]
  lazycc completion bash|zsh|fish
  lazycc --version

Flags for every command:
  -R, --repo <name>     repository (default: the origin remote of this clone; not for clone)
      --profile <name>  AWS profile
      --region <region> AWS region
      --json            print JSON

Exit codes: 0 success, 1 error, 2 bad arguments.`;

/** The usage line of one command, with the flags every command takes. */
function commandUsage(command: string): string {
  const [commands = "", common = ""] = USAGE.split("\n\nFlags for every command:");
  const own = commands
    .split("\n")
    .filter((l) => l === `  lazycc ${command}` || l.startsWith(`  lazycc ${command} `));
  if (own.length === 0) return USAGE;
  return ["Usage:", ...own, "", `Flags for every command:${common}`].join("\n");
}

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
  "pr diff": { positionals: 1, options: {} },
  "pr status": { positionals: 0, options: {} },
  "pr checkout": { positionals: 1, options: {} },
  "pr comment": {
    positionals: 1,
    options: {
      body: { type: "string", short: "b" },
      "body-file": { type: "string", short: "F" },
    },
  },
  "pr approve": { positionals: 1, options: { revoke: { type: "boolean" } } },
  "pr merge": {
    positionals: 1,
    options: {
      ff: { type: "boolean" },
      squash: { type: "boolean" },
      "three-way": { type: "boolean" },
    },
  },
  "pr close": { positionals: 1, options: {} },
  branch: { positionals: 0, options: {} },
  status: { positionals: 0, options: {} },
  browse: {
    positionals: 1,
    options: { ref: { type: "string" }, path: { type: "string" } },
  },
  home: { positionals: 0, options: {} },
};

const MERGE_FLAGS: Record<string, MergeStrategy> = {
  ff: "fast-forward",
  squash: "squash",
  "three-way": "three-way",
};

function preferredStrategy(config: Config): MergeStrategy | undefined {
  const option = config.pr?.mergeOption;
  return option && MERGE_FLAGS[option];
}

/** The one strategy flag given, else the config's pr.mergeOption (spec: pr merge). */
function mergeStrategy(values: Values, config: Config): MergeStrategy {
  const picked = Object.keys(MERGE_FLAGS).filter((flag) => values[flag] === true);
  if (picked.length > 1) {
    throw new UsageError("Pick one merge strategy: --ff, --squash or --three-way");
  }
  const strategy = picked[0] ? MERGE_FLAGS[picked[0]] : preferredStrategy(config);
  if (!strategy) {
    throw new UsageError(
      "Pick a merge strategy: --ff, --squash or --three-way, or set pr.mergeOption",
    );
  }
  return strategy;
}

for (const spec of Object.values(COMMANDS)) Object.assign(spec.options, REPO);
// The repository is the positional argument, and `--` passes the rest to git clone.
COMMANDS["clone"] = { positionals: 2, options: { protocol: { type: "string" } } };
COMMANDS["completion"] = { positionals: 1, options: {} };

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

export async function run(args: readonly string[], rawDeps: Deps): Promise<number> {
  const deps = { ...rawDeps, io: printableIo(rawDeps.io) };
  const { io } = deps;
  const [noun, verb, ...rest] = args;
  let profile: string | undefined;
  try {
    if (noun === "--version" || noun === "-v") {
      io.out(version);
      return 0;
    }
    if (noun === "--help" || noun === "-h" || noun === "help") {
      io.out(USAGE);
      return 0;
    }
    let command: string;
    let commandArgs: readonly string[];
    const bare = noun === undefined || noun.startsWith("-");
    if (bare) {
      // Bare lazycc (flags allowed) opens the home screen, or prints it as status
      // text when there is no terminal (spec: 出力と終了コード).
      command = io.interactive ? "home" : "status";
      commandArgs = args;
    } else if (noun === "home") {
      throw new UsageError("Unknown command: home");
    } else if (noun === "pr") {
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
      // Bare lazycc is home or status by the terminal; its help is the same either way.
      io.out(bare ? USAGE : commandUsage(command));
      return 0;
    }
    if (command === "clone") {
      if (!positionals[0]) throw new UsageError("clone needs a repository name");
      values["repo"] = positionals[0];
      positionals.push(...passthrough);
    }
    if (command === "completion") {
      const shell = positionals[0];
      if (!SHELLS.includes(shell as Shell))
        throw new UsageError(`completion needs a shell: ${SHELLS.join(", ")}`);
      const table = Object.fromEntries(
        Object.entries(COMMANDS)
          // Bare lazycc is the home screen; "home" is not a word to type.
          .filter(([name]) => name !== "home")
          .map(([name, spec]) => [name, { ...COMMON, ...spec.options }]),
      );
      io.out(completionScript(shell as Shell, table).trimEnd());
      return 0;
    }
    if (command === "browse" && positionals[0] !== undefined) {
      if (values["repo"] !== undefined)
        throw new UsageError("Pass the repository once: as the argument or with --repo");
      values["repo"] = positionals[0];
    }
    // An empty name (-R "$UNSET") would otherwise fall back to the clone's remote.
    if (values["repo"] === "") throw new UsageError("--repo needs a repository name");
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
  // Checked before any AWS call, so a typo cannot cost a round trip.
  if (command === "pr merge") mergeStrategy(values, config);
  const git = deps.createGit(io.cwd);
  const input = {
    ...optional("repo", str(values, "repo")),
    ...optional("region", str(values, "region")),
    ...optional("profile", str(values, "profile")),
    git,
    env: io.env,
    config,
  };
  const tui = io.interactive && !json;
  if (command === "status" || command === "home") {
    // The config's repos live in the config's region and profile, not the remote's.
    const fromConfig = !input.repo && Boolean(config.repos?.length);
    const account = await resolveAccountContext({ ...input, outsideClone: fromConfig });
    onContext(account);
    // --json prints, on a terminal too (spec: 出力と終了コード).
    return command === "status" || json
      ? runStatus(str(values, "repo"), account, config, json, deps)
      : runTop({ start: "home", flagRepo: str(values, "repo"), ctx: account, config, git }, deps);
  }
  if (command === "browse" && tui) {
    // Outside a clone with no repository, browse opens on the repository picker.
    const account = await resolveAccountContext(input);
    onContext(account);
    return runTop(
      {
        start: "browse",
        flagRepo: str(values, "repo"),
        ctx: account,
        config,
        git,
        ...optional("ref", str(values, "ref")),
        ...optional("path", str(values, "path")),
        ...optional("homeCtx", await homeContext(input)),
      },
      deps,
    );
  }
  const ctx = await resolveContext(input);
  onContext(ctx);
  // The region is for console URLs; resolving it also fails early, with advice, when none is set.
  const { api, region } = await openAccount(deps, ctx, config);
  const prDeps = prDepsFor(io, { git, api, ctx, config });
  const print = (value: unknown) => printJson(io, value);
  const ci = ciClient(deps, region, ctx.profile);
  const loadChecks = (pr: { repository: string; sourceCommit: string }) =>
    pullRequestChecks(config, ci, pr);
  const viewJson = async (pr: PullRequest) => ({
    ...prJson(pr, region),
    checks: checksJson(await loadChecks(pr)),
  });
  const done = (line: string, pr: PullRequest) => {
    io.out(line);
    io.out(consoleUrl(region, pr.repository, pr.id));
  };
  const local = deps.createState(io.env);
  const markSeen = markSeenFor(local, region);
  // On a terminal, pr view and a bare pr list open the review screen instead of printing.
  const review = (start: ReviewRequest["start"]) =>
    deps.openReview({
      repository: ctx.repository,
      start,
      region,
      markSeen,
      drafts: draftStorage(local.drafts, region),
      checks: loadChecks,
      ...optional("mergeStrategy", preferredStrategy(config)),
      ...optional("profile", ctx.profile),
      ...(ctx.clone ? { git } : {}),
    });

  switch (command) {
    case "branch": {
      const branchDeps = { api, git, ctx, config };
      if (tui) {
        return runTop(
          {
            start: "branches",
            flagRepo: str(values, "repo"),
            ctx,
            config,
            git,
            api,
            ...optional("homeCtx", await homeContext(input)),
          },
          deps,
        );
      }
      const table = await loadBranchTable(branchDeps);
      if (json) print(branchJson(table));
      else for (const line of branchLines(table)) io.out(line);
      return 0;
    }
    case "browse": {
      const actions = await browseActions({ api, ctx }, region, str(values, "ref"));
      const path = str(values, "path") ?? "";
      const node = await actions.open(actions.startRef, path);
      const url = actions.consoleUrl(node.ref, node.path);
      if (json) print(browseJson(ctx.repository, node, url));
      else if (node.kind === "folder") for (const e of node.entries) io.out(entryLine(e));
      else if (node.text !== undefined) io.out(node.text.replace(/\n$/, ""));
      else {
        io.err(
          node.tooLarge
            ? `lazycc: ${node.path} is too large for the CodeCommit API. Run \`lazycc clone ${ctx.repository}\` to read it.`
            : `lazycc: ${node.path} is a binary file (${node.size} bytes), not shown.`,
        );
        io.err(url);
        return 1;
      }
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
            : `Switched to ${result.branch}, ${result.ahead ? "ahead of" : "up to date with"} origin/${result.branch} (#${result.pr.id}).`,
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
        // The shape of pr view --json (spec: PR 作成), CI results included.
        if (json) print({ existing: true, ...(await viewJson(result.pr)) });
        io.err(
          `A pull request from ${result.pr.sourceBranch} into ${result.pr.destinationBranch} is already open: #${result.pr.id} ${printable(result.pr.title)}`,
        );
        if (!json) io.err(url);
        return 1;
      }
      if (json) print(await viewJson(result.pr));
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
      // Digits only: Number() also takes "0x10", "1e1" and " 2".
      if (!/^\d+$/.test(limitText) || limit < 1)
        throw new UsageError(`--limit must be a positive integer: ${limitText}`);
      const prs = await listPullRequests({ state, limit }, prDeps);
      if (json) print(prs.map((pr) => prJson(pr, region)));
      else if (prs.length === 0)
        io.err(`No ${state.toLowerCase()} pull requests in ${ctx.repository}.`);
      else for (const line of listLines(prs)) io.out(line);
      return 0;
    }
    case "pr comment": {
      const { pr, commentId } = await commentOnPullRequest(
        positionals[0],
        {
          ...optional("body", str(values, "body")),
          ...optional("bodyFile", str(values, "body-file")),
        },
        prDeps,
      );
      if (json) print({ commentId, pullRequest: prJson(pr, region) });
      else done(`Commented on #${pr.id} ${printable(pr.title)}`, pr);
      return 0;
    }
    case "pr approve": {
      const approve = values["revoke"] !== true;
      const pr = await approvePullRequest(positionals[0], approve, prDeps);
      if (json) print({ approved: approve, pullRequest: prJson(pr, region) });
      else
        done(
          `${approve ? "Approved" : "Revoked your approval of"} #${pr.id} ${printable(pr.title)}`,
          pr,
        );
      return 0;
    }
    case "pr merge": {
      const strategy = mergeStrategy(values, config);
      const pr = await mergePullRequest(positionals[0], strategy, prDeps);
      if (json) print(prJson(pr, region));
      else
        done(
          `Merged #${pr.id} ${printable(pr.title)} into ${pr.destinationBranch} (${strategy})`,
          pr,
        );
      return 0;
    }
    case "pr close": {
      const pr = await closePullRequest(positionals[0], prDeps);
      if (json) print(prJson(pr, region));
      else done(`Closed #${pr.id} ${printable(pr.title)}`, pr);
      return 0;
    }
    case "pr diff": {
      const pr = await resolvePullRequest(positionals[0], prDeps);
      const diff = await pullRequestDiff(pr, { api, ...(ctx.clone ? { git } : {}) });
      if (json) print({ pullRequest: prJson(pr, region), diff });
      else if (diff) io.out(diff.replace(/\n$/, ""));
      return 0;
    }
    case "pr view": {
      const pr = await resolvePullRequest(positionals[0], prDeps);
      if (io.interactive && !json) {
        await review({ pullRequestId: pr.id });
        return 0;
      }
      if (json) {
        print(await viewJson(pr));
        return 0;
      }
      const checks = await loadChecks(pr);
      for (const line of viewLines(pr, region, checks)) io.out(line);
      return 0;
    }
    default: {
      const status = await pullRequestStatus(prDeps);
      const checks = status.pr ? await loadChecks(status.pr) : null;
      if (json) {
        print({
          branch: status.branch,
          pullRequest: status.pr ? prJson(status.pr, region) : null,
          ...(status.pr
            ? {
                approvedBy: status.approvers,
                approvalRules: status.rules,
                mergeable: status.mergeable,
                checks: checksJson(checks),
              }
            : {}),
        });
      } else for (const line of statusLines(status, region, checks)) io.out(line);
      return 0;
    }
  }
}

interface TopStart {
  readonly start: TopRequest["start"];
  readonly flagRepo: string | undefined;
  readonly ctx: AccountContext;
  readonly config: Config;
  readonly git: Git;
  /** Already created for this context (lazycc branch). */
  readonly api?: CodeCommitApi;
  /** browse: --ref and --path, for the repository it starts on. */
  readonly ref?: string;
  readonly path?: string;
  /** Where home reads the config's repos, when that is not `ctx` (spec: ホーム). */
  readonly homeCtx?: AccountContext;
}

/**
 * The account bare lazycc reads the config's repos in: the config's region and
 * profile, not the clone's. Undefined when home has nothing from the config.
 */
async function homeContext(input: ContextInput): Promise<AccountContext | undefined> {
  if (input.repo || !input.config.repos?.length) return undefined;
  return resolveAccountContext({ ...input, outsideClone: true });
}

/**
 * The TUI's top level (spec: 画面遷移): bare lazycc, lazycc branch and lazycc
 * browse open it on their own view, and 1/2/3 switch between the three for the
 * clone's repository or the one picked with r.
 */
async function runTop(top: TopStart, deps: Deps): Promise<number> {
  const { io } = deps;
  const { ctx, config, git } = top;
  const cloneRepo = ctx.clone ? ctx.repository : undefined;
  const { api, region } = await openAccount(deps, ctx, config, top.api);
  const state = deps.createState(io.env);
  // Home reads the config's repos in the config's account, which a clone of
  // another region or profile does not share.
  const homeCtx =
    top.homeCtx && (top.homeCtx.region !== ctx.region || top.homeCtx.profile !== ctx.profile)
      ? top.homeCtx
      : undefined;
  const homeAccount = homeCtx
    ? openAccount(deps, homeCtx, config)
    : Promise.resolve({ api, region });
  const homeRegion = homeAccount.then((a) => a.region);
  // A failure shows when home opens, not before the branch table or browse.
  homeRegion.catch(() => {});
  const ci = ciClient(deps, region, ctx.profile);
  const homeCi = homeCtx ? ciClient(deps, homeRegion, homeCtx.profile) : ci;
  // Only home and the picker need "me" (one STS call, cached per profile).
  let home: Promise<HomeActions> | undefined;
  const repoContext = (repository: string): RepoContext => ({
    repository,
    ...optional("region", ctx.region),
    ...optional("profile", ctx.profile),
    ...(repository === cloneRepo && ctx.clone ? { clone: ctx.clone } : {}),
  });
  const views: TopViews = {
    home: () =>
      (home ??= homeAccount.then(async (account) => {
        const me = await resolveMe(account.api, state.identity);
        return homeActions({
          api: account.api,
          state,
          config,
          env: io.env,
          region: account.region,
          me,
          // Nothing to watch: the home opens on the repository picker.
          initial: watchedRepositories(top.flagRepo, config, cloneRepo),
          ci: homeCi,
        });
      })),
    branches(repository) {
      const repoCtx = repoContext(repository);
      return {
        actions: branchActions({ api, git, ctx: repoCtx, config }, region),
        async createPullRequest(head) {
          try {
            const result = await createPullRequest(
              { head, fill: false, push: false, noPush: false, dryRun: false },
              prDepsFor(io, { git, api, ctx: repoCtx, config }),
            );
            // dry-run is off, so the result is a PR, new or already open.
            return { pullRequestId: (result as { pr: { id: string } }).pr.id };
          } catch (error) {
            return { message: describeError(error, ctx.profile) };
          }
        },
      };
    },
    browse: (repository) =>
      browseActions(
        { api, ctx: repoContext(repository) },
        region,
        repository === ctx.repository ? top.ref : undefined,
      ),
  };
  await deps.openTop({
    start: top.start,
    ...optional("repository", ctx.repository),
    ...optional("browsePath", top.path),
    views,
    region,
    markSeen: markSeenFor(state, region),
    drafts: draftStorage(state.drafts, region),
    checks: (pr) => pullRequestChecks(config, ci, pr),
    ...optional("mergeStrategy", preferredStrategy(config)),
    ...optional("profile", ctx.profile),
    ...(cloneRepo ? { git, cloneRepository: cloneRepo } : {}),
    ...(homeCtx
      ? {
          home: {
            ...optional("region", homeCtx.region),
            ...optional("profile", homeCtx.profile),
            checks: (pr: { repository: string; sourceCommit: string }) =>
              pullRequestChecks(config, homeCi, pr),
            markSeen: markSeenFor(state, homeRegion),
            drafts: draftsIn(state, homeRegion),
          },
        }
      : {}),
  });
  // The PR read last (left on quitting) must be saved before the process ends.
  await state.flush();
  return 0;
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
  const { api, region } = await openAccount(deps, ctx, config);
  const state = deps.createState(io.env);
  const me = await resolveMe(api, state.identity);
  const limit = concurrency(config);
  const listed = await fetchInbox(repositories, {
    api,
    me,
    region,
    seen: await state.seen.all(),
    concurrency: limit,
  });
  const runs = repositoryRuns(config, ciClient(deps, region, ctx.profile));
  const inbox = {
    ...listed,
    items: await loadAllDetails(listed.items, (i) => loadDetails(i, api, runs), limit),
  };
  const items = inbox.items.filter((i) => isPending(i, me));
  if (json) printJson(io, inboxJson(inbox, items, region));
  else for (const line of inboxLines(items)) io.out(line);
  for (const { repository, error } of inbox.errors) {
    io.err(`lazycc: ${repository}: ${explainAwsError(error, ctx.profile) ?? error.message}`);
  }
  const incomplete = inbox.items.filter((i) => i.detailError);
  for (const { pr, detailError } of incomplete) {
    io.err(`lazycc: ${pr.repository} #${pr.id}: could not load approvals or rules: ${detailError}`);
  }
  // A row shows only CI's mark; why a lookup failed is said once per repository.
  // Only repositories with a PR of ours were looked up, and no others are.
  const looked = new Set(
    inbox.items.filter((i) => i.section === "mine").map((i) => i.pr.repository),
  );
  for (const repository of looked) {
    for (const t of (await runs(repository)) ?? []) {
      if ("error" in t) io.err(`lazycc: ${repository}: CI ${t.provider} ${t.name}: ${t.error}`);
    }
  }
  // The cache only speeds up the next TUI start; failing to write it is not an error.
  await state.cache.set("home", toCache(inbox, region)).catch(() => {});
  return inbox.errors.length > 0 || incomplete.length > 0 ? 1 : 0;
}

/** The CodeCommit client for an account, and its region (the SDK's own when none is set). */
async function openAccount(
  deps: Deps,
  ctx: { region?: string; profile?: string },
  config: Config,
  created?: CodeCommitApi,
) {
  const api =
    created ??
    (await deps.createApi({
      ...optional("region", ctx.region),
      ...optional("profile", ctx.profile),
      concurrency: concurrency(config),
    }));
  return { api, region: ctx.region ?? (await api.region()) };
}

function ciClient(deps: Deps, region: string | Promise<string>, profile: string | undefined) {
  return lazyCiClient(async () =>
    deps.createCiApi({ region: await region, ...optional("profile", profile) }),
  );
}

/** Opening a PR in any review screen counts as reading it on the home screen. */
function markSeenFor(state: LocalState, region: string | Promise<string>) {
  return (pr: SeenPr) => {
    // The read mark only feeds home's ● marker; failing to save it is not an error.
    void (async () => markSeenIn(state, await region, pr, new Date()))().catch(() => {});
  };
}

/** drafts.json for the PRs of an account whose region is still being resolved. */
function draftsIn(state: LocalState, region: Promise<string>): DraftStorage {
  const storage = region.then((r) => draftStorage(state.drafts, r));
  // The failure shows when a review loads drafts, not as an unhandled rejection.
  storage.catch(() => {});
  return {
    load: async (key) => (await storage).load(key),
    save: async (key, drafts) => (await storage).save(key, drafts),
  };
}

function prDepsFor(io: Io, base: Pick<PrDeps, "git" | "api" | "ctx" | "config">): PrDeps {
  return {
    ...base,
    interactive: io.interactive,
    confirm: io.confirm,
    edit: io.edit,
    readFile: io.readFile,
    readStdin: io.readStdin,
    note: io.err,
  };
}

/**
 * Every line we print carries text from elsewhere (titles, branch names, commit
 * messages, git's and the SDK's errors), so none may reach the terminal as an
 * escape sequence. Our own output has no control characters but \n and \t.
 */
function printableIo(io: Io): Io {
  return {
    ...io,
    out: (line) => io.out(printable(line, true)),
    err: (line) => io.err(printable(line, true)),
    confirm: (question) => io.confirm(printable(question)),
  };
}

// JSON.stringify escapes C0 controls but not DEL or C1 (U+007F-U+009F); \u
// escapes keep the data exact and the terminal safe.
function printJson(io: Io, value: unknown): void {
  io.out(
    JSON.stringify(value, null, 2).replace(
      /[\u007f-\u009f]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );
}

function entryLine(e: { name: string; type: keyof typeof ENTRY_MARK }): string {
  return `${e.name}${ENTRY_MARK[e.type]}`;
}

function browseJson(repository: string, node: BrowseNode, url: string) {
  const at = { repository, ref: node.ref, path: node.path };
  if (node.kind === "folder") return { ...at, type: "folder", entries: node.entries, url };
  return {
    ...at,
    type: "file",
    size: node.size ?? null,
    binary: node.binary === true,
    tooLarge: node.tooLarge === true,
    content: node.text ?? null,
    url,
  };
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
