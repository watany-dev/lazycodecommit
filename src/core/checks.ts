import type { CiApi, CiProvider, CiRun } from "../aws/ci.js";
import { explainAwsError } from "../aws/errors.js";
import type { Config } from "../state/config.js";

/** ADR 0010: how many of each project's or pipeline's newest runs are searched. */
export const RECENT_RUNS = 20;

export type CheckState = "pass" | "fail" | "pending" | "cancel" | "none" | "error";

/** One configured project or pipeline, and its run for the PR's source commit. */
interface CheckRun {
  readonly provider: CiProvider;
  readonly name: string;
  readonly state: CheckState;
  /** The provider's status; null when no run matched or the lookup failed. */
  readonly status: string | null;
  readonly id: string | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly url: string | null;
  /** Why the lookup failed (state "error"). */
  readonly message?: string;
}

export interface Checks {
  readonly state: CheckState;
  readonly commit: string;
  readonly runs: readonly CheckRun[];
}

export interface CiTarget {
  readonly provider: CiProvider;
  readonly name: string;
}

/** The recent runs of one target, fetched once and matched against any number of PRs. */
export type TargetRuns = CiTarget &
  ({ readonly runs: readonly CiRun[] } | { readonly error: string });

/** The repository's projects and pipelines from the config's ci, or undefined when it has none. */
export function ciTargets(config: Config, repository: string): CiTarget[] | undefined {
  const entry = config.ci?.[repository];
  if (!entry) return undefined;
  const targets = [
    ...(entry.codebuild ?? []).map((name) => ({ provider: "codebuild" as const, name })),
    ...(entry.codepipeline ?? []).map((name) => ({ provider: "codepipeline" as const, name })),
  ];
  return targets.length > 0 ? targets : undefined;
}

/** One call per target, in parallel; a failure stays with its target instead of failing the rest. */
export function loadTargetRuns(api: CiApi, targets: readonly CiTarget[]): Promise<TargetRuns[]> {
  return Promise.all(
    targets.map(async (t): Promise<TargetRuns> => {
      try {
        const runs =
          t.provider === "codebuild"
            ? await api.recentBuilds(t.name, RECENT_RUNS)
            : await api.recentExecutions(t.name, RECENT_RUNS);
        return { ...t, runs };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...t, error: explainAwsError(error, undefined) ?? message };
      }
    }),
  );
}

const STATES: Record<CiProvider, Record<string, CheckState>> = {
  codebuild: {
    SUCCEEDED: "pass",
    FAILED: "fail",
    FAULT: "fail",
    TIMED_OUT: "fail",
    IN_PROGRESS: "pending",
    STOPPED: "cancel",
  },
  codepipeline: {
    Succeeded: "pass",
    Failed: "fail",
    InProgress: "pending",
    Stopping: "pending",
    Stopped: "cancel",
    Cancelled: "cancel",
    Superseded: "cancel",
  },
};

/** An unknown status is pending: it may be a new in-between state, and it is not a pass. */
export function stateOf(provider: CiProvider, status: string): CheckState {
  return STATES[provider][status] ?? "pending";
}

const PRECEDENCE: readonly CheckState[] = ["fail", "error", "pending", "cancel", "pass", "none"];

export function overallState(states: readonly CheckState[]): CheckState {
  return PRECEDENCE.find((s) => states.includes(s)) ?? "none";
}

/** Each target's newest run on `commit` (runs are newest first). */
export function checksFor(commit: string, targets: readonly TargetRuns[]): Checks {
  const runs = targets.map((t): CheckRun => {
    const base = { provider: t.provider, name: t.name };
    const empty = { status: null, id: null, startedAt: null, endedAt: null, url: null };
    if ("error" in t) return { ...base, ...empty, state: "error", message: t.error };
    const run = commit ? t.runs.find((r) => r.commits.includes(commit)) : undefined;
    if (!run) return { ...base, ...empty, state: "none" };
    return {
      ...base,
      state: stateOf(t.provider, run.status),
      status: run.status,
      id: run.id,
      startedAt: run.startedAt ?? null,
      endedAt: run.endedAt ?? null,
      url: run.url,
    };
  });
  return { state: overallState(runs.map((r) => r.state)), commit, runs };
}
