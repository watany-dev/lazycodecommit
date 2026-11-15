import { describe, expect, it } from "vitest";
import { explainAwsError } from "./errors.js";

const err = (name: string, message: string) => Object.assign(new Error(message), { name });

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

  it("explains a missing region", () => {
    expect(explainAwsError(err("Error", "Region is missing"), undefined)).toMatch(/--region/);
  });

  it("leaves other errors alone", () => {
    expect(
      explainAwsError(err("RepositoryDoesNotExistException", "nope"), undefined),
    ).toBeUndefined();
    expect(explainAwsError("string", undefined)).toBeUndefined();
  });
});
