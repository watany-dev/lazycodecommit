import { Box, Text, useStdout } from "ink";
import React, { memo, useEffect, useMemo, useState } from "react";
import type { PrActivityEvent } from "../../core/review.js";
import { shortArn } from "../../core/text.js";
import { useKeys } from "../hooks/useKeys.js";
import { formatRelativeDate } from "../utils/formatDate.js";

/** The title and key lines, each with a blank row above the list or below it. */
const CHROME_LINES = 4;

interface Props {
  pullRequestTitle: string;
  events: PrActivityEvent[];
  isLoading: boolean;
  error: string | null;
  hasNextPage: boolean;
  onLoadNextPage: () => void;
  onBack: () => void;
}

export function ActivityTimeline({
  pullRequestTitle,
  events,
  isLoading,
  error,
  hasNextPage,
  onLoadNextPage,
  onBack,
}: Props) {
  const [cursorIndex, setCursorIndex] = useState(0);
  const { stdout } = useStdout();
  const visibleCount = Math.max((stdout.rows || 24) - CHROME_LINES, 3);

  // A retry after an expired page token starts the list over, shorter.
  useEffect(() => {
    setCursorIndex((prev) => Math.min(prev, Math.max(events.length - 1, 0)));
  }, [events.length]);

  useKeys((input, key) => {
    if (key.escape || input === "q") {
      onBack();
      return;
    }

    if (input === "j" || key.downArrow) {
      setCursorIndex((prev) => Math.min(prev + 1, Math.max(events.length - 1, 0)));
      return;
    }

    if (input === "k" || key.upArrow) {
      setCursorIndex((prev) => Math.max(prev - 1, 0));
      return;
    }

    if (input === "n" && hasNextPage && !isLoading) {
      onLoadNextPage();
      return;
    }
  });

  const scrollOffset = useMemo(() => {
    const halfVisible = Math.floor(visibleCount / 2);
    const maxOffset = Math.max(0, events.length - visibleCount);
    const idealOffset = cursorIndex - halfVisible;
    return Math.max(0, Math.min(idealOffset, maxOffset));
  }, [cursorIndex, events.length, visibleCount]);

  const visibleEvents = events.slice(scrollOffset, scrollOffset + visibleCount);

  if (isLoading && events.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Activity: {pullRequestTitle}</Text>
        <Text color="cyan">Loading activity...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text bold>Activity: {pullRequestTitle}</Text>
        <Text color="red">Failed to load activity:</Text>
        <Text color="red">{error}</Text>
        <Text dimColor>Press q to go back</Text>
      </Box>
    );
  }

  if (events.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Activity: {pullRequestTitle}</Text>
        <Text dimColor>No activity events found.</Text>
        <Text dimColor>q back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Activity: {pullRequestTitle}</Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleEvents.map((event, i) => {
          const globalIndex = scrollOffset + i;
          return (
            <ActivityEventRow
              key={globalIndex}
              event={event}
              isCursor={globalIndex === cursorIndex}
            />
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {isLoading
            ? "Loading more events..."
            : hasNextPage
              ? "↑↓ scroll  n next page  q back"
              : "↑↓ scroll  q back"}
        </Text>
      </Box>
    </Box>
  );
}

const ActivityEventRow = memo(function ActivityEventRow({
  event,
  isCursor,
}: {
  event: PrActivityEvent;
  isCursor: boolean;
}) {
  const icon = getEventIcon(event.eventType);
  const timeAgo = formatRelativeDate(event.eventDate);
  const actorName = shortArn(event.actorArn);
  const actorDisplay = actorName.length > 12 ? `${actorName.slice(0, 11)}…` : actorName.padEnd(12);

  return (
    <Box>
      <Text>{isCursor ? "> " : "  "}</Text>
      <Text>{icon} </Text>
      <Text color="cyan">{actorDisplay} </Text>
      <Text>{event.description.padEnd(40)}</Text>
      <Text dimColor>{timeAgo}</Text>
    </Box>
  );
});

function getEventIcon(eventType: string): string {
  const iconMap: Record<string, string> = {
    PULL_REQUEST_CREATED: "📝",
    PULL_REQUEST_STATUS_CHANGED: "🔄",
    PULL_REQUEST_SOURCE_REFERENCE_UPDATED: "🔀",
    PULL_REQUEST_MERGE_STATE_CHANGED: "✅",
    PULL_REQUEST_APPROVAL_RULE_CREATED: "📋",
    PULL_REQUEST_APPROVAL_RULE_DELETED: "🗑️",
    PULL_REQUEST_APPROVAL_RULE_UPDATED: "✏️",
    PULL_REQUEST_APPROVAL_RULE_OVERRIDDEN: "🔓",
    PULL_REQUEST_APPROVALS_RESET: "🔃",
    PULL_REQUEST_APPROVAL_STATE_CHANGED: "✅",
  };
  /* v8 ignore next -- all known event types are mapped; fallback is defensive */
  return iconMap[eventType] ?? "ℹ️";
}
