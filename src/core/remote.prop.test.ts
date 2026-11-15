import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseRemoteUrl } from "./remote.js";

const region = fc.constantFrom(
  "us-east-1",
  "ap-northeast-1",
  "eu-central-2",
  "us-gov-west-1",
  "cn-north-1",
);
// CodeCommit repository names: letters, digits, '.', '_', '-', up to 100 characters.
const repo = fc.stringMatching(/^[\w.-]{1,100}$/);
const profile = fc.stringMatching(/^[\w.+-]{1,20}$/);

describe("parseRemoteUrl, generated", () => {
  it("reads back the repository and region of every HTTPS and SSH form", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("https", "ssh"),
        fc.option(fc.stringMatching(/^[\w-]{1,20}$/), { nil: undefined }),
        fc.boolean(),
        region,
        repo,
        fc.boolean(),
        (scheme, user, fips, r, name, slash) => {
          const host = `git-codecommit${fips ? "-fips" : ""}.${r}.amazonaws.com${r.startsWith("cn-") ? ".cn" : ""}`;
          const url = `${scheme}://${user ? `${user}@` : ""}${host}/v1/repos/${name}${slash ? "/" : ""}`;
          expect(parseRemoteUrl(url)).toEqual({ repo: name, region: r });
        },
      ),
    );
  });

  it("reads back every git-remote-codecommit form", () => {
    fc.assert(
      fc.property(
        fc.option(region, { nil: undefined }),
        fc.option(profile, { nil: undefined }),
        repo,
        (r, p, name) => {
          const url = `codecommit:${r ? `:${r}:` : ""}//${p ? `${p}@` : ""}${name}`;
          expect(parseRemoteUrl(url)).toEqual({
            repo: name,
            region: r ?? "",
            ...(p ? { profile: p } : {}),
          });
        },
      ),
    );
  });

  it("never throws, whatever the remote URL is", () => {
    fc.assert(
      fc.property(fc.string(), (tail) => {
        parseRemoteUrl(tail);
        parseRemoteUrl(`https://git-codecommit.us-east-1.amazonaws.com/v1/repos/${tail}`);
      }),
    );
  });
});
