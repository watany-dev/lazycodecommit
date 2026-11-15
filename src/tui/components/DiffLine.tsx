import { Text } from "ink";
import React from "react";
import type { DisplayLine } from "../utils/formatDiff.js";

/**
 * Memoized row: display lines have stable identity (cached in buildDisplayLines),
 * so rows re-render only when the cursor enters or leaves them.
 * A single top-level Text (nested Texts render inline) keeps the layout
 * tree at one node per row instead of a Box plus two Texts.
 */
export const DiffRow = React.memo(function DiffRow({
  line,
  isCursor,
}: {
  line: DisplayLine;
  isCursor: boolean;
}) {
  return (
    <Text>
      {isCursor ? "> " : "  "}
      {renderDiffLine(line, isCursor)}
    </Text>
  );
});

function formatGutter(line: DisplayLine): string {
  const before =
    line.beforeLineNumber !== undefined ? String(line.beforeLineNumber).padStart(4) : "    ";
  const after =
    line.afterLineNumber !== undefined ? String(line.afterLineNumber).padStart(4) : "    ";
  return `${before} ${after} │ `;
}

const DIFF_COLOR = { add: "green", delete: "red", context: undefined } as const;

/** Ink's color prop does not take undefined (exactOptionalPropertyTypes). */
const colorProp = (color: string | undefined) => (color ? { color } : {});

function renderDiffLine(line: DisplayLine, isCursor = false): React.ReactNode {
  switch (line.type) {
    case "header":
      return (
        <Text bold color="yellow">
          {line.text}
        </Text>
      );
    case "add":
    case "delete":
    case "context":
      return (
        <Text {...colorProp(DIFF_COLOR[line.type])} bold={isCursor}>
          <Text dimColor>{formatGutter(line)}</Text>
          {line.text}
        </Text>
      );
    case "separator":
    case "truncate-context":
    case "truncation":
      return <Text dimColor>{line.text}</Text>;
    case "comment-header":
      return <Text bold>{line.text}</Text>;
    case "comment":
    case "inline-comment":
    case "comment-reply":
    case "inline-reply":
      return (
        <Text {...colorProp(line.type.startsWith("inline") ? "magenta" : undefined)}>
          {line.type.endsWith("reply") ? "   " : " "}
          {line.text}
          {line.reactionText ? <Text dimColor> {line.reactionText}</Text> : null}
        </Text>
      );
    case "fold-indicator":
      return (
        <Text dimColor>
          {"   "}
          {line.text}
        </Text>
      );
  }
}
