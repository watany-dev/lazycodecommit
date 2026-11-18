import { describe, expect, it } from "vitest";
import { parseRemoteUrl } from "./remote.js";

describe("parseRemoteUrl", () => {
  it.each([
    [
      "https://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/my-repo",
      { repo: "my-repo", region: "ap-northeast-1" },
    ],
    [
      "https://user-at-123@git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo/",
      { repo: "my-repo", region: "us-east-1" },
    ],
    [
      "ssh://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/my-repo",
      { repo: "my-repo", region: "ap-northeast-1" },
    ],
    [
      "ssh://APKAEXAMPLE@git-codecommit.eu-west-1.amazonaws.com/v1/repos/r.x_y",
      { repo: "r.x_y", region: "eu-west-1" },
    ],
    [
      "https://git-codecommit-fips.us-gov-west-1.amazonaws.com/v1/repos/gov",
      { repo: "gov", region: "us-gov-west-1" },
    ],
    [
      "https://git-codecommit.cn-north-1.amazonaws.com.cn/v1/repos/cn",
      { repo: "cn", region: "cn-north-1" },
    ],
    // An interface VPC endpoint without private DNS, as the CodeCommit guide clones through it.
    [
      "https://vpce-0b7d2939abEXAMPLE-mtyl4twz.git-codecommit.us-east-2.vpce.amazonaws.com/v1/repos/MyDemoRepo",
      { repo: "MyDemoRepo", region: "us-east-2" },
    ],
    [
      "ssh://APKAEXAMPLE@vpce-0b7d2939abEXAMPLE-mtyl4twz-us-east-2a.git-codecommit-fips.us-east-2.vpce.amazonaws.com/v1/repos/r",
      { repo: "r", region: "us-east-2" },
    ],
    [
      "codecommit::ap-northeast-1://profile@my-repo",
      { repo: "my-repo", region: "ap-northeast-1", profile: "profile" },
    ],
    ["codecommit::us-west-2://my-repo", { repo: "my-repo", region: "us-west-2" }],
    ["codecommit://dev@my-repo", { repo: "my-repo", region: "", profile: "dev" }],
    ["codecommit://my-repo", { repo: "my-repo", region: "" }],
    // Lines read from git's output keep their line break.
    ["  codecommit://my-repo\n", { repo: "my-repo", region: "" }],
    [
      " https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo\n",
      { repo: "my-repo", region: "us-east-1" },
    ],
  ])("reads %s", (url, want) => {
    expect(parseRemoteUrl(url)).toEqual(want);
  });

  it.each([
    "https://github.com/watany-dev/lazycodecommit.git",
    "git@github.com:watany-dev/lazycodecommit.git",
    "/tmp/repo.git",
    "https://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/",
    "codecommit::ap-northeast-1://",
    "git+https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo",
    "xcodecommit://my-repo",
    "codecommit://my-repo/more",
    // A broken %-escape used to throw URIError and stop every command in the clone.
    "https://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/my%zzrepo",
  ])("rejects %s", (url) => {
    expect(parseRemoteUrl(url)).toBeNull();
  });
});
