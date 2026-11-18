import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import type { HomeActions } from "../../core/home.js";
import { printable } from "../../core/text.js";
import { useKeys } from "../hooks/useKeys.js";
import { useQuit } from "../hooks/useQuit.js";
import { isBottom, isTop } from "../listKeys.js";
import { formatErrorMessage } from "../utils/formatError.js";
import { FilterLine, useFilter, windowStart } from "./FilterLine.js";

interface Props {
  actions: Pick<HomeActions, "listRepositories" | "watched" | "toggleWatch">;
  /** What the home shows now, marked in the list. */
  current: readonly string[] | undefined;
  onSelect: (repository: string) => void;
  onOpenList: (repository: string) => void;
  onBack: () => void;
}

const CHROME_LINES = 7;

/** spec: リポジトリ選択. Enter shows one repository, w (un)watches it, p lists its PRs. */
export function RepoPicker({ actions, current, onSelect, onOpenList, onBack }: Props) {
  const { stdout } = useStdout();
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(actions.watched());
  const [cursor, setCursor] = useState(0);
  const filterBox = useFilter();
  const { filter } = filterBox;
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    actions.listRepositories().then(setNames, (err) => setError(formatErrorMessage(err)));
  }, []);

  const rows = (names ?? []).filter((n) => n.toLowerCase().includes(filter.toLowerCase()));
  const index = Math.max(Math.min(cursor, rows.length - 1), 0);
  const selected = rows[index];

  async function toggle(name: string) {
    setSaving(true);
    try {
      const next = await actions.toggleWatch(name);
      setWatched(next);
      setNote({ text: next.includes(name) ? `Watching ${name}.` : `Stopped watching ${name}.` });
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setSaving(false);
    }
  }

  const quit = useQuit();
  useKeys((input, key) => {
    if (filterBox.handleKey(key)) return;
    if (input === "q") {
      quit();
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    setNote(null);
    if (input === "/") {
      filterBox.start();
      setCursor(0);
    } else if (input === "j" || key.downArrow) {
      setCursor(Math.min(index + 1, Math.max(rows.length - 1, 0)));
    } else if (input === "k" || key.upArrow) {
      setCursor(Math.max(index - 1, 0));
    } else if (isTop(input, key)) setCursor(0);
    else if (isBottom(input, key)) setCursor(Math.max(rows.length - 1, 0));
    else if (selected && key.return) onSelect(selected);
    // One config write at a time; a second w waits for the first to land.
    else if (selected && input === "w" && !saving) void toggle(selected);
    else if (selected && input === "p") onOpenList(selected);
  });

  const height = Math.max((stdout.rows || 24) - CHROME_LINES, 3);
  const top = windowStart(index, height, rows.length);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        lazycc — repositories{" "}
        <Text dimColor>
          ({watched.length > 0 ? `${watched.length} watched` : "none watched yet: press w"})
        </Text>
      </Text>
      <FilterLine state={filterBox} />
      {error ? (
        <Text color="red">Error: {error}</Text>
      ) : !names ? (
        <Text color="cyan">Loading...</Text>
      ) : rows.length === 0 ? (
        <Text dimColor>
          {filter ? "No repository matches." : "No repositories in this region."}
        </Text>
      ) : (
        rows.slice(top, top + height).map((name) => (
          <Box key={name}>
            <Text color="cyan">{name === selected ? "> " : "  "}</Text>
            <Text color="yellow">{watched.includes(name) ? "★ " : "  "}</Text>
            <Text bold={current?.includes(name) ?? false}>{name}</Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        {saving ? (
          <Text color="cyan">Saving...</Text>
        ) : note ? (
          <Text {...(note.error ? { color: "red" } : {})}>{printable(note.text)}</Text>
        ) : (
          <Text dimColor>Enter show w watch/unwatch p PR list / filter Esc back q quit</Text>
        )}
      </Box>
    </Box>
  );
}
