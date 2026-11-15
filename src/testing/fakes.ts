import type {
  CodeCommitApi,
  MergeStrategy,
  NewPullRequest,
  PullRequest,
} from "../aws/codecommit.js";
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
    remoteBranches: async () => [],
    aheadBehind: async () => ({ ahead: 0, behind: 0 }),
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

function closed(pr: PullRequest, isMerged: boolean): PullRequest {
  return pullRequest({ ...pr, status: "CLOSED", isMerged });
}

export interface FakeApi extends CodeCommitApi {
  readonly created: NewPullRequest[];
  /** Every write to an existing PR, in order: "comment 1 LGTM", "approve 1", "merge 1 squash"... */
  readonly writes: string[];
}

export function fakeApi(prs: PullRequest[] = [], overrides: Partial<CodeCommitApi> = {}): FakeApi {
  const created: NewPullRequest[] = [];
  const writes: string[] = [];
  const api: FakeApi = {
    created,
    writes,
    region: async () => "us-west-2",
    callerArn: async () => "arn:aws:iam::123456789012:user/me",
    credentialId: async () => "AKIAFAKE",
    listRepositories: async () => [...new Set(prs.map((p) => p.repository))].toSorted(),
    defaultBranch: async () => "main",
    cloneUrls: async (repo) => ({
      https: `https://git-codecommit.us-west-2.amazonaws.com/v1/repos/${repo}`,
      ssh: `ssh://git-codecommit.us-west-2.amazonaws.com/v1/repos/${repo}`,
    }),
    listBranches: async () => ["main", "topic"],
    deleteBranch: async () => {},
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
    postComment: async (pr, content) => {
      writes.push(`comment ${pr.id} ${content}`);
      return "c1";
    },
    setApproval: async (pr, approve) =>
      void writes.push(`${approve ? "approve" : "revoke"} ${pr.id}`),
    merge: async (pr, strategy: MergeStrategy) => {
      writes.push(`merge ${pr.id} ${strategy}`);
      return closed(pr, true);
    },
    getFolder: async () => undefined,
    getFile: async () => undefined,
    close: async (pr) => {
      writes.push(`close ${pr.id}`);
      return closed(pr, false);
    },
    ...overrides,
  };
  return api;
}

export interface FakeState extends LocalState {
  readonly identities: Map<string, string>;
  readonly seenAt: Map<string, Date>;
  readonly sections: Map<string, unknown>;
  readonly draftLists: Map<string, unknown>;
}

/** LocalState in memory. */
export function fakeState(): FakeState {
  const identities = new Map<string, string>();
  const seenAt = new Map<string, Date>();
  const sections = new Map<string, unknown>();
  const draftLists = new Map<string, unknown>();
  return {
    identities,
    seenAt,
    sections,
    draftLists,
    flush: async () => {},
    identity: {
      get: async (k) => identities.get(k),
      set: async (k, v) => void identities.set(k, v),
    },
    seen: {
      all: async () => new Map(seenAt),
      mark: async (k, at) => void seenAt.set(k, at),
    },
    drafts: {
      get: async (k) => draftLists.get(k),
      set: async (k, v) =>
        void (v.length === 0
          ? draftLists.delete(k)
          : draftLists.set(k, JSON.parse(JSON.stringify(v)))),
    },
    cache: {
      get: async (k) => sections.get(k),
      set: async (k, v) => void sections.set(k, JSON.parse(JSON.stringify(v))),
    },
  };
}
