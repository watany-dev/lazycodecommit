// "fast-check" for the tests when FC_RUNS_SCALE is set (vitest.config.ts): every
// fc.assert runs FC_RUNS_SCALE times its numRuns, given or default.
import * as fc from "fast-check";

export * from "fast-check";

const scale = Number(process.env["FC_RUNS_SCALE"] ?? "1");

export const assert = ((property: never, params?: fc.Parameters<unknown>) => {
  const base = params?.numRuns ?? fc.readConfigureGlobal().numRuns ?? 100;
  return fc.assert(property, { ...params, numRuns: Math.ceil(base * scale) });
}) as typeof fc.assert;
