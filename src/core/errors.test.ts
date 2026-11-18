import { describe, expect, it } from "vitest";
import { UsageError, UserError } from "./errors.js";

describe("UsageError and UserError", () => {
  it("name themselves, as a stack trace or an unexpected error shows them", () => {
    expect(new UsageError("x").name).toBe("UsageError");
    expect(new UserError("x").name).toBe("UserError");
    expect(String(new UserError("gone"))).toBe("UserError: gone");
  });
});
