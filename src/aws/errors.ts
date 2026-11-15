const CREDENTIAL_ERRORS = new Set([
  "CredentialsProviderError",
  "TokenProviderError",
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "InvalidSignatureException",
]);

const ACCESS_DENIED = new Set(["AccessDeniedException", "AccessDenied"]);

/**
 * Turns an AWS SDK error into what the user should do next, or undefined when
 * the SDK message is already the best we have.
 */
export function explainAwsError(error: unknown, profile: string | undefined): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const name = error.name;
  if (CREDENTIAL_ERRORS.has(name) || /sso.*(expired|token)|token.*expired/i.test(error.message)) {
    const flag = profile ? ` --profile ${profile}` : "";
    return [
      `AWS credentials are missing or expired (${name}: ${error.message})`,
      `Sign in again, for example \`aws sso login${flag}\`, then retry.`,
    ].join("\n");
  }
  if (ACCESS_DENIED.has(name)) {
    // The message names the codecommit:<Action> that was refused.
    return `Access denied: ${error.message}`;
  }
  if (/region is missing/i.test(error.message)) {
    return 'No AWS region. Pass --region, set AWS_REGION, or add "region" to the config file.';
  }
  return undefined;
}
