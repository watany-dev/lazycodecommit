import { PassThrough } from "node:stream";
import * as fc from "fast-check";
import { render } from "ink";
import type { ReactElement } from "react";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import type { HomeActions } from "../core/home.js";
import type { Inbox, InboxItem } from "../core/inbox.js";
import type { ReviewService } from "../core/review.js";
import { pullRequest } from "../testing/fakes.js";
import { PullRequestList } from "./components/PullRequestList.js";
import { KeysProvider } from "./hooks/useKeys.js";
import { keyStream } from "./keyStream.js";

vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  useApp: () => ({ exit: vi.fn() }),
}));

const { HomeApp } = await import("./HomeApp.js");

const ME = "arn:aws:iam::123456789012:user/me";

// Titles people write: long, Japanese, emoji, combining marks, tabs.
const title = fc
  .array(fc.constantFrom("fix", " ", "日本語のタイトル", "😀", "e\u0301", "a".repeat(30), "ｶﾅ"), {
    minLength: 1,
    maxLength: 8,
  })
  .map((p) => p.join(""));

const size = fc.record({
  columns: fc.integer({ min: 80, max: 160 }),
  rows: fc.integer({ min: 24, max: 50 }),
});

function mount(node: ReactElement, columns: number, rows: number) {
  const source = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
  let frame = "";
  stdout.on("data", (d) => {
    frame = String(d);
  });
  const app = render(<KeysProvider>{node}</KeysProvider>, {
    stdin: keyStream(source as unknown as NodeJS.ReadStream),
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
  });
  return { source, app, frame: () => frame };
}

/** The frame fits: no row wider than the terminal, no more rows than it has. */
function expectFits(frame: string, columns: number, rows: number) {
  const lines = frame.replace(/\n$/, "").split("\n");
  expect(lines.length).toBeLessThanOrEqual(rows);
  for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
}

describe("screens, for any terminal size and titles", () => {
  it("the PR list fits the terminal", async () => {
    await fc.assert(
      fc.asyncProperty(
        size,
        fc.array(title, { minLength: 1, maxLength: 40 }),
        async (s, titles) => {
          const t = mount(
            <PullRequestList
              repositoryName="demo"
              pullRequests={titles.map((text, i) => ({
                pullRequestId: String(i + 1),
                title: text,
                authorArn: "arn:aws:iam::1:user/u",
                creationDate: new Date("2026-02-13T10:00:00Z"),
                status: i % 3 === 0 ? ("MERGED" as const) : ("OPEN" as const),
              }))}
              onSelect={vi.fn()}
              onBack={vi.fn()}
              onHelp={vi.fn()}
              statusFilter="OPEN"
              onChangeStatusFilter={vi.fn()}
              searchQuery=""
              onChangeSearchQuery={vi.fn()}
              pagination={{ currentPage: 1, hasNextPage: true, hasPreviousPage: true }}
              onNextPage={vi.fn()}
              onPreviousPage={vi.fn()}
            />,
            s.columns,
            s.rows,
          );
          try {
            await vi.waitFor(() => expect(t.frame()).toContain("#1"));
            expectFits(t.frame(), s.columns, s.rows);
            t.source.write("j".repeat(Math.min(titles.length, 8)));
            await vi.waitFor(() => expect(t.frame()).toContain(`> #${Math.min(titles.length, 9)}`));
            expectFits(t.frame(), s.columns, s.rows);
          } finally {
            t.app.unmount();
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 120_000);

  it("the home screen fits the terminal", async () => {
    await fc.assert(
      fc.asyncProperty(
        size,
        fc.array(
          fc.tuple(title, fc.boolean(), fc.constantFrom("demo", "a-very-long-repository-name")),
          {
            minLength: 1,
            maxLength: 30,
          },
        ),
        async (s, rows) => {
          const items: InboxItem[] = rows.map(([t, mine, repo], i) => ({
            section: mine ? "mine" : "awaiting",
            pr: pullRequest({
              id: String(i + 1),
              title: t,
              repository: repo,
              authorArn: mine ? ME : "arn:aws:sts::123456789012:assumed-role/Developer/bob",
            }),
            unread: i % 2 === 0,
            ...(mine
              ? {
                  rules: {
                    approved: false,
                    overridden: false,
                    satisfied: ["a"],
                    notSatisfied: ["b"],
                  },
                  mergeable: i % 3 !== 0,
                  checks: "fail" as const,
                }
              : { approvedBy: [] }),
          }));
          const inbox: Inbox = {
            me: ME,
            repositories: [...new Set(items.map((i) => i.pr.repository))],
            items,
            errors: [
              { repository: "gone", error: new Error("RepositoryDoesNotExistException: gone") },
            ],
            fetchedAt: new Date(),
          };
          const actions: HomeActions = {
            region: "us-east-1",
            me: ME,
            concurrency: 2,
            initial: inbox.repositories,
            watched: () => inbox.repositories,
            cached: async () => undefined,
            fetch: async () => inbox,
            details: async (item) => item,
            save: async () => {},
            unreadMarker: async () => (i) => i,
            markSeen: () => {},
            listRepositories: async () => [...inbox.repositories],
            toggleWatch: async () => inbox.repositories,
            consoleUrl: (pr) => `https://console/${pr.repository}/${pr.id}`,
          };
          const t = mount(
            <HomeApp actions={actions} reviewService={() => ({}) as ReviewService} />,
            s.columns,
            s.rows,
          );
          try {
            await vi.waitFor(() => expect(t.frame()).toContain("Tab switch"));
            expectFits(t.frame(), s.columns, s.rows);
            t.source.write("G");
            await new Promise((r) => setTimeout(r, 30));
            expectFits(t.frame(), s.columns, s.rows);
          } finally {
            t.app.unmount();
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 120_000);
});
