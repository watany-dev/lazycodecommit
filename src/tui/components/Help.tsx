import { Box, Text, useStdin, useStdout } from "ink";
import React, { useEffect, useState } from "react";
import { useKeys } from "../hooks/useKeys.js";
import { useQuit } from "../hooks/useQuit.js";
import { isBottom, isTop } from "../listKeys.js";
import { FilterLine, useFilter, windowStart } from "./FilterLine.js";

/** A key the menu can press for you, as the terminal sends it ("c", "\r", "\x07" for Ctrl+g). */
type Send = string;

export interface HelpSection {
  title?: string;
  keys: [key: string, description: string, send?: Send][];
}

type KeyRow = {
  readonly kind: "key";
  readonly key: string;
  readonly description: string;
  readonly send: Send | undefined;
};
type Row = { readonly kind: "title"; readonly title: string } | KeyRow;

/**
 * spec: ヘルプ. ? opens the screen's keys as a menu, as lazygit's does: / filters
 * them, Enter closes the menu and presses the selected key on the screen.
 */
export function useHelp() {
  const [open, setOpen] = useState(false);
  const [queued, setQueued] = useState<Send | null>(null);
  const { internal_eventEmitter: input } = useStdin();
  useEffect(() => {
    if (queued === null) return;
    setQueued(null);
    // After every handler of the render without the menu has taken over. Not
    // cleared on the re-render that setQueued(null) causes.
    setTimeout(() => input.emit("input", queued), 0);
  }, [queued]);
  return {
    open,
    show: () => setOpen(true),
    close: () => setOpen(false),
    run: (send: Send) => {
      setOpen(false);
      setQueued(send);
    },
  };
}

const CHROME_LINES = 7;

export function HelpMenu({
  title,
  note,
  sections,
  onClose,
  onRun,
}: {
  title: string;
  note?: string;
  sections: HelpSection[];
  onClose: () => void;
  onRun: (send: Send) => void;
}) {
  const { stdout } = useStdout();
  const quit = useQuit();
  const filterBox = useFilter();
  const { filter } = filterBox;
  const [cursor, setCursor] = useState(0);

  const needle = filter.toLowerCase();
  const rows: Row[] = sections.flatMap((s) => {
    const keys = s.keys
      .filter(([k, d]) => k.toLowerCase().includes(needle) || d.toLowerCase().includes(needle))
      .map(([key, description, send]): Row => ({ kind: "key", key, description, send }));
    return s.title && keys.length > 0 ? [{ kind: "title", title: s.title } as Row, ...keys] : keys;
  });
  const entries = rows.filter((r): r is KeyRow => r.kind === "key");
  const index = Math.max(Math.min(cursor, entries.length - 1), 0);
  const selected = entries[index];

  useKeys((input, key) => {
    if (filterBox.handleKey(key)) return;
    if (input === "q") quit();
    else if (key.escape || input === "?") onClose();
    else if (input === "/") {
      filterBox.start();
      setCursor(0);
    } else if (input === "j" || key.downArrow) setCursor(Math.min(index + 1, entries.length - 1));
    else if (input === "k" || key.upArrow) setCursor(Math.max(index - 1, 0));
    else if (isTop(input, key)) setCursor(0);
    else if (isBottom(input, key)) setCursor(Math.max(entries.length - 1, 0));
    else if (key.return) {
      if (selected?.send === undefined) onClose();
      else onRun(selected.send);
    }
  });

  const keyWidth = Math.max(0, ...entries.map((r) => r.key.length)) + 3;
  const height = Math.max((stdout.rows || 24) - CHROME_LINES - (note ? 1 : 0), 3);
  const at = selected ? rows.indexOf(selected) : 0;
  const top = windowStart(at, height, rows.length);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        lazycc — {title}
      </Text>
      {note ? <Text dimColor>{note}</Text> : null}
      <FilterLine state={filterBox} />
      {entries.length === 0 ? <Text dimColor>No key matches.</Text> : null}
      {rows.slice(top, top + height).map((row, i) =>
        row.kind === "title" ? (
          <Text key={`t${top + i}`} bold color="yellow">
            {row.title}
          </Text>
        ) : (
          <Box key={`k${top + i}`}>
            <Text color="cyan">{row === selected ? "> " : "  "}</Text>
            <Box minWidth={keyWidth} flexShrink={0}>
              <Text dimColor={row.send === undefined}>{row.key}</Text>
            </Box>
            <Text dimColor={row.send === undefined} wrap="truncate">
              {row.description}
            </Text>
          </Box>
        ),
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter run / filter Esc close q quit</Text>
      </Box>
    </Box>
  );
}

export const PR_LIST_HELP: HelpSection[] = [
  {
    keys: [
      ["j / k, ↓ / ↑", "Move"],
      ["< / >, Home / End", "First / last pull request"],
      ["Enter", "Review the pull request", "\r"],
      ["f", "Cycle the status filter", "f"],
      ["/", "Search by title or author", "/"],
      [". / n", "Next page", "."],
      [", / p", "Previous page", ","],
      ["Esc", "Back"],
      ["q / Ctrl+c", "Quit"],
    ],
  },
];

export const PR_DETAIL_HELP: HelpSection[] = [
  {
    title: "Moving around",
    keys: [
      ["j / k, ↓ / ↑", "Move the cursor"],
      ["Ctrl+d / J / PgDn", "Half a page down", "\x04"],
      ["Ctrl+u / K / PgUp", "Half a page up", "\x15"],
      ["< / Home", "Jump to the top", "<"],
      ["> / End / G", "Jump to the end", ">"],
      ["n", "Next file", "n"],
      ["N", "Previous file", "N"],
      ["]c / [c", "Next / previous changed line"],
      ["f / Ctrl+g", "File list", "f"],
      ["t", "Show more of a large diff", "t"],
      ["Tab", "Step through all changes and each commit", "\t"],
      ["Shift+Tab", "Step back", "\x1b[Z"],
      ["Esc", "Back"],
      ["q / Ctrl+c", "Quit"],
    ],
  },
  {
    title: "Comments",
    keys: [
      ["c", "Comment on the PR", "c"],
      ["C", "Inline comment on the cursor line", "C"],
      ["R", "Reply to the comment at the cursor", "R"],
      ["Tab", "Keep as a draft (in a comment box)"],
      ["D", "Drafts: S posts all, e edits, d discards", "D"],
      ["o", "Fold or unfold a thread", "o"],
      ["e", "Edit your comment", "e"],
      ["d", "Delete your comment", "d"],
      ["g", "React to the comment", "g"],
    ],
  },
  {
    title: "Pull request",
    keys: [
      ["a", "Approve", "a"],
      ["r", "Revoke approval", "r"],
      ["m / M", "Merge", "m"],
      ["x", "Close without merging", "x"],
      ["A", "Activity timeline", "A"],
    ],
  },
];
