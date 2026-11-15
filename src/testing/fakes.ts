import type { CodeCommitApi, NewPullRequest, PullRequest } from "../aws/codecommit.js";
import type { Commit, Git } from "../git/git.js";
import type { LocalState } from "../state/local.js";

export function fakeGit(overrides: Partial<Git> = {}): Git {
  return {
    topLevel: async () => "/work",
    currentBranch: async () => "topic",
    remoteUrl: async () => "https://git-codecommit.ap-northeast-1.amazonaws.com/v1/repos/demo",
    resolveCommit: async (ref) => (ref.includes("missing") ? null : "c0ffee"),
    unpushedCount: async () => 0,
    commits: async (): Promise<Commit[]> => [{ subject: "Add thing", body: "Because." }],
    push: async () => {},
    fetch: async () => {},
    switchBranch: async () => {},
    fastForward: async () => {},
    clone: async () => {},
    mergeBase: async () => "base0",
    diffTree: async () => [],
    blob: async () => Buffer.from(""),
    firstParentLog: async () => [],
    ...overrides,
  };
}

export function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "1",
    title: "A pull request",
    description: "",
    status: "OPEN",
    authorArn: "arn:aws:iam::123456789012:user/alice",
    repository: "demo",
    sourceBranch: "topic",
    destinationBranch: "main",
    sourceCommit: "s1",
    destinationCommit: "d1",
    isMerged: false,
    revisionId: "r1",
    creationDate: new Date("2026-11-01T00:00:00Z"),
    lastActivityDate: new Date("2026-11-02T00:00:00Z"),
    approvalRules: [],
    ...overrides,
  };
}

export interface FakeApi extends CodeCommitApi {
  readonly created: NewPullRequest[];
}

export function fakeApi(prs: PullRequest[] = [], overrides: Partial<CodeCommitApi> = {}): FakeApi {
  const created: NewPullRequest[] = [];
  const api: FakeApi = {
    created,
    region: async () => "us-west-2",
    callerArn: async () => "arn:aws:iam::123456789012:user/me",
    defaultBranch: async () => "main",
    cloneUrls: async (repo) => ({
      https: `https://git-codecommit.us-west-2.amazonaws.com/v1/repos/${repo}`,
      ssh: `ssh://git-codecommit.us-west-2.amazonaws.com/v1/repos/${repo}`,
    }),
    branchCommit: async (_repo, branch) => (branch === "missing" ? undefined : "r0ffee"),
    listPullRequestIds: async (repo, status, limit) =>
      prs
        .filter((p) => p.status === status && p.repository === repo)
        .map((p) => p.id)
        .slice(0, limit),
    getPullRequests: async (ids) =>
      ids.map((id) => {
        const pr = prs.find((p) => p.id === id);
        if (!pr)
          throw Object.assign(new Error(`${id} does not exist`), {
            name: "PullRequestDoesNotExistException",
          });
        return pr;
      }),
    createPullRequest: async (input) => {
      created.push(input);
      return pullRequest({
        id: "42",
        title: input.title,
        description: input.description,
        sourceBranch: input.sourceBranch,
        destinationBranch: input.destinationBranch,
        repository: input.repository,
      });
    },
    approvers: async () => ["arn:aws:sts::123456789012:assumed-role/Dev/bob"],
    evaluateApprovalRules: async () => ({
      approved: false,
      overridden: false,
      satisfied: ["one"],
      notSatisfied: ["two"],
    }),
    mergeable: async () => true,
    ...overrides,
  };
  return api;
}

export interface FakeState extends LocalState {
  readonly identities: Map<string, string>;
  readonly seenAt: Map<string, Date>;
  readonly sections: Map<string, unknown>;
}

/** LocalState in memory. */
export function fakeState(): FakeState {
  const identities = new Map<string, string>();
  const seenAt = new Map<string, Date>();
  const sections = new Map<string, unknown>();
  return {
    identities,
    seenAt,
    sections,
    identity: {
      get: async (k) => identities.get(k),
      set: async (k, v) => void identities.set(k, v),
    },
    seen: {
      all: async () => new Map(seenAt),
      mark: async (k, at) => void seenAt.set(k, at),
    },
    cache: {
      get: async (k) => sections.get(k),
      set: async (k, v) => void sections.set(k, JSON.parse(JSON.stringify(v))),
    },
  };
}
