import type { Git } from "../git/git.js";
import type { Config } from "../state/config.js";
import { UsageError } from "./errors.js";
import { parseRemoteUrl } from "./remote.js";

export interface RepoContext {
  readonly repository: string;
  readonly region?: string;
  readonly profile?: string;
  /** Set when the working directory is a clone of `repository`. */
  readonly clone?: { readonly root: string };
}

export interface ContextInput {
  readonly repo?: string;
  readonly region?: string;
  readonly profile?: string;
  readonly git: Git;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: Config;
}

/**
 * Picks the repository, region and profile (spec: リポジトリの推定, プロファイルと
 * リージョンの優先順位): flags, then the origin remote of a clone, then
 * AWS_PROFILE / AWS_REGION, then the config file, then the SDK's defaults.
 */
export async function resolveContext(input: ContextInput): Promise<RepoContext> {
  const root = await input.git.topLevel();
  const url = root ? await input.git.remoteUrl("origin") : null;
  const remote = url ? parseRemoteUrl(url) : null;

  // --repo naming another repository means we are not working in its clone.
  const inClone = root !== null && remote !== null && (!input.repo || input.repo === remote.repo);
  const repository = input.repo ?? remote?.repo;
  if (!repository) {
    const why =
      root === null
        ? "not inside a git repository"
        : url === null
          ? "this clone has no origin remote"
          : `origin (${url}) is not a CodeCommit remote`;
    throw new UsageError(`Cannot tell which repository to use: ${why}. Pass --repo <name>.`);
  }

  const fromRemote = inClone ? remote : null;
  const region =
    input.region ||
    fromRemote?.region ||
    input.env["AWS_REGION"] ||
    input.env["AWS_DEFAULT_REGION"] ||
    input.config.region;
  const profile =
    input.profile || fromRemote?.profile || input.env["AWS_PROFILE"] || input.config.profile;
  return {
    repository,
    ...(region ? { region } : {}),
    ...(profile ? { profile } : {}),
    ...(inClone ? { clone: { root } } : {}),
  };
}
