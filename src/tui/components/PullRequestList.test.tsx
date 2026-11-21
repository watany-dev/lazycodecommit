import React from "react";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import { press, render, settle } from "../../testing/keys.js";
import { QuitProvider } from "../hooks/useQuit.js";
import { PullRequestList } from "./PullRequestList.js";

describe("PullRequestList", () => {
  const pullRequests = [
    {
      pullRequestId: "42",
      title: "fix: login timeout",
      authorArn: "arn:aws:iam::123456789012:user/watany",
      creationDate: new Date("2026-02-13T10:00:00Z"),
      status: "OPEN" as const,
    },
    {
      pullRequestId: "43",
      title: "feat: add dashboard",
      authorArn: "arn:aws:iam::123456789012:user/taro",
      creationDate: new Date("2026-02-12T10:00:00Z"),
      status: "OPEN" as const,
    },
  ];

  const defaultProps = {
    repositoryName: "my-service",
    pullRequests,
    onSelect: vi.fn(),
    onBack: vi.fn(),
    onHelp: vi.fn(),
    statusFilter: "OPEN" as const,
    onChangeStatusFilter: vi.fn(),
    searchQuery: "",
    onChangeSearchQuery: vi.fn(),
    pagination: { currentPage: 1, hasNextPage: false, hasPreviousPage: false },
    onNextPage: vi.fn(),
    onPreviousPage: vi.fn(),
  };

  it("renders pull request titles", () => {
    const { lastFrame } = render(<PullRequestList {...defaultProps} />);
    const output = lastFrame();
    expect(output).toContain("fix: login timeout");
    expect(output).toContain("feat: add dashboard");
  });

  it("shows repository name and PR count", () => {
    const { lastFrame } = render(<PullRequestList {...defaultProps} />);
    const output = lastFrame();
    expect(output).toContain("my-service");
    expect(output).toContain("Open Pull Requests");
    expect(output).toContain("(2)");
  });

  it("shows empty message when no PRs", () => {
    const { lastFrame } = render(<PullRequestList {...defaultProps} pullRequests={[]} />);
    expect(lastFrame()).toContain("No open pull requests");
  });

  it("highlights first item by default", () => {
    const { lastFrame } = render(<PullRequestList {...defaultProps} />);
    expect(lastFrame()).toContain("> ");
    expect(lastFrame()).toContain("#42");
  });

  it("shows navigation hints", () => {
    const { lastFrame } = render(<PullRequestList {...defaultProps} />);
    expect(lastFrame()).toContain("navigate");
    expect(lastFrame()).toContain("back");
    expect(lastFrame()).toContain("help");
  });

  it("navigates down with j key", () => {
    const { lastFrame, stdin } = render(<PullRequestList {...defaultProps} />);
    stdin.write("j");
    expect(lastFrame()).toContain("> ");
    expect(lastFrame()).toContain("#43");
  });

  it("navigates up with k key", () => {
    const { lastFrame, stdin } = render(<PullRequestList {...defaultProps} />);
    stdin.write("j");
    stdin.write("k");
    const output = lastFrame();
    expect(output).toContain("#42");
  });

  it("calls onSelect on enter", () => {
    const onSelect = vi.fn();
    const { stdin } = render(<PullRequestList {...defaultProps} onSelect={onSelect} />);
    stdin.write("\r");
    expect(onSelect).toHaveBeenCalledWith("42");
  });

  it("goes back on Esc and quits lazycc on q", async () => {
    const onBack = vi.fn();
    const onQuit = vi.fn();
    const { stdin } = render(
      <QuitProvider onQuit={onQuit}>
        <PullRequestList {...defaultProps} onBack={onBack} />
      </QuitProvider>,
    );
    stdin.write("q");
    expect(onQuit).toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    const other = render(<PullRequestList {...defaultProps} onBack={onBack} />);
    other.stdin.write("\u001B");
    await vi.waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it("pages with . and , and goes to the first and last PR with < > and Home End", async () => {
    const onNextPage = vi.fn();
    const onPreviousPage = vi.fn();
    const screen = render(
      <PullRequestList
        {...defaultProps}
        pagination={{ currentPage: 2, hasNextPage: true, hasPreviousPage: true }}
        onNextPage={onNextPage}
        onPreviousPage={onPreviousPage}
      />,
    );
    await press(screen, ".", ",");
    expect(onNextPage).toHaveBeenCalledOnce();
    expect(onPreviousPage).toHaveBeenCalledOnce();
    await press(screen, ">");
    const last = screen.lastFrame();
    await press(screen, "<");
    expect(screen.lastFrame()).not.toBe(last);
    await press(screen, "\x1b[F");
    expect(screen.lastFrame()).toBe(last);
    await press(screen, "\x1b[H");
    expect(screen.lastFrame()).not.toBe(last);
  });

  it("calls onHelp on ? key", () => {
    const onHelp = vi.fn();
    const { stdin } = render(<PullRequestList {...defaultProps} onHelp={onHelp} />);
    stdin.write("?");
    expect(onHelp).toHaveBeenCalled();
  });

  it("does not go below last item", () => {
    const { lastFrame, stdin } = render(<PullRequestList {...defaultProps} />);
    stdin.write("j");
    stdin.write("j");
    stdin.write("j");
    expect(lastFrame()).toContain("#43");
  });

  it("does not go above first item", () => {
    const { lastFrame, stdin } = render(<PullRequestList {...defaultProps} />);
    stdin.write("k");
    expect(lastFrame()).toContain("#42");
  });

  // Status filter tests
  describe("status filter", () => {
    it("shows current filter as highlighted", () => {
      const { lastFrame } = render(<PullRequestList {...defaultProps} statusFilter="OPEN" />);
      expect(lastFrame()).toContain("[Open]");
    });

    it("calls onChangeStatusFilter with CLOSED when f key pressed from OPEN", () => {
      const onChangeStatusFilter = vi.fn();
      const { stdin } = render(
        <PullRequestList {...defaultProps} onChangeStatusFilter={onChangeStatusFilter} />,
      );
      stdin.write("f");
      expect(onChangeStatusFilter).toHaveBeenCalledWith("CLOSED");
    });

    it("calls onChangeStatusFilter with MERGED when f key pressed from CLOSED", () => {
      const onChangeStatusFilter = vi.fn();
      const { stdin } = render(
        <PullRequestList
          {...defaultProps}
          statusFilter="CLOSED"
          onChangeStatusFilter={onChangeStatusFilter}
        />,
      );
      stdin.write("f");
      expect(onChangeStatusFilter).toHaveBeenCalledWith("MERGED");
    });

    it("calls onChangeStatusFilter with OPEN when f key pressed from MERGED", () => {
      const onChangeStatusFilter = vi.fn();
      const { stdin } = render(
        <PullRequestList
          {...defaultProps}
          statusFilter="MERGED"
          onChangeStatusFilter={onChangeStatusFilter}
        />,
      );
      stdin.write("f");
      expect(onChangeStatusFilter).toHaveBeenCalledWith("OPEN");
    });

    it("shows Closed header when filter is CLOSED", () => {
      const { lastFrame } = render(
        <PullRequestList {...defaultProps} statusFilter="CLOSED" pullRequests={[]} />,
      );
      expect(lastFrame()).toContain("Closed Pull Requests");
      expect(lastFrame()).toContain("No closed pull requests");
    });

    it("shows Merged header when filter is MERGED", () => {
      const { lastFrame } = render(
        <PullRequestList {...defaultProps} statusFilter="MERGED" pullRequests={[]} />,
      );
      expect(lastFrame()).toContain("Merged Pull Requests");
      expect(lastFrame()).toContain("No merged pull requests");
    });

    it("shows CLOSED badge for closed PRs", () => {
      const closedPRs = [
        {
          pullRequestId: "35",
          title: "fix: typos",
          authorArn: "arn:aws:iam::123456789012:user/hanako",
          creationDate: new Date("2026-02-09T10:00:00Z"),
          status: "CLOSED" as const,
        },
      ];
      const { lastFrame } = render(
        <PullRequestList {...defaultProps} statusFilter="CLOSED" pullRequests={closedPRs} />,
      );
      expect(lastFrame()).toContain("CLOSED");
    });

    it("shows MERGED badge for merged PRs", () => {
      const mergedPRs = [
        {
          pullRequestId: "40",
          title: "feat: auth",
          authorArn: "arn:aws:iam::123456789012:user/watany",
          creationDate: new Date("2026-02-11T10:00:00Z"),
          status: "MERGED" as const,
        },
      ];
      const { lastFrame } = render(
        <PullRequestList {...defaultProps} statusFilter="MERGED" pullRequests={mergedPRs} />,
      );
      expect(lastFrame()).toContain("MERGED");
    });

    it("shows no badge for open PRs", () => {
      const { lastFrame } = render(<PullRequestList {...defaultProps} />);
      const output = lastFrame() ?? "";
      // Open PRs should not have CLOSED or MERGED badge
      const lines = output.split("\n");
      const prLine = lines.find((l: string) => l.includes("#42"));
      expect(prLine).not.toContain("CLOSED");
      expect(prLine).not.toContain("MERGED");
    });

    it("shows footer with filter keybind", () => {
      const { lastFrame } = render(<PullRequestList {...defaultProps} />);
      expect(lastFrame()).toContain("f filter");
    });
  });

  // Search tests
  describe("search", () => {
    it("enters search mode on / key", async () => {
      const { lastFrame, stdin } = render(<PullRequestList {...defaultProps} />);
      stdin.write("/");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Search:");
      });
    });

    it("shows search footer in search mode", async () => {
      const { lastFrame, stdin } = render(<PullRequestList {...defaultProps} />);
      stdin.write("/");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Esc clear search");
      });
    });

    it("exits search mode and clears query on Esc", async () => {
      const onChangeSearchQuery = vi.fn();
      const { lastFrame, stdin } = render(
        <PullRequestList {...defaultProps} onChangeSearchQuery={onChangeSearchQuery} />,
      );
      stdin.write("/");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Search:");
      });
      stdin.write("\x1b"); // Esc
      await vi.waitFor(() => {
        expect(lastFrame()).not.toContain("Search:");
      });
      expect(onChangeSearchQuery).toHaveBeenCalledWith("");
    });

    it("filters by title when searchQuery is set", () => {
      const { lastFrame } = render(<PullRequestList {...defaultProps} searchQuery="login" />);
      expect(lastFrame()).toContain("fix: login timeout");
      expect(lastFrame()).not.toContain("feat: add dashboard");
      expect(lastFrame()).toContain('matching "login"');
      expect(lastFrame()).toContain("(1)");
    });

    it("filters by author name when searchQuery matches", () => {
      const { lastFrame } = render(<PullRequestList {...defaultProps} searchQuery="taro" />);
      expect(lastFrame()).toContain("feat: add dashboard");
      expect(lastFrame()).not.toContain("fix: login timeout");
    });

    it("is case insensitive", () => {
      const { lastFrame } = render(<PullRequestList {...defaultProps} searchQuery="LOGIN" />);
      expect(lastFrame()).toContain("fix: login timeout");
    });

    it("shows no matching message when search has no results", () => {
      const { lastFrame } = render(<PullRequestList {...defaultProps} searchQuery="nonexistent" />);
      expect(lastFrame()).toContain("No matching pull requests");
    });

    it("ignores f key in search mode", async () => {
      const onChangeStatusFilter = vi.fn();
      const { lastFrame, stdin } = render(
        <PullRequestList {...defaultProps} onChangeStatusFilter={onChangeStatusFilter} />,
      );
      stdin.write("/");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Search:");
      });
      stdin.write("f");
      expect(onChangeStatusFilter).not.toHaveBeenCalled();
    });

    it("ignores n key in search mode", async () => {
      const onNextPage = vi.fn();
      const { lastFrame, stdin } = render(
        <PullRequestList
          {...defaultProps}
          onNextPage={onNextPage}
          pagination={{ currentPage: 1, hasNextPage: true, hasPreviousPage: false }}
        />,
      );
      stdin.write("/");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Search:");
      });
      stdin.write("n");
      expect(onNextPage).not.toHaveBeenCalled();
    });

    it("ignores p key in search mode", async () => {
      const onPreviousPage = vi.fn();
      const { lastFrame, stdin } = render(
        <PullRequestList
          {...defaultProps}
          onPreviousPage={onPreviousPage}
          pagination={{ currentPage: 2, hasNextPage: false, hasPreviousPage: true }}
        />,
      );
      stdin.write("/");
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("Search:");
      });
      stdin.write("p");
      expect(onPreviousPage).not.toHaveBeenCalled();
    });

    it("shows PR count in header", () => {
      const { lastFrame } = render(<PullRequestList {...defaultProps} />);
      expect(lastFrame()).toContain("(2)");
    });
  });

  // Pagination tests
  describe("pagination", () => {
    it("shows page number", () => {
      const { lastFrame } = render(<PullRequestList {...defaultProps} />);
      expect(lastFrame()).toContain("Page 1");
    });

    it("calls onNextPage on n key when hasNextPage", () => {
      const onNextPage = vi.fn();
      const { stdin } = render(
        <PullRequestList
          {...defaultProps}
          onNextPage={onNextPage}
          pagination={{ currentPage: 1, hasNextPage: true, hasPreviousPage: false }}
        />,
      );
      stdin.write("n");
      expect(onNextPage).toHaveBeenCalled();
    });

    it("calls onPreviousPage on p key when hasPreviousPage", () => {
      const onPreviousPage = vi.fn();
      const { stdin } = render(
        <PullRequestList
          {...defaultProps}
          onPreviousPage={onPreviousPage}
          pagination={{ currentPage: 2, hasNextPage: false, hasPreviousPage: true }}
        />,
      );
      stdin.write("p");
      expect(onPreviousPage).toHaveBeenCalled();
    });

    it("does not call onNextPage when no next page", () => {
      const onNextPage = vi.fn();
      const { stdin } = render(
        <PullRequestList
          {...defaultProps}
          onNextPage={onNextPage}
          pagination={{ currentPage: 1, hasNextPage: false, hasPreviousPage: false }}
        />,
      );
      stdin.write("n");
      expect(onNextPage).not.toHaveBeenCalled();
    });

    it("does not call onPreviousPage when no previous page", () => {
      const onPreviousPage = vi.fn();
      const { stdin } = render(
        <PullRequestList
          {...defaultProps}
          onPreviousPage={onPreviousPage}
          pagination={{ currentPage: 1, hasNextPage: false, hasPreviousPage: false }}
        />,
      );
      stdin.write("p");
      expect(onPreviousPage).not.toHaveBeenCalled();
    });

    it("shows n next when hasNextPage", () => {
      const { lastFrame } = render(
        <PullRequestList
          {...defaultProps}
          pagination={{ currentPage: 1, hasNextPage: true, hasPreviousPage: false }}
        />,
      );
      expect(lastFrame()).toContain(". next");
    });

    it("shows p prev when hasPreviousPage", () => {
      const { lastFrame } = render(
        <PullRequestList
          {...defaultProps}
          pagination={{ currentPage: 2, hasNextPage: false, hasPreviousPage: true }}
        />,
      );
      expect(lastFrame()).toContain(", prev");
    });

    it("shows both n next and p prev on middle page", () => {
      const { lastFrame } = render(
        <PullRequestList
          {...defaultProps}
          pagination={{ currentPage: 2, hasNextPage: true, hasPreviousPage: true }}
        />,
      );
      expect(lastFrame()).toContain(", prev");
      expect(lastFrame()).toContain(". next");
      expect(lastFrame()).toContain("Page 2");
    });
  });

  it("does not call onSelect when pressing enter on empty list", () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <PullRequestList {...defaultProps} pullRequests={[]} onSelect={onSelect} />,
    );
    stdin.write("\r");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("highlights the first row after pressing j on an empty list and items arrive", async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame, rerender } = render(
      <PullRequestList {...defaultProps} pullRequests={[]} onSelect={onSelect} />,
    );
    await press(stdin, "j");
    rerender(<PullRequestList {...defaultProps} onSelect={onSelect} />);
    await vi.waitFor(() => expect(lastFrame()).toContain("> #42"));
    stdin.write("\r");
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("42"));
  });

  it("keeps the search and leaves search mode on Enter, as / filters do", async () => {
    const onChangeSearchQuery = vi.fn();
    const screen = render(
      <PullRequestList
        {...defaultProps}
        searchQuery="login"
        onChangeSearchQuery={onChangeSearchQuery}
      />,
    );
    await press(screen, "/");
    expect(screen.lastFrame()).toContain("Search:");
    await press(screen, "\r");
    expect(screen.lastFrame()).not.toContain("Search:");
    expect(screen.lastFrame()).toContain('matching "login"');
    expect(onChangeSearchQuery).not.toHaveBeenCalledWith("");
  });

  it("keeps the cursor row on a 24-row screen with a full page of 25 PRs", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      pullRequestId: String(i + 1),
      title: `title ${i + 1}`,
      authorArn: "arn:aws:iam::1:user/u",
      creationDate: new Date("2026-02-13T10:00:00Z"),
      status: "OPEN" as const,
    }));
    const screen = render(<PullRequestList {...defaultProps} pullRequests={many} />);
    for (const step of [0, 12, 12]) {
      for (let i = 0; i < step; i++) screen.stdin.write("j");
      await settle();
      const frame = screen.lastFrame()!;
      expect(frame.split("\n").length).toBeLessThanOrEqual(24);
      expect(frame).toMatch(/> #\d+/);
    }
    expect(screen.lastFrame()).toContain("> #25");
  });

  it("keeps long titles to one row each in an 80x24 terminal", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      pullRequestId: String(i + 1),
      title: `${"日本語のタイトル".repeat(6)} ${i + 1}`,
      authorArn: "arn:aws:iam::1:user/u",
      creationDate: new Date("2026-02-13T10:00:00Z"),
      status: "OPEN" as const,
    }));
    const screen = render(<PullRequestList {...defaultProps} pullRequests={many} />);
    Object.defineProperty(screen.stdout, "columns", { value: 80, configurable: true });
    await press(screen, "j");
    const rows = screen.lastFrame()!.split("\n");
    expect(rows.length).toBeLessThanOrEqual(24);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(80);
    expect(screen.lastFrame()).toMatch(/> #2 /);
  });
  describe("from mutation testing", () => {
    const third = {
      pullRequestId: "44",
      title: "docs: readme",
      authorArn: "arn:aws:iam::123456789012:user/hanako",
      creationDate: new Date("2026-02-11T10:00:00Z"),
      status: "OPEN" as const,
    };
    const cursorOn = (frame: string | undefined) =>
      frame
        ?.split("\n")
        .filter((l) => /^ *> #/.test(l))
        .map((l) => /#(\d+)/.exec(l)?.[1]);

    it("moves one row at a time with k and the arrows, and opens the row under the cursor", async () => {
      const onSelect = vi.fn();
      const screen = render(
        <PullRequestList
          {...defaultProps}
          pullRequests={[...pullRequests, third]}
          onSelect={onSelect}
        />,
      );
      await press(screen.stdin, "k");
      expect(cursorOn(screen.lastFrame())).toEqual(["42"]);
      await press(screen.stdin, "j", "\u001B[B");
      expect(cursorOn(screen.lastFrame())).toEqual(["44"]);
      await press(screen.stdin, "k");
      expect(cursorOn(screen.lastFrame())).toEqual(["43"]);
      await press(screen.stdin, "\u001B[A");
      expect(cursorOn(screen.lastFrame())).toEqual(["42"]);
      await press(screen.stdin, "x");
      expect(onSelect).not.toHaveBeenCalled();
      await press(screen.stdin, ">", "\r");
      expect(onSelect).toHaveBeenCalledWith("44");
    });

    it("pulls the cursor back when a search leaves fewer rows", async () => {
      const props = { ...defaultProps, pullRequests: [...pullRequests, third] };
      const screen = render(<PullRequestList {...props} />);
      await press(screen.stdin, ">");
      screen.rerender(<PullRequestList {...props} searchQuery="fix" />);
      await vi.waitFor(() => expect(cursorOn(screen.lastFrame())).toEqual(["42"]));
    });

    it("shows prev and next on the page line only when there is such a page", () => {
      const page = (hasPreviousPage: boolean, hasNextPage: boolean) =>
        render(
          <PullRequestList
            {...defaultProps}
            pagination={{ currentPage: 2, hasPreviousPage, hasNextPage }}
          />,
        )
          .lastFrame()
          ?.split("\n")
          .find((l) => l.includes("Page 2"))
          ?.trim();
      expect(page(false, false)).toBe("Page 2");
      expect(page(true, false)).toBe("Page 2  , prev");
      expect(page(false, true)).toBe("Page 2  . next");
    });
  });
});
