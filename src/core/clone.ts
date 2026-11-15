import type { CodeCommitApi } from "../aws/codecommit.js";
import type { Git } from "../git/git.js";
import { UsageError } from "./errors.js";

export interface CloneOptions {
  readonly repository: string;
  /** https (default), ssh, or grc for git-remote-codecommit. */
  readonly protocol?: string;
  readonly region?: string;
  readonly profile?: string;
  /** Passed to `git clone` after the URL: a directory and git's own flags. */
  readonly args: readonly string[];
}

/** Resolves the repository's URL and runs `git clone`. Returns the URL. */
export async function cloneRepository(
  opts: CloneOptions,
  deps: { readonly git: Git; readonly api: CodeCommitApi },
): Promise<string> {
  const protocol = opts.protocol ?? "https";
  let url: string;
  if (protocol === "grc") {
    // Same shape as the remotes we parse (core/remote.ts), so the clone keeps the profile.
    const region = opts.region ?? (await deps.api.region());
    url = `codecommit::${region}://${opts.profile ? `${opts.profile}@` : ""}${opts.repository}`;
  } else if (protocol === "https" || protocol === "ssh") {
    // GetRepository also fails early, with the SDK's message, for a repository that does not exist.
    url = (await deps.api.cloneUrls(opts.repository))[protocol];
  } else {
    throw new UsageError(`--protocol must be https, ssh or grc: ${protocol}`);
  }
  await deps.git.clone(url, opts.args);
  return url;
}
