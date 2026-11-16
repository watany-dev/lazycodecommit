import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { explainAwsError } from "../../aws/errors.js";
import { formatErrorMessage, screenErrorText } from "./formatError.js";

const CONTEXTS = [
  undefined,
  "comment",
  "reply",
  "approval",
  "merge",
  "close",
  "edit",
  "delete",
  "reaction",
  "activity",
] as const;

const accessKey = fc.stringMatching(/^AKIA[0-9A-Z]{16}$/);
const account = fc.stringMatching(/^[0-9]{12}$/);
const secret = fc.stringMatching(/^[A-Za-z0-9/+=]{40}$/).filter((s) => !/^[0-9a-f]{40}$/.test(s));

// An SDK message quoting what it was given: keys, accounts, ARNs, next to ordinary words.
const message = fc
  .array(
    fc.oneof(
      fc.constantFrom("User:", "is not authorized to perform", "on resource", "(", ")", '"', " "),
      accessKey,
      account.map((a) => `arn:aws:iam::${a}:user/alice`),
      account,
      secret,
      fc.string({ maxLength: 8 }),
    ),
    { maxLength: 8 },
  )
  .map((parts) => parts.join(" "));

const name = fc.oneof(
  fc.constantFrom(
    "Error",
    "AccessDeniedException",
    "ValidationException",
    "ThrottlingException",
    "InternalFailure",
  ),
  // An SDK error's name is its exception's: letters only.
  fc.stringMatching(/^[A-Z][A-Za-z]{0,20}$/).filter((n) => !(n in Object.prototype)),
);

describe("error text on the review screen, for any error", () => {
  it("is a non-empty line that quotes no access key, secret key or account ID", () => {
    fc.assert(
      fc.property(
        name,
        message,
        fc.constantFrom(...CONTEXTS),
        accessKey,
        account,
        secret,
        (n, m, context, key, acct, sec) => {
          const text = `${m} ${key} ${acct} ${sec}`;
          const error = Object.assign(new Error(text), { name: n });
          const shown = formatErrorMessage(error, context);
          expect(typeof shown).toBe("string");
          expect(shown.length).toBeGreaterThan(0);
          expect(shown).not.toContain(key);
          expect(shown).not.toContain(sec);
          expect(shown).not.toMatch(new RegExp(`(?<![0-9])${acct}(?![0-9])`));
          expect(screenErrorText(error)).not.toContain(key);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("never throws, whatever was thrown", () => {
    // What JavaScript code throws: errors, strings, and the odd null, number or plain object.
    const thrownValue = fc.oneof(
      fc.string().map((m) => new Error(m)),
      fc.string(),
      fc.constantFrom(null, undefined, 0, Number.NaN),
      fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.string(), { noNullPrototype: true }),
    );
    fc.assert(
      fc.property(thrownValue, fc.constantFrom(...CONTEXTS), (thrown, context) => {
        expect(typeof formatErrorMessage(thrown, context)).toBe("string");
        expect(typeof screenErrorText(thrown)).toBe("string");
        const explained = explainAwsError(thrown, "dev");
        expect(explained === undefined || typeof explained === "string").toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
