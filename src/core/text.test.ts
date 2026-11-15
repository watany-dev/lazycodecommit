import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { shortArn } from "./text.js";

describe("shortArn", () => {
  it("extracts username from ARN", () => {
    expect(shortArn("arn:aws:iam::123456789012:user/watany")).toBe("watany");
  });

  it("keeps the role with an assumed role's session, as the CLI prints it", () => {
    expect(shortArn("arn:aws:sts::123456789012:assumed-role/admin/session")).toBe("admin/session");
  });

  it("returns original if no slash", () => {
    expect(shortArn("unknown")).toBe("unknown");
  });
});

describe("shortArn (property-based)", () => {
  it("returns a string that is not an ARN unchanged", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789/-_") }),
        (text) => {
          expect(shortArn(text)).toBe(text);
        },
      ),
    );
  });

  it("result is always a substring of the input", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789:/-_"),
          minLength: 1,
        }),
        (arn) => {
          const result = shortArn(arn);
          expect(arn).toContain(result);
        },
      ),
    );
  });

  it("is idempotent when result has no slash", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789:/-_"),
          minLength: 1,
        }),
        (arn) => {
          const first = shortArn(arn);
          if (!first.includes("/")) {
            expect(shortArn(first)).toBe(first);
          }
        },
      ),
    );
  });

  it("keeps everything after the resource type", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({
            unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
            minLength: 1,
            maxLength: 10,
          }),
          { minLength: 2, maxLength: 5 },
        ),
        (parts) => {
          const arn = `arn:aws:sts::123456789012:${parts.join("/")}`;
          expect(shortArn(arn)).toBe(parts.slice(1).join("/"));
        },
      ),
    );
  });
});
