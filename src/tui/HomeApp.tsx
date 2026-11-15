import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";
import { rulesSummary } from "../core/branch.js";
import type { HomeActions } from "../core/home.js";
import {
  type Inbox,
  type InboxItem,
  isPending,
  loadAllDetails,
  type Section,
} from "../core/inbox.js";
import type { ReviewService } from "../core/review.js";
import { RepoPicker } from "./components/RepoPicker.js";
import { App as ReviewApp } from "./ReviewApp.js";
import { type TopSwitch, topSwitch } from "./top.js";
import { extractAuthorName, formatRelativeDate } from "./utils/formatDate.js";
import { formatErrorMessage } from "./utils/formatError.js";

interface Props {
  actions: HomeActions;
  /** The review service for a repository (git diffs only for the clone's own). */
  reviewService: (repository: string) => ReviewService;
  /** A message to start with (a view that could not open). */
  note?: string | null;
  /** 2 / 3: leave for the branch table or browse. */
  onSwitch?: (s: TopSwitch) => void;
  /** A repository picked with Enter, for the branch table and browse too. */
  onRepository?: (repository: string) => void;
}

type View =
  | { readonly kind: "home" }
  | { readonly kind: "picker" }
  | { readonly kind: "review"; readonly repository: string; readonly pullRequestId: string | null };

const CHROME_LINES = 8;
const SECTION_TITLE: Record<Section, string> = {
  awaiting: "Awaiting your approval",
  mine: "Your PRs",
};

const same = (a: readonly string[] | undefined, b: readonly string[]) =>
  a !== undefined && a.length === b.length && a.every((r, i) => r === b[i]);

/** spec: ホーム. The inbox across the watched repositories, cache first, then refreshed. */
export function HomeApp({
  actions,
  reviewService,
  note: startNote,
  onSwitch,
  onRepository,
}: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [repos, setRepos] = useState(actions.initial);
  // Repositories from the config follow it when w changes the watch list.
  const [followsConfig, setFollowsConfig] = useState(same(actions.initial, actions.watched()));
  const [view, setView] = useState<View>(actions.initial ? { kind: "home" } : { kind: "picker" });
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("awaiting");
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [note, setNote] = useState<string | null>(startNote ?? null);
  const [showHelp, setShowHelp] = useState(false);
  // A refresh for repositories the user has since left must not land.
  const generation = useRef(0);

  async function refresh(target: readonly string[]) {
    const gen = ++generation.current;
    const current = () => gen === generation.current;
    setRefreshing(true);
    setLoadError(null);
    try {
      const listed = await actions.fetch(target);
      if (!current()) return;
      setInbox(listed);
      const items = await loadAllDetails(
        listed.items,
        actions.details,
        actions.concurrency,
        (d) => {
          if (!current()) return;
          setInbox(
            (prev) =>
              prev && { ...prev, items: prev.items.map((i) => (i.pr.id === d.pr.id ? d : i)) },
          );
        },
      );
      if (current()) await actions.save({ ...listed, items });
    } catch (err) {
      if (current()) setLoadError(formatErrorMessage(err));
    } finally {
      if (current()) setRefreshing(false);
    }
  }

  async function open(target: readonly string[]) {
    const gen = ++generation.current;
    setInbox(null);
    setCursor(0);
    // A cache that cannot be read is only a slower start.
    const cached = await actions.cached(target).catch(() => undefined);
    if (gen !== generation.current) return;
    if (cached) setInbox(cached);
    void refresh(target);
  }

  useEffect(() => {
    if (repos) void open(repos);
  }, [repos]);

  const all = inbox?.items.filter((i) => isPending(i, actions.me)) ?? [];
  const count = (s: Section) => all.filter((i) => i.section === s).length;
  const needle = filter.toLowerCase();
  const rows = all.filter(
    (i) =>
      i.section === section &&
      (i.pr.title.toLowerCase().includes(needle) || i.pr.repository.toLowerCase().includes(needle)),
  );
  const index = Math.max(Math.min(cursor, rows.length - 1), 0);
  const selected = rows[index];

  useInput(
    (input, key) => {
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      if (filtering) {
        if (key.escape) {
          setFiltering(false);
          setFilter("");
        } else if (key.return) setFiltering(false);
        return;
      }
      if (input === "q" || key.escape) {
        exit();
        return;
      }
      setNote(null);
      const top = onSwitch && topSwitch(input, key, "home");
      // r stays the home's own picker, which also chooses what it lists.
      if (top && "view" in top) {
        onSwitch?.(top);
        exit();
      } else if (input === "?") setShowHelp(true);
      else if (key.tab) {
        setSection(section === "awaiting" ? "mine" : "awaiting");
        setCursor(0);
      } else if (key.ctrl && input === "r") {
        if (repos && !refreshing) void refresh(repos);
      } else if (input === "r") setView({ kind: "picker" });
      else if (input === "/") {
        setFiltering(true);
        setCursor(0);
      } else if (input === "j" || key.downArrow) {
        setCursor(Math.min(index + 1, Math.max(rows.length - 1, 0)));
      } else if (input === "k" || key.upArrow) {
        setCursor(Math.max(index - 1, 0));
      } else if (selected && key.return) {
        setView({
          kind: "review",
          repository: selected.pr.repository,
          pullRequestId: selected.pr.id,
        });
      } else if (selected && input === "u") {
        setNote(actions.consoleUrl(selected.pr));
      }
    },
    { isActive: view.kind === "home" },
  );

  if (view.kind === "review") {
    return (
      <ReviewApp
        service={reviewService(view.repository)}
        repository={view.repository}
        start={view.pullRequestId === null ? null : { pullRequestId: view.pullRequestId }}
        onExit={() => {
          if (view.pullRequestId === null) {
            setView({ kind: "picker" });
            return;
          }
          setView({ kind: "home" });
          // Mark it here too: the review's own mark on leaving lands after the reads below.
          actions.markSeen(view.pullRequestId);
          // Back with fresh unread marks at once; an approval or merge shows after the refresh.
          void actions.unreadMarker().then((mark) => setInbox((prev) => prev && mark(prev)));
          if (repos) void refresh(repos);
        }}
      />
    );
  }

  if (view.kind === "picker") {
    return (
      <RepoPicker
        actions={actions}
        current={repos}
        onSelect={(repository) => {
          onRepository?.(repository);
          setFollowsConfig(false);
          setRepos([repository]);
          setView({ kind: "home" });
        }}
        onOpenList={(repository) => setView({ kind: "review", repository, pullRequestId: null })}
        onBack={() => {
          const watched = actions.watched();
          if (watched.length === 0 && (followsConfig || !repos)) {
            // Everything unwatched: nothing to show, so q again quits.
            if (!repos) exit();
            generation.current++;
            setRepos(undefined);
            setInbox(null);
            return;
          }
          if (followsConfig || !repos) {
            setFollowsConfig(true);
            if (!same(repos, watched)) setRepos(watched);
          }
          setView({ kind: "home" });
        }}
      />
    );
  }

  if (showHelp) return <HomeHelp />;

  const notes = (inbox?.errors.length ?? 0) + (inbox && loadError ? 1 : 0);
  const height = Math.max((stdout.rows || 24) - CHROME_LINES - notes, 3);
  const top = Math.max(0, Math.min(index - height + 1, rows.length - height));
  const visible = rows.slice(top, top + height);
  const repoWidth = Math.min(Math.max(6, ...rows.map((i) => i.pr.repository.length)) + 2, 28);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">
          lazycc — home{" "}
        </Text>
        {(["awaiting", "mine"] as const).map((s) => (
          <Text key={s} inverse={s === section} bold={s === section}>
            {` ${SECTION_TITLE[s]} (${count(s)}) `}
          </Text>
        ))}
        <Text dimColor>
          {"  "}
          {repos ? (repos.length === 1 ? repos[0] : `${repos.length} repositories`) : ""}
          {refreshing ? "  refreshing…" : ""}
        </Text>
      </Box>
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
      {inbox?.errors.map((e) => (
        <Text key={e.repository} color="red" wrap="truncate">
          {e.repository}: {formatErrorMessage(e.error)}
        </Text>
      ))}
      {!inbox ? (
        loadError ? (
          <Text color="red">Error: {loadError}</Text>
        ) : (
          <Text color="cyan">Loading...</Text>
        )
      ) : rows.length === 0 ? (
        <Text dimColor>
          {filter
            ? "No pull request matches."
            : section === "awaiting"
              ? "Nothing awaits your approval."
              : "You have no open pull requests."}
        </Text>
      ) : (
        visible.map((item) => (
          <InboxLine
            key={item.pr.id}
            item={item}
            selected={item === selected}
            repoWidth={repoWidth}
          />
        ))
      )}
      {inbox && loadError ? <Text color="red">Refresh failed: {loadError}</Text> : null}
      <Box marginTop={1}>
        {note ? (
          <Text>{note}</Text>
        ) : (
          <Text dimColor>
            Tab switch Enter review r repositories{onSwitch ? " 2 branches 3 browse" : ""} / filter
            Ctrl+r refresh u URL q quit ? help
          </Text>
        )}
      </Box>
    </Box>
  );
}

function InboxLine({
  item,
  selected,
  repoWidth,
}: {
  item: InboxItem;
  selected: boolean;
  repoWidth: number;
}) {
  const { pr } = item;
  return (
    <Box>
      <Text color="cyan">{selected ? "> " : "  "}</Text>
      <Box width={2} flexShrink={0}>
        <Text color="yellow">{item.unread ? "●" : " "}</Text>
      </Box>
      <Box width={repoWidth} flexShrink={0}>
        <Text dimColor wrap="truncate">
          {pr.repository}
        </Text>
      </Box>
      <Box width={7} flexShrink={0}>
        <Text>#{pr.id}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text bold={item.unread} wrap="truncate">
          {pr.title}
        </Text>
      </Box>
      <Box width={22} flexShrink={0} justifyContent="flex-end">
        <Detail item={item} />
      </Box>
      <Box width={10} flexShrink={0} justifyContent="flex-end">
        <Text dimColor>{formatRelativeDate(pr.lastActivityDate)}</Text>
      </Box>
    </Box>
  );
}

function Detail({ item }: { item: InboxItem }) {
  if (item.section === "awaiting") {
    return <Text wrap="truncate">{extractAuthorName(item.pr.authorArn)}</Text>;
  }
  if (item.detailError) return <Text color="red">details failed</Text>;
  if (!item.rules) return <Text dimColor>…</Text>;
  return (
    <Text wrap="truncate">
      <Text color={item.rules.approved ? "green" : "yellow"}>
        {rulesSummary(item.rules) || "no rules"}
      </Text>
      {item.mergeable === false ? <Text color="red"> conflict</Text> : null}
    </Text>
  );
}

function HomeHelp() {
  const keys: [string, string][] = [
    ["j / k, ↓ / ↑", "Move"],
    ["Tab", "Switch between awaiting your approval and your PRs"],
    ["Enter", "Review the PR (marks it read)"],
    ["r", "Pick repositories (w watches, p lists PRs)"],
    ["2 / 3", "Branch table / browse, for the clone or the repository picked"],
    ["/", "Filter by title or repository"],
    ["Ctrl+r", "Refresh"],
    ["u", "Show the PR's console URL"],
    ["q / Esc", "Quit"],
  ];
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        lazycc — Home help
      </Text>
      <Text dimColor> ● marks activity since you last opened the PR.</Text>
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
