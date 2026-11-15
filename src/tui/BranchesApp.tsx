import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";
import {
  type BranchActions,
  type BranchRow,
  type BranchTable,
  rulesSummary,
  STATE_LABEL,
} from "../core/branch.js";
import type { ReviewService } from "../core/review.js";
import { printable } from "../core/text.js";
import { App as ReviewApp } from "./ReviewApp.js";
import { type TopSwitch, topSwitch } from "./top.js";
import { formatRelativeDate } from "./utils/formatDate.js";
import { formatErrorMessage, screenErrorText } from "./utils/formatError.js";

/** How the screen opens: on the table, on a PR just created, or with a note from a failed create. */
export type BranchesStart =
  | { readonly reviewPullRequestId: string }
  | { readonly message: string }
  | null;

interface Props {
  actions: BranchActions;
  service: ReviewService;
  start: BranchesStart;
  /** Leaves the TUI so the caller can create a PR from `head` in the plain terminal. */
  onCreate: (head: string) => void;
  /** 1 / 3 / r: leave for home, browse, or the repository picker. */
  onSwitch?: (s: TopSwitch) => void;
}

type Note = { readonly text: string; readonly error?: boolean };

const CHROME_LINES = 7;

export function BranchesApp({ actions, service, start, onCreate, onSwitch }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [table, setTable] = useState<BranchTable | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<BranchRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [note, setNote] = useState<Note | null>(
    start && "message" in start ? { text: start.message, error: true } : null,
  );
  const [reviewing, setReviewing] = useState<string | null>(
    start && "reviewPullRequestId" in start ? start.reviewPullRequestId : null,
  );

  async function load(fetch: boolean) {
    setLoading(true);
    setLoadError(null);
    try {
      setTable(await actions.load({ fetch }));
    } catch (err) {
      setLoadError(formatErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function act(run: () => Promise<void>, done: string) {
    setBusy(true);
    try {
      await run();
      setNote({ text: done });
      await load(false);
    } catch (err) {
      setNote({ text: screenErrorText(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(false);
  }, []);

  const rows = (table?.rows ?? []).filter((r) => r.name.includes(filter));
  // The table can shrink under the cursor (a delete, a filter).
  const index = Math.max(Math.min(cursor, rows.length - 1), 0);
  const selected = rows[index];

  useInput(
    (input, key) => {
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      if (confirmDelete) {
        const row = confirmDelete;
        setConfirmDelete(null);
        if (input === "y") void act(() => actions.deleteBranch(row), `Deleted origin/${row.name}.`);
        return;
      }
      if (filtering) {
        if (key.escape) {
          setFiltering(false);
          setFilter("");
        } else if (key.return) setFiltering(false);
        return;
      }
      if (busy) return;
      if (input === "q" || key.escape) {
        exit();
        return;
      }
      if (input === "?") {
        setShowHelp(true);
        return;
      }
      const top = onSwitch && topSwitch(input, key, "branches");
      if (top) {
        onSwitch?.(top);
        exit();
        return;
      }
      // Rows are stale until the reload lands, and a second load could finish first.
      if (loading) return;
      if (key.ctrl && input === "r") {
        setNote(null);
        void load(true);
        return;
      }
      if (input === "/") {
        setFiltering(true);
        setCursor(0);
        return;
      }
      if (input === "j" || key.downArrow) {
        setCursor(Math.min(index + 1, Math.max(rows.length - 1, 0)));
        return;
      }
      if (input === "k" || key.upArrow) {
        setCursor(Math.max(index - 1, 0));
        return;
      }
      if (!selected) return;
      setNote(null);
      if (key.return) {
        if (selected.state === "open" && selected.pr) setReviewing(selected.pr.id);
        else setNote({ text: `${selected.name} has no open pull request. Press n to create one.` });
      } else if (input === "n") {
        if (selected.state === "open") {
          setNote({ text: `${selected.name} already has #${selected.pr?.id}. Press Enter.` });
        } else if (selected.isDefault) {
          setNote({ text: `${selected.name} is the default branch.`, error: true });
        } else {
          onCreate(selected.name);
          exit();
        }
      } else if (input === "d") {
        if (selected.isDefault) {
          setNote({ text: `${selected.name} is the default branch.`, error: true });
        } else if (selected.state === "open") {
          setNote({ text: `${selected.name} has an open pull request.`, error: true });
        } else setConfirmDelete(selected);
      } else if (input === " ") {
        const switchBranch = actions.switchBranch;
        if (!switchBranch)
          setNote({ text: "Switching needs a clone of the repository.", error: true });
        else void act(() => switchBranch(selected), `Switched to ${selected.name}.`);
      } else if (input === "u") {
        setNote({ text: actions.consoleUrl(selected.name) });
      }
    },
    { isActive: reviewing === null },
  );

  if (reviewing !== null) {
    return (
      <ReviewApp
        service={service}
        repository={actions.repository}
        start={{ pullRequestId: reviewing }}
        onExit={() => {
          setReviewing(null);
          // An approval, merge or close may have changed the row.
          void load(false);
        }}
      />
    );
  }

  if (showHelp) return <BranchHelp />;

  const height = Math.max((stdout.rows || 24) - CHROME_LINES, 3);
  const top = Math.max(0, Math.min(index - height + 1, rows.length - height));
  const visible = rows.slice(top, top + height);
  const nameWidth = Math.min(Math.max(8, ...rows.map((r) => r.name.length)) + 2, 40);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        lazycc — branches of {actions.repository}
      </Text>
      <Box>
        {filtering ? (
          <>
            <Text>/</Text>
            <TextInput value={filter} onChange={setFilter} />
          </>
        ) : (
          <Text dimColor>{filter ? `filter: ${filter}` : " "}</Text>
        )}
      </Box>
      {loading && !table ? (
        <Text color="cyan">Loading...</Text>
      ) : loadError ? (
        <Text color="red">Error: {printable(loadError)}</Text>
      ) : rows.length === 0 ? (
        <Text dimColor>{filter ? "No branch matches." : "No branches."}</Text>
      ) : (
        visible.map((row) => (
          <BranchLine key={row.name} row={row} selected={row === selected} nameWidth={nameWidth} />
        ))
      )}
      <Box marginTop={1}>
        {confirmDelete ? (
          <Text color="yellow">
            Delete origin/{printable(confirmDelete.name)} on CodeCommit? (y/n)
          </Text>
        ) : busy || (loading && table) ? (
          <Text color="cyan">Working...</Text>
        ) : note ? (
          <Text {...(note.error ? { color: "red" } : {})}>{printable(note.text)}</Text>
        ) : (
          <Text dimColor>
            Enter review n new PR d delete{actions.switchBranch ? " Space switch" : ""} / filter
            Ctrl+r refresh u URL{onSwitch ? " r repositories 1 home 3 browse" : ""} q quit ? help
          </Text>
        )}
      </Box>
    </Box>
  );
}

function BranchLine({
  row,
  selected,
  nameWidth,
}: {
  row: BranchRow;
  selected: boolean;
  nameWidth: number;
}) {
  const name = `${row.isDefault ? "* " : "  "}${printable(row.name)}`;
  return (
    <Box>
      <Text color="cyan">{selected ? "> " : "  "}</Text>
      <Box width={nameWidth + 2} flexShrink={0}>
        <Text bold={row.isDefault} wrap="truncate">
          {name}
        </Text>
      </Box>
      <Box width={8} flexShrink={0}>
        <Text color={STATE_COLOR[row.state]} dimColor={row.state === "none"}>
          {STATE_LABEL[row.state]}
        </Text>
      </Box>
      <Box width={10} flexShrink={0}>
        <Text>{row.ahead === undefined ? "" : `↑${row.ahead} ↓${row.behind}`}</Text>
      </Box>
      <Box width={18} flexShrink={0}>
        <Text dimColor wrap="truncate">
          {row.lastCommit
            ? `${formatRelativeDate(row.lastCommit.date)} ${printable(row.lastCommit.author)}`
            : ""}
        </Text>
      </Box>
      <Text wrap="truncate">
        {row.pr ? `#${row.pr.id} ${printable(row.pr.title)}` : ""}
        {row.rules ? (
          <Text color={row.rules.approved ? "green" : "yellow"}> {rulesSummary(row.rules)}</Text>
        ) : null}
      </Text>
    </Box>
  );
}

const STATE_COLOR: Record<BranchRow["state"], string> = {
  open: "green",
  merged: "magenta",
  none: "white",
};

function BranchHelp() {
  const keys: [string, string][] = [
    ["j / k, ↓ / ↑", "Move"],
    ["Enter", "Review the branch's open PR"],
    ["n", "Create a PR from the branch"],
    ["d", "Delete the branch on CodeCommit (not the local one)"],
    ["Space", "Switch to the branch (git switch, clone only)"],
    ["/", "Filter by name"],
    ["Ctrl+r", "git fetch origin and reload"],
    ["u", "Show the branch's console URL"],
    ["q / Esc", "Quit"],
  ];
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        lazycc — Branches help
      </Text>
      {keys.map(([k, d]) => (
        <Box key={k}>
          <Box minWidth={16}>
            <Text> {k}</Text>
          </Box>
          <Text>{d}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>Press any key to close</Text>
      </Box>
    </Box>
  );
}
