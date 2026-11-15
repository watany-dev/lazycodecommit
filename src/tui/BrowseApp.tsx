import { Box, Text, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";
import type { FolderEntry } from "../aws/codecommit.js";
import { type BrowseActions, type BrowseNode, ENTRY_MARK, NotFoundError } from "../core/browse.js";
import { printable } from "../core/text.js";
import { FilterLine, useFilter, windowStart } from "./components/FilterLine.js";
import { HelpScreen, type HelpSection } from "./components/Help.js";
import { useKeys } from "./hooks/useKeys.js";
import { type TopSwitch, topSwitch } from "./top.js";
import { screenErrorText } from "./utils/formatError.js";

interface Props {
  actions: BrowseActions;
  /** Where to open: a folder ("" is the root, "src/" a folder only) or a file. */
  path: string;
  /** 1 / 2 / r: leave for home, the branch table, or the repository picker. */
  onSwitch?: (s: TopSwitch) => void;
}

type Note = { readonly text: string; readonly error?: boolean };
type File = Extract<BrowseNode, { kind: "file" }>;
type Folder = Extract<BrowseNode, { kind: "folder" }>;
type RefPicker = { readonly branches: readonly string[] | null; readonly input: string };

const CHROME_LINES = 6;

/** Someone else's text on our screen: tabs as spaces, control characters as "?". */
function screenText(line: string): string {
  // oxlint-disable-next-line no-control-regex -- finding them is the point
  return line.replace(/\t/g, "    ").replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function BrowseApp({ actions, path: startPath, onSwitch }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [ref, setRef] = useState(actions.startRef);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The selected entry's path per folder, so going back up lands on the folder you came from. */
  const [cursors, setCursors] = useState<Record<string, string>>({});
  const filterBox = useFilter();
  const { filter } = filterBox;
  const [scroll, setScroll] = useState(0);
  const [picker, setPicker] = useState<RefPicker | null>(null);
  const [pickerCursor, setPickerCursor] = useState(0);
  const [note, setNote] = useState<Note | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const height = Math.max((stdout.rows || 24) - CHROME_LINES, 3);

  /** Shows the folder or file at `path`; returns the error, already shown, when it failed. */
  async function open(
    at: string,
    path: string,
    opts: { keepFolder?: boolean } = {},
  ): Promise<unknown> {
    setLoading(true);
    setLoadError(null);
    try {
      const node = await actions.open(at, path);
      setRef(at);
      if (node.kind === "folder") {
        setFolder(node);
        setFile(null);
        filterBox.setFilter("");
      } else {
        setFile(node);
        setScroll(0);
        // Opened straight on a file (--path): load its folder for when we go back.
        if (!opts.keepFolder) {
          const parent = await actions.open(at, `${parentOf(node.path)}/`);
          if (parent.kind === "folder") {
            setFolder(parent);
            setCursors((c) => ({ ...c, [parent.path]: node.path }));
          }
        }
      }
      return null;
    } catch (err) {
      const message = screenErrorText(err);
      if (folder || file) setNote({ text: message, error: true });
      else setLoadError(message);
      return err;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void open(actions.startRef, startPath);
  }, []);

  const entries = (folder?.entries ?? []).filter((e) =>
    e.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const folderKey = folder?.path ?? "";
  const index = Math.max(
    entries.findIndex((e) => e.path === cursors[folderKey]),
    0,
  );
  const selected = entries[index];
  const setCursor = (n: number) => {
    const path = entries[n]?.path;
    if (path !== undefined) setCursors((c) => ({ ...c, [folderKey]: path }));
  };

  // An empty file has no lines; a final newline ends the last line.
  const lines = file?.text ? file.text.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const maxScroll = Math.max(lines.length - height, 0);
  const scrollTo = (n: number) => setScroll(Math.max(0, Math.min(n, maxScroll)));

  const pickerBranches = (picker?.branches ?? []).filter((b) => b.includes(picker?.input ?? ""));

  async function openPicker() {
    setPicker({ branches: null, input: "" });
    setPickerCursor(0);
    try {
      const branches = await actions.branches();
      setPicker((p) => p && { ...p, branches });
    } catch (err) {
      setPicker(null);
      setNote({ text: screenErrorText(err), error: true });
    }
  }

  async function switchRef(next: string) {
    setPicker(null);
    if (next === "" || next === ref) return;
    // Stay in the same place on the new ref when it exists there.
    const here = file ? file.path : `${folderKey}/`;
    const err = await open(next, here);
    if (!(err instanceof NotFoundError)) return;
    if (!(await open(next, ""))) {
      setNote({ text: `${here.replace(/\/$/, "") || "/"} is not on ${next}; showing the root.` });
    }
  }

  function goUp() {
    if (!folder || folder.path === "") return;
    void open(ref, `${parentOf(folder.path)}/`);
  }

  useKeys(
    (input, key) => {
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      if (picker) {
        if (key.escape) setPicker(null);
        else if (key.return) void switchRef(pickerBranches[pickerCursor] ?? picker.input.trim());
        else if (key.downArrow)
          setPickerCursor(Math.min(pickerCursor + 1, Math.max(pickerBranches.length - 1, 0)));
        else if (key.upArrow) setPickerCursor(Math.max(pickerCursor - 1, 0));
        return;
      }
      if (filterBox.handleKey(key)) return;
      if (input === "?") {
        setShowHelp(true);
        return;
      }
      const top = onSwitch && topSwitch(input, key, "browse");
      if (top) {
        onSwitch?.(top);
        exit();
        return;
      }
      if (loading) {
        // Nothing on screen yet, so there is nothing to go back to.
        if (!folder && !file && (input === "q" || key.escape)) exit();
        return;
      }
      setNote(null);
      if (input === "u" && !key.ctrl) {
        setNote({ text: actions.consoleUrl(ref, file ? file.path : folderKey) });
        return;
      }
      if (input === "b" && !key.ctrl) {
        void openPicker();
        return;
      }
      if (key.ctrl && input === "r") {
        void open(ref, file ? file.path : `${folderKey}/`, { keepFolder: true });
        return;
      }
      if (file) {
        if (input === "q" || key.escape || input === "h" || key.backspace || key.delete) {
          setFile(null);
        } else if (input === "j" || key.downArrow) scrollTo(scroll + 1);
        else if (input === "k" || key.upArrow) scrollTo(scroll - 1);
        else if (key.ctrl && input === "d") scrollTo(scroll + Math.floor(height / 2));
        else if (key.ctrl && input === "u") scrollTo(scroll - Math.floor(height / 2));
        else if (input === "G") scrollTo(maxScroll);
        else if (input === "g") scrollTo(0);
        return;
      }
      if (input === "q" || key.escape) {
        exit();
        return;
      }
      if (input === "h" || key.backspace || key.delete) {
        goUp();
        return;
      }
      if (input === "/") {
        filterBox.start();
        setCursor(0);
        return;
      }
      if (input === "j" || key.downArrow) {
        setCursor(Math.min(index + 1, Math.max(entries.length - 1, 0)));
        return;
      }
      if (input === "k" || key.upArrow) {
        setCursor(Math.max(index - 1, 0));
        return;
      }
      if (input === "G") {
        setCursor(Math.max(entries.length - 1, 0));
        return;
      }
      if (input === "g") {
        setCursor(0);
        return;
      }
      if ((key.return || input === "l") && selected) {
        setCursors((c) => ({ ...c, [folderKey]: selected.path }));
        if (selected.type === "submodule")
          setNote({ text: `${selected.name} is a submodule: browse its own repository.` });
        else if (selected.type === "folder") void open(ref, `${selected.path}/`);
        else void open(ref, selected.path, { keepFolder: true });
      }
    },
    { isActive: true },
  );

  if (showHelp) return <HelpScreen title="Browse help" sections={[{ keys: BROWSE_HELP }]} />;

  const where = file ? file.path : folderKey ? `${folderKey}/` : "/";
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan" wrap="truncate">
        lazycc — browse {actions.repository} @ {ref} : {screenText(where)}
      </Text>
      {picker ? (
        <RefPickerView
          picker={picker}
          branches={pickerBranches}
          cursor={pickerCursor}
          height={height}
          onInput={(input) => {
            setPicker({ ...picker, input });
            setPickerCursor(0);
          }}
        />
      ) : loading && !folder && !file ? (
        <Text color="cyan">Loading...</Text>
      ) : loadError ? (
        <Text color="red">Error: {printable(loadError)}</Text>
      ) : file ? (
        <FileView file={file} lines={lines} scroll={scroll} height={height} />
      ) : (
        <FolderView
          entries={entries}
          selected={selected}
          index={index}
          height={height}
          filterBox={filterBox}
        />
      )}
      <Box marginTop={1}>
        {loading && (folder || file) ? (
          <Text color="cyan">Loading...</Text>
        ) : note ? (
          // Wrapped, not truncated: a console URL must stay whole to be copied.
          <Text {...(note.error ? { color: "red" } : {})}>{printable(note.text)}</Text>
        ) : picker ? (
          <Text dimColor>Type to filter, or a commit ID · ↑/↓ pick · Enter open · Esc cancel</Text>
        ) : file ? (
          <Text dimColor>j/k scroll Ctrl+d/u half page g/G top/end h back b ref u URL ? help</Text>
        ) : (
          <Text dimColor>
            Enter open h up / filter b ref u URL Ctrl+r refresh
            {onSwitch ? " r repositories 1 home 2 branches" : ""} q quit ? help
          </Text>
        )}
      </Box>
    </Box>
  );
}

function FolderView(props: {
  entries: readonly FolderEntry[];
  selected: FolderEntry | undefined;
  index: number;
  height: number;
  filterBox: ReturnType<typeof useFilter>;
}) {
  const { entries, selected, index } = props;
  const { filter } = props.filterBox;
  const height = props.height - 1;
  const top = windowStart(index, height, entries.length);
  return (
    <>
      <FilterLine state={props.filterBox} />
      {entries.length === 0 ? (
        <Text dimColor>{filter ? "Nothing matches." : "Empty folder."}</Text>
      ) : (
        entries.slice(top, top + height).map((e) => (
          <Text key={e.path} wrap="truncate">
            <Text color="cyan">{e === selected ? "> " : "  "}</Text>
            <Text
              bold={e.type === "folder"}
              {...(e.type === "folder" ? { color: "blue" } : {})}
              dimColor={e.type === "submodule"}
            >
              {screenText(e.name)}
              {ENTRY_MARK[e.type]}
            </Text>
          </Text>
        ))
      )}
    </>
  );
}

function FileView(props: { file: File; lines: string[]; scroll: number; height: number }) {
  const { file, lines, scroll, height } = props;
  if (file.tooLarge)
    return (
      <Text color="yellow">Too large for the CodeCommit API. Use lazycc clone to read it.</Text>
    );
  if (file.binary) return <Text color="yellow">Binary file ({file.size} bytes), not shown.</Text>;
  const width = String(lines.length).length;
  const shown = lines
    .slice(scroll, scroll + height)
    .map((text, i) => ({ n: scroll + i + 1, text }));
  return (
    <>
      <Text dimColor>
        {lines.length} lines · {file.size} bytes
        {lines.length > height ? ` · ${scroll + 1}-${Math.min(scroll + height, lines.length)}` : ""}
      </Text>
      {shown.map(({ n, text }) => (
        <Text key={n} wrap="truncate">
          <Text dimColor>{String(n).padStart(width)} │ </Text>
          {screenText(text)}
        </Text>
      ))}
    </>
  );
}

function RefPickerView(props: {
  picker: RefPicker;
  branches: readonly string[];
  cursor: number;
  height: number;
  onInput: (s: string) => void;
}) {
  const { picker, branches, cursor } = props;
  const height = props.height - 1;
  const top = windowStart(cursor, height, branches.length);
  return (
    <>
      <Box>
        <Text>ref: </Text>
        <TextInput value={picker.input} onChange={props.onInput} />
      </Box>
      {picker.branches === null ? (
        <Text color="cyan">Loading branches...</Text>
      ) : branches.length === 0 ? (
        <Text dimColor>No branch matches. Enter opens it as a commit ID.</Text>
      ) : (
        branches.slice(top, top + height).map((b, i) => (
          <Text key={b} wrap="truncate">
            <Text color="cyan">{top + i === cursor ? "> " : "  "}</Text>
            {screenText(b)}
          </Text>
        ))
      )}
    </>
  );
}

const BROWSE_HELP: HelpSection["keys"] = [
  ["j / k, ↓ / ↑", "Move, or scroll a file"],
  ["Enter / l", "Open the folder or file"],
  ["h / Backspace", "Up to the parent folder; back from a file"],
  ["Ctrl+d / Ctrl+u", "Half a page down or up in a file"],
  ["g / G", "Top or end"],
  ["/", "Filter this folder by name"],
  ["b", "Switch to another branch, or type a commit ID"],
  ["u", "Show the console URL of this place"],
  ["Ctrl+r", "Reload"],
  ["q / Esc", "Back from a file; quit from a folder"],
];
