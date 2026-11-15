import { describe, expect, it } from "vitest";
import { explainAwsError } from "./errors.js";

const err = (name: string, message: string) => Object.assign(new Error(message), { name });
const fromService = (name: string, message: string) =>
  Object.assign(err(name, message), { $fault: "client", $metadata: { httpStatusCode: 400 } });

describe("explainAwsError", () => {
  it.each([
    ["ExpiredTokenException", "The security token included in the request is expired"],
    ["CredentialsProviderError", "Could not load credentials from any providers"],
    ["Error", "The SSO session associated with this profile has expired"],
  ])("tells the user to sign in again for %s", (name, message) => {
    const out = explainAwsError(err(name, message), "dev");
    expect(out).toContain("aws sso login --profile dev");
    expect(out).toContain(message);
  });

  it("reads CodeCommit's own refusals by name, whatever a repository is called", () => {
    expect(
      explainAwsError(
        fromService(
          "AccessDeniedException",
          "not authorized to perform: codecommit:GetRepository on resource: arn:aws:codecommit:us-east-1:123456789012:sso-token-service",
        ),
        undefined,
      ),
    ).toMatch(/^Access denied: /);
    expect(
      explainAwsError(
        fromService("RepositoryDoesNotExistException", "sso-token-service does not exist"),
        "dev",
      ),
    ).toContain("--region");
  });

  it("omits --profile when none is known", () => {
    expect(explainAwsError(err("ExpiredToken", "x"), undefined)).toContain("`aws sso login`");
  });

  it("passes on the denied action", () => {
    expect(
      explainAwsError(
        err("AccessDeniedException", "not authorized to perform: codecommit:CreatePullRequest"),
        undefined,
      ),
    ).toBe("Access denied: not authorized to perform: codecommit:CreatePullRequest");
  });

  it("says a timeout is CodeCommit not answering, not a bug", () => {
    const out = explainAwsError(
      err("TimeoutError", "the request socket timed out after 10000 ms of inactivity"),
      undefined,
    );
    expect(out).toContain("did not answer");
    expect(out).toContain("10000 ms");
  });

  it("points an unknown pull request at the id, region and profile", () => {
    expect(
      explainAwsError(
        err("PullRequestDoesNotExistException", "Pull request 9 does not exist"),
        "dev",
      ),
    ).toContain("--region");
    expect(
      explainAwsError(err("RepositoryDoesNotExistException", "r does not exist"), undefined),
    ).toContain("--region");
  });

  it("explains a missing region", () => {
    expect(explainAwsError(err("Error", "Region is missing"), undefined)).toMatch(/--region/);
  });

  it("leaves other errors alone", () => {
    expect(
      explainAwsError(err("InvalidRepositoryNameException", "nope"), undefined),
    ).toBeUndefined();
    expect(explainAwsError("string", undefined)).toBeUndefined();
  });
});

describe("explainAwsError for pull request refusals", () => {
  it("phrases a known refusal as what to do, and ignores inherited names", () => {
    expect(
      explainAwsError(err("PullRequestCannotBeApprovedByAuthorException", "x"), undefined),
    ).toBe("You cannot approve your own pull request.");
    expect(explainAwsError(err("constructor", "x"), undefined)).toBeUndefined();
  });
});
