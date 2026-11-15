/** Bad or missing arguments: exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** A failure the user can act on, shown without a stack: exit code 1. */
export class UserError extends Error {
  override name = "UserError";
}
