import { describe, expect, it } from "vitest";
import { fakeApi, fakeGit } from "../testing/fakes.js";
import { cloneRepository } from "./clone.js";
import { UsageError } from "./errors.js";

function setup() {
  const cloned: { url: string; args: readonly string[] }[] = [];
  const git = fakeGit({ clone: async (url, args) => void cloned.push({ url, args }) });
  return { cloned, deps: { git, api: fakeApi() } };
}

describe("cloneRepository", () => {
  it("clones over HTTPS by default, passing extra arguments to git", async () => {
    const { cloned, deps } = setup();
    const url = await cloneRepository({ repository: "demo", args: ["dir"] }, deps);
    expect(url).toBe("https://git-codecommit.us-west-2.amazonaws.com/v1/repos/demo");
    expect(cloned).toEqual([{ url, args: ["dir"] }]);
  });

  it("uses the SSH URL", async () => {
    const { deps } = setup();
    expect(await cloneRepository({ repository: "demo", protocol: "ssh", args: [] }, deps)).toBe(
      "ssh://git-codecommit.us-west-2.amazonaws.com/v1/repos/demo",
    );
  });

  it("builds a git-remote-codecommit URL with the region and profile", async () => {
    const { deps } = setup();
    expect(
      await cloneRepository(
        { repository: "demo", protocol: "grc", region: "eu-west-1", profile: "dev", args: [] },
        deps,
      ),
    ).toBe("codecommit::eu-west-1://dev@demo");
    expect(await cloneRepository({ repository: "demo", protocol: "grc", args: [] }, deps)).toBe(
      "codecommit::us-west-2://demo",
    );
  });

  it("rejects an unknown protocol", async () => {
    const { deps } = setup();
    await expect(
      cloneRepository({ repository: "demo", protocol: "ftp", args: [] }, deps),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      cloneRepository({ repository: "demo", protocol: "ftp", args: [] }, deps),
    ).rejects.toThrow("--protocol must be https, ssh or grc: ftp");
  });
});
