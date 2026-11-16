import { render } from "ink-testing-library";
import React from "react";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import type { PrActivityEvent } from "../../core/review.js";
import { settle } from "../../testing/keys.js";
import { ActivityTimeline } from "./ActivityTimeline.js";

vi.mock("../utils/formatDate.js", () => ({
  formatRelativeDate: vi.fn().mockReturnValue("3h ago"),
}));

const makeEvent = (overrides: Partial<PrActivityEvent> = {}): PrActivityEvent => ({
  eventDate: new Date("2026-02-18T09:00:00Z"),
  eventType: "PULL_REQUEST_CREATED",
  actorArn: "arn:aws:iam::123456789012:user/watany",
  description: "created this PR",
  ...overrides,
});

const defaultProps = {
  pullRequestTitle: "fix: login timeout",
  events: [],
  isLoading: false,
  error: null as string | null,
  hasNextPage: false,
  onLoadNextPage: vi.fn(),
  onBack: vi.fn(),
};

describe("ActivityTimeline", () => {
  it("shows loading indicator when isLoading and no events", () => {
    const { lastFrame } = render(
      <ActivityTimeline {...defaultProps} isLoading={true} events={[]} />,
    );
    expect(lastFrame()).toContain("Loading activity...");
    expect(lastFrame()).toContain("fix: login timeout");
  });

  it("shows events list in standard state", () => {
    const events = [makeEvent()];
    const { lastFrame } = render(<ActivityTimeline {...defaultProps} events={events} />);
    const output = lastFrame()!;
    expect(output).toContain("created this PR");
    expect(output).toContain("watany");
    expect(output).toContain("3h ago");
    expect(output).toContain("📝");
  });

  it("shows 'No activity events found.' when events is empty and not loading", () => {
    const { lastFrame } = render(
      <ActivityTimeline {...defaultProps} events={[]} isLoading={false} />,
    );
    expect(lastFrame()).toContain("No activity events found.");
  });

  it("keeps cursor at 0 when j is pressed on an empty list", () => {
    const { lastFrame, stdin } = render(
      <ActivityTimeline {...defaultProps} events={[]} isLoading={false} />,
    );
    stdin.write("j");
    expect(lastFrame()).toContain("No activity events found.");
  });

  it("shows error message and back hint on error", () => {
    const { lastFrame } = render(
      <ActivityTimeline {...defaultProps} error="Access denied. Check your IAM policy." />,
    );
    expect(lastFrame()).toContain("Failed to load activity:");
    expect(lastFrame()).toContain("Access denied. Check your IAM policy.");
    expect(lastFrame()).toContain("Press q to go back");
  });

  it("shows 'n next page' hint when hasNextPage is true", () => {
    const events = [makeEvent()];
    const { lastFrame } = render(
      <ActivityTimeline {...defaultProps} events={events} hasNextPage={true} />,
    );
    expect(lastFrame()).toContain("n next page");
  });

  it("does not show 'n next page' hint when hasNextPage is false", () => {
    const events = [makeEvent()];
    const { lastFrame } = render(
      <ActivityTimeline {...defaultProps} events={events} hasNextPage={false} />,
    );
    expect(lastFrame()).not.toContain("n next page");
  });

  it("moves cursor down with j key", async () => {
    const events = [
      makeEvent({ description: "created this PR" }),
      makeEvent({
        description: "approved this PR",
        eventType: "PULL_REQUEST_APPROVAL_STATE_CHANGED",
        actorArn: "arn:aws:iam::123456789012:user/taro",
        eventDate: new Date("2026-02-18T10:00:00Z"),
      }),
    ];
    const { lastFrame, stdin } = render(<ActivityTimeline {...defaultProps} events={events} />);

    expect(lastFrame()).toContain("> ");

    stdin.write("j");

    await vi.waitFor(() => {
      const output = lastFrame()!;
      const lines = output.split("\n");
      const cursorLine = lines.find((l) => l.includes("> "));
      expect(cursorLine).toContain("approved this PR");
    });
  });

  it("moves cursor down with down arrow key", async () => {
    const events = [
      makeEvent({ description: "created this PR" }),
      makeEvent({
        description: "approved this PR",
        eventType: "PULL_REQUEST_APPROVAL_STATE_CHANGED",
        actorArn: "arn:aws:iam::123456789012:user/taro",
        eventDate: new Date("2026-02-18T10:00:00Z"),
      }),
    ];
    const { lastFrame, stdin } = render(<ActivityTimeline {...defaultProps} events={events} />);

    stdin.write("\u001B[B"); // down arrow

    await vi.waitFor(() => {
      const output = lastFrame()!;
      const lines = output.split("\n");
      const cursorLine = lines.find((l) => l.includes("> "));
      expect(cursorLine).toContain("approved this PR");
    });
  });

  it("moves cursor up with k key", async () => {
    const events = [
      makeEvent({ description: "created this PR" }),
      makeEvent({
        description: "approved this PR",
        eventType: "PULL_REQUEST_APPROVAL_STATE_CHANGED",
        actorArn: "arn:aws:iam::123456789012:user/taro",
        eventDate: new Date("2026-02-18T10:00:00Z"),
      }),
    ];
    const { lastFrame, stdin } = render(<ActivityTimeline {...defaultProps} events={events} />);

    stdin.write("j"); // move to index 1
    await vi.waitFor(() => {
      const output = lastFrame()!;
      const lines = output.split("\n");
      const cursorLine = lines.find((l) => l.includes("> "));
      expect(cursorLine).toContain("approved this PR");
    });

    stdin.write("k"); // move back to index 0

    await vi.waitFor(() => {
      const output = lastFrame()!;
      const lines = output.split("\n");
      const cursorLine = lines.find((l) => l.includes("> "));
      expect(cursorLine).toContain("created this PR");
    });
  });

  it("cursor stays at 0 when k pressed at top", () => {
    const events = [makeEvent({ description: "created this PR" })];
    const { lastFrame, stdin } = render(<ActivityTimeline {...defaultProps} events={events} />);

    stdin.write("k");

    const output = lastFrame()!;
    const lines = output.split("\n");
    const cursorLine = lines.find((l) => l.includes("> "));
    expect(cursorLine).toContain("created this PR");
  });

  it("cursor stays at last item when j pressed at bottom", async () => {
    const events = [
      makeEvent({ description: "created this PR" }),
      makeEvent({
        description: "approved this PR",
        eventType: "PULL_REQUEST_APPROVAL_STATE_CHANGED",
        actorArn: "arn:aws:iam::123456789012:user/taro",
        eventDate: new Date("2026-02-18T10:00:00Z"),
      }),
    ];
    const { lastFrame, stdin } = render(<ActivityTimeline {...defaultProps} events={events} />);

    stdin.write("j"); // move to index 1
    await vi.waitFor(() => {
      const output = lastFrame()!;
      const lines = output.split("\n");
      const cursorLine = lines.find((l) => l.includes("> "));
      expect(cursorLine).toContain("approved this PR");
    });

    stdin.write("j"); // try to go beyond last

    await vi.waitFor(() => {
      const output = lastFrame()!;
      const lines = output.split("\n");
      const cursorLine = lines.find((l) => l.includes("> "));
      expect(cursorLine).toContain("approved this PR");
    });
  });

  it("calls onBack when q is pressed", () => {
    const onBack = vi.fn();
    const { stdin } = render(
      <ActivityTimeline {...defaultProps} events={[makeEvent()]} onBack={onBack} />,
    );
    stdin.write("q");
    expect(onBack).toHaveBeenCalled();
  });

  it("calls onBack when Escape is pressed", async () => {
    const onBack = vi.fn();
    const { stdin } = render(
      <ActivityTimeline {...defaultProps} events={[makeEvent()]} onBack={onBack} />,
    );
    stdin.write("\u001B"); // Escape
    await vi.waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it("calls onLoadNextPage when n is pressed and hasNextPage is true", () => {
    const onLoadNextPage = vi.fn();
    const events = [makeEvent()];
    const { stdin } = render(
      <ActivityTimeline
        {...defaultProps}
        events={events}
        hasNextPage={true}
        onLoadNextPage={onLoadNextPage}
      />,
    );
    stdin.write("n");
    expect(onLoadNextPage).toHaveBeenCalled();
  });

  it("does not call onLoadNextPage when n is pressed and hasNextPage is false", () => {
    const onLoadNextPage = vi.fn();
    const events = [makeEvent()];
    const { stdin } = render(
      <ActivityTimeline
        {...defaultProps}
        events={events}
        hasNextPage={false}
        onLoadNextPage={onLoadNextPage}
      />,
    );
    stdin.write("n");
    expect(onLoadNextPage).not.toHaveBeenCalled();
  });

  it("does not call onLoadNextPage when n is pressed while isLoading is true", () => {
    const onLoadNextPage = vi.fn();
    const events = [makeEvent()];
    const { stdin } = render(
      <ActivityTimeline
        {...defaultProps}
        events={events}
        hasNextPage={true}
        isLoading={true}
        onLoadNextPage={onLoadNextPage}
      />,
    );
    stdin.write("n");
    expect(onLoadNextPage).not.toHaveBeenCalled();
  });

  it("shows 'Loading more events...' when isLoading true and events exist", () => {
    const events = [makeEvent()];
    const { lastFrame } = render(
      <ActivityTimeline {...defaultProps} events={events} isLoading={true} />,
    );
    expect(lastFrame()).toContain("Loading more events...");
    expect(lastFrame()).toContain("created this PR");
  });

  it("truncates long actor names to 12 characters with ellipsis", () => {
    const events = [
      makeEvent({
        actorArn: "arn:aws:iam::123456789012:user/verylongusernamehere",
      }),
    ];
    const { lastFrame } = render(<ActivityTimeline {...defaultProps} events={events} />);
    // Name "verylongusernamehere" (20 chars) gets slice(0, 11) = "verylonguse" + "…"
    expect(lastFrame()).toContain("verylonguse…");
  });

  it("shows PR title in header", () => {
    const { lastFrame } = render(
      <ActivityTimeline
        {...defaultProps}
        pullRequestTitle="My special PR"
        events={[makeEvent()]}
      />,
    );
    expect(lastFrame()).toContain("My special PR");
  });

  it("shows cursor marker '>' on first event by default", () => {
    const events = [makeEvent()];
    const { lastFrame } = render(<ActivityTimeline {...defaultProps} events={events} />);
    const output = lastFrame()!;
    expect(output).toContain("> ");
  });

  it("renders only a window of events when the list is long", () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent({
        description: `event-${String(i).padStart(2, "0")}`,
        eventDate: new Date(Date.UTC(2026, 1, 1, 0, i)),
      }),
    );
    const { lastFrame } = render(<ActivityTimeline {...defaultProps} events={events} />);
    const output = lastFrame()!;
    expect(output).toContain("event-00");
    expect(output).not.toContain("event-49");
  });

  it("scrolls the window so the cursor stays visible", async () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent({
        description: `event-${String(i).padStart(2, "0")}`,
        eventDate: new Date(Date.UTC(2026, 1, 1, 0, i)),
      }),
    );
    const { lastFrame, stdin } = render(<ActivityTimeline {...defaultProps} events={events} />);

    for (let i = 0; i < 20; i++) {
      stdin.write("j");
    }

    await vi.waitFor(() => {
      const output = lastFrame()!;
      const cursorLine = output.split("\n").find((l) => l.includes("> "));
      expect(cursorLine).toContain("event-20");
      expect(output).not.toContain("event-00");
    });
  });

  it("keeps a cursor row when the events are replaced by a shorter list", async () => {
    const many = Array.from({ length: 60 }, (_, i) => makeEvent({ description: `event ${i}` }));
    const screen = render(<ActivityTimeline {...defaultProps} events={many} />);
    for (let i = 0; i < 59; i++) screen.stdin.write("j");
    await settle();
    await vi.waitFor(() => expect(screen.lastFrame()).toMatch(/> .*event 59/));
    // A page token that expired restarts the list from the first page.
    screen.rerender(<ActivityTimeline {...defaultProps} events={many.slice(0, 10)} />);
    await settle();
    expect(screen.lastFrame()).toMatch(/> .*event 9/);
  });

  it("fits the screen in a short terminal, with the cursor on it", async () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ description: `event-${String(i).padStart(2, "0")}` }),
    );
    const screen = render(<ActivityTimeline {...defaultProps} events={events} />);
    Object.defineProperty(screen.stdout, "rows", { value: 12, configurable: true });
    screen.rerender(<ActivityTimeline {...defaultProps} events={[...events]} />);
    await vi.waitFor(() => expect(screen.lastFrame()!.split("\n").length).toBeLessThanOrEqual(12));
    expect(screen.lastFrame()).toContain("> 📝");
    for (let i = 0; i < 49; i++) screen.stdin.write("j");
    await vi.waitFor(() => expect(screen.lastFrame()).toMatch(/> .*event-49/));
    expect(screen.lastFrame()!.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("keeps a long title and long events to one row each in an 80x12 terminal", async () => {
    const long = `${"日本語の長い説明".repeat(8)} ${"x".repeat(80)}`;
    const events = Array.from({ length: 50 }, (_, i) => makeEvent({ description: `${i} ${long}` }));
    const screen = render(
      <ActivityTimeline {...defaultProps} pullRequestTitle={long} events={events} />,
    );
    Object.defineProperty(screen.stdout, "rows", { value: 12, configurable: true });
    Object.defineProperty(screen.stdout, "columns", { value: 80, configurable: true });
    screen.rerender(
      <ActivityTimeline {...defaultProps} pullRequestTitle={long} events={[...events]} />,
    );
    await settle();
    const rows = screen.lastFrame()!.split("\n");
    expect(rows.length).toBeLessThanOrEqual(12);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(80);
    expect(screen.lastFrame()).toMatch(/> 📝 watany +0 日本語/);
    // The time is cut along with the end of the row.
    expect(screen.lastFrame()).not.toContain("3h ago");
  });
});
