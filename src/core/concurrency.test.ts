import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeCommitApi } from "../aws/codecommit.js";
import { fakeGit } from "../testing/fakes.js";
import { loadBranchTable } from "./branch.js";
import { fetchInbox, loadAllDetails, loadDetails } from "./inbox.js";

// docs/configuration.md: `concurrency` is how many CodeCommit calls run at
// once. Measured on the wire, over a whole screen's load, against a stand-in
// endpoint that holds every request a moment.

const ME = "arn:aws:iam::123456789012:user/alice";
const BRANCHES = Array.from({ length: 12 }, (_, i) => `b${i}`);

function pullRequest(id: number) {
  return {
    pullRequestId: String(id),
    title: `PR ${id}`,
    pullRequestStatus: id <= 10 ? "OPEN" : "CLOSED",
    authorArn: ME,
    revisionId: `r${id}`,
    creationDate: 1_700_000_000,
    lastActivityDate: 1_700_000_000 + id,
    pullRequestTargets: [
      {
        repositoryName: "demo",
        sourceReference: `refs/heads/b${id % 12}`,
        destinationReference: "refs/heads/main",
        sourceCommit: `c${id}`,
        destinationCommit: "d",
        mergeMetadata: { isMerged: id > 10 },
      },
    ],
  };
}

function answer(action: string, body: Record<string, unknown>): unknown {
  switch (action) {
    case "GetRepository":
      return { repositoryMetadata: { defaultBranch: "main" } };
    case "ListBranches":
      return { branches: BRANCHES };
    case "GetBranch":
      return { branch: { branchName: body["branchName"], commitId: `c${body["branchName"]}` } };
    case "ListPullRequests": {
      const open = body["pullRequestStatus"] === "OPEN";
      const ids = Array.from({ length: 10 }, (_, i) => String(open ? i + 1 : i + 11));
      return { pullRequestIds: ids };
    }
    case "GetPullRequest":
      return { pullRequest: pullRequest(Number(body["pullRequestId"])) };
    case "EvaluatePullRequestApprovalRules":
      return {
        evaluation: {
          approved: true,
          overridden: false,
          approvalRulesSatisfied: [],
          approvalRulesNotSatisfied: [],
        },
      };
    case "GetMergeConflicts":
      return { mergeable: true, conflictMetadataList: [] };
    default:
      throw new Error(`unexpected ${action}`);
  }
}

let server: Server;
let inFlight = 0;
let peak = 0;
let calls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    inFlight++;
    calls++;
    peak = Math.max(peak, inFlight);
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString();
    });
    req.on("end", () => {
      const action = String(req.headers["x-amz-target"]).split(".")[1] ?? "";
      const out = JSON.stringify(answer(action, JSON.parse(raw || "{}")));
      setTimeout(() => {
        inFlight--;
        res.writeHead(200, { "content-type": "application/x-amz-json-1.1" }).end(out);
      }, 5);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("AWS_ENDPOINT_URL", `http://127.0.0.1:${port}`);
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDTEST");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
  // Nothing from the developer's own AWS setup: no profile, no other endpoint.
  vi.stubEnv("AWS_PROFILE", undefined);
  vi.stubEnv("AWS_ENDPOINT_URL_CODECOMMIT", undefined);
  vi.stubEnv("AWS_CONFIG_FILE", "/dev/null");
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/dev/null");
  inFlight = 0;
  peak = 0;
  calls = 0;
  return () => vi.unstubAllEnvs();
});

const api = (concurrency: number) => createCodeCommitApi({ region: "us-east-1", concurrency });

describe("concurrency caps the CodeCommit calls in flight", () => {
  it("over the whole branch table, outside a clone", async () => {
    const table = await loadBranchTable({
      api: api(2),
      git: fakeGit(),
      ctx: { repository: "demo" },
      config: { concurrency: 2 },
    });
    expect(table.rows).toHaveLength(12);
    // Many calls, so a cap of 2 is not met by chance.
    expect(calls).toBeGreaterThan(30);
    expect(peak).toBe(2);
  });

  it("over the inbox and its details", async () => {
    const client = api(3);
    const inbox = await fetchInbox(["demo", "other"], {
      api: client,
      me: ME,
      region: "us-east-1",
      seen: new Map(),
      concurrency: 3,
    });
    const items = await loadAllDetails(inbox.items, (i) => loadDetails(i, client), 3);
    expect(items.every((i) => i.rules && i.mergeable)).toBe(true);
    expect(calls).toBeGreaterThan(30);
    expect(peak).toBe(3);
  });
});
