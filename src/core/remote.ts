export interface CodeCommitRemote {
  readonly repo: string;
  readonly region: string;
  readonly profile?: string;
}

// https://git-codecommit.<region>.amazonaws.com/v1/repos/<repo>, the ssh:// form,
// with an optional user@, the -fips host and the .com.cn partition.
const HOSTED =
  /^(?:https|ssh):\/\/(?:[^@/]+@)?git-codecommit(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/v1\/repos\/([^/?#]+?)\/?$/;
// git-remote-codecommit: codecommit::<region>://[<profile>@]<repo> or codecommit://[<profile>@]<repo>.
const GRC = /^codecommit:(?::([a-z0-9-]+):)?\/\/(?:([^@/]+)@)?([^@/]+)$/;

/**
 * Reads a CodeCommit remote URL. Returns null for anything else (GitHub,
 * a local path) so callers can say the remote is not CodeCommit. A grc URL
 * without a region yields region "" and the caller falls back to other sources.
 */
export function parseRemoteUrl(url: string): CodeCommitRemote | null {
  const hosted = HOSTED.exec(url.trim());
  if (hosted) return { region: hosted[1] as string, repo: decodeURIComponent(hosted[2] as string) };
  const grc = GRC.exec(url.trim());
  if (grc) {
    const [, region = "", profile, repo] = grc;
    return profile ? { repo: repo as string, region, profile } : { repo: repo as string, region };
  }
  return null;
}
