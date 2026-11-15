import { Box, Text } from "ink";
import React from "react";
import { useKeys } from "../hooks/useKeys.js";

export interface HelpSection {
  title?: string;
  keys: [key: string, description: string][];
}

export function HelpScreen({
  title,
  note,
  sections,
  hint = "Press any key to close",
}: {
  title: string;
  note?: string;
  sections: HelpSection[];
  hint?: string;
}) {
  const keyWidth = Math.max(...sections.flatMap((s) => s.keys.map(([k]) => k.length))) + 3;
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        lazycc — {title}
      </Text>
      {note ? <Text dimColor> {note}</Text> : null}
      {sections.map((section, i) => (
        <Box key={section.title ?? i} flexDirection="column" marginTop={section.title ? 1 : 0}>
          {section.title ? (
            <Text bold color="yellow">
              === {section.title} ===
            </Text>
          ) : null}
          {section.keys.map(([k, d]) => (
            <Box key={k + d}>
              <Box minWidth={keyWidth}>
                <Text> {k}</Text>
              </Box>
              <Text>{d}</Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}

const REVIEW_HELP: HelpSection[] = [
  {
    title: "Navigation",
    keys: [
      ["j / ↓", "Cursor down"],
      ["k / ↑", "Cursor up"],
      ["Ctrl+d", "Half page down"],
      ["Ctrl+u", "Half page up"],
      ["G", "Jump to end"],
      ["n", "Next file"],
      ["N", "Previous file"],
      ["]c", "Next change (add/delete line)"],
      ["[c", "Previous change (add/delete line)"],
      ["f", "File list"],
      ["t", "Show more of a large diff"],
      ["Enter", "Select / confirm"],
      ["q / Esc", "Back / quit"],
      ["Ctrl+C", "Exit immediately"],
      ["?", "Toggle this help"],
    ],
  },
  {
    title: "Comments (PR Detail)",
    keys: [
      ["c", "Post comment"],
      ["C", "Post inline comment"],
      ["R", "Reply to comment"],
      ["Tab", "Keep as draft (in a comment box)"],
      ["D", "Drafts: S posts all, e edit, d discard"],
      ["o", "Toggle thread fold"],
      ["e", "Edit comment"],
      ["d", "Delete comment"],
      ["g", "React to comment"],
      ["← / h", "Previous reaction"],
      ["→ / l", "Next reaction"],
    ],
  },
  {
    title: "PR Actions (PR Detail)",
    keys: [
      ["a", "Approve PR"],
      ["r", "Revoke approval"],
      ["m", "Merge PR"],
      ["x", "Close PR without merge"],
      ["A", "Activity timeline"],
      ["Tab", "Switch to commit view"],
      ["Shift+Tab", "Previous commit"],
    ],
  },
  {
    title: "PR List",
    keys: [
      ["f", "Filter by status"],
      ["/", "Search pull requests"],
      ["n", "Next page"],
      ["p", "Previous page"],
    ],
  },
];

export function Help({ onClose }: { onClose: () => void }) {
  useKeys((input, key) => {
    if (input === "?" || input === "q" || key.escape || key.return) {
      onClose();
    }
  });
  return <HelpScreen title="Help" sections={REVIEW_HELP} hint="? / q / Esc / Enter to close" />;
}
