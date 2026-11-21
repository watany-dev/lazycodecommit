import { Box, Text, useApp, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { rulesSummary } from "../core/branch.js";
import { CHECK_COLOR, CHECK_MARK } from "../core/checks.js";
import type { HomeActions } from "../core/home.js";
import {
  type Inbox,
  type InboxItem,
  isPending,
  loadAllDetails,
  type Section,
} from "../core/inbox.js";
import type { ReviewService } from "../core/review.js";
import { printable, shortArn } from "../core/text.js";
import { FilterLine, useFilter, windowStart } from "./components/FilterLine.js";
import { HelpMenu, type HelpSection, useHelp } from "./components/Help.js";
import { RepoPicker } from "./components/RepoPicker.js";
import { useKeys } from "./hooks/useKeys.js";
import { useQuit } from "./hooks/useQuit.js";
import { isBottom, isTop } from "./listKeys.js";
import { App as ReviewApp } from "./ReviewApp.js";
import { type TopSwitch, topSwitch } from "./top.js";
import { formatRelativeDate } from "./utils/formatDate.js";
import { formatErrorMessage } from "./utils/formatError.js";

interface Props {
  actions: HomeActions;
  /** The review service for a repository (git diffs only for the clone's own). */
  reviewService: (repository: string) => ReviewService;
  /** A message to start with (a view that could not open). */
  note?: string | null;
  /** 2 / 3: leave for the branch table or browse. */
  onSwitch?: (s: TopSwitch) => void;
  /** A repository picked with Enter, for the branch table and browse too; undefined when Esc undoes it. */
  onRepository?: (repository: string | undefined) => void;
}

type View =
  | { readonly kind: "home" }
  | { readonly kind: "picker" }
  | {
      readonly kind: "review";
      readonly repository: string;
      readonly pullRequestId: string | null;
      readonly authorArn?: string;
    };

const CHROME_LINES = 8;
const SECTION_TITLE: Record<Section, string> = {
  awaiting: "Awaiting your approval",
  mine: "Your PRs",
};

const label = (repos: readonly string[]) =>
  repos.length === 1 ? repos[0] : `${repos.length} repositories`;

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
  const quit = useQuit();
  const { stdout } = useStdout();
  const [repos, setRepos] = useState(actions.initial);
  // Repositories from the config follow it when w changes the watch list.
  const [followsConfig, setFollowsConfig] = useState(same(actions.initial, actions.watched()));
  const [view, setView] = useState<View>(actions.initial ? { kind: "home" } : { kind: "picker" });
  // What the home showed before the first Enter in the picker, for Esc to go back to.
  const [beforePick, setBeforePick] = useState<{
    readonly repos: readonly string[] | undefined;
    readonly followsConfig: boolean;
  } | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("awaiting");
  const [cursor, setCursor] = useState(0);
  const filterBox = useFilter();
  const { filter } = filterBox;
  const [note, setNote] = useState<string | null>(startNote ?? null);
  const help = useHelp();
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

  /** Where Esc goes from a picked repository: the watch list as it is now, else the start. */
  function back(): readonly string[] | undefined {
    if (!beforePick) return undefined;
    const watched = actions.watched();
    const target =
      beforePick.followsConfig || !beforePick.repos
        ? watched.length > 0
          ? watched
          : undefined
        : beforePick.repos;
    return target && !same(repos, target) ? target : undefined;
  }
  const backTo = back();

  useKeys(
    (input, key) => {
      if (filterBox.handleKey(key)) return;
      if (input === "q") {
        quit();
        return;
      }
      setNote(null);
      const top = onSwitch && topSwitch(input, key, "home");
      // r and Ctrl+r stay the home's own picker, which also chooses what it lists.
      if (top && "view" in top) {
        onSwitch?.(top);
        exit();
      } else if (input === "?") help.show();
      else if (key.escape) {
        const target = back();
        if (!target) return;
        setFollowsConfig(same(target, actions.watched()));
        setBeforePick(null);
        setRepos(target);
        onRepository?.(undefined);
      } else if (key.tab || input === "]" || input === "[") {
        setSection(section === "awaiting" ? "mine" : "awaiting");
        setCursor(0);
      } else if (input === "R") {
        if (repos && !refreshing) void refresh(repos);
      } else if (input === "r" || (key.ctrl && input === "r")) setView({ kind: "picker" });
      else if (input === "/") {
        filterBox.start();
        setCursor(0);
      } else if (input === "j" || key.downArrow) {
        setCursor(Math.min(index + 1, Math.max(rows.length - 1, 0)));
      } else if (input === "k" || key.upArrow) {
        setCursor(Math.max(index - 1, 0));
      } else if (isTop(input, key)) {
        setCursor(0);
      } else if (isBottom(input, key)) {
        setCursor(Math.max(rows.length - 1, 0));
      } else if (selected && key.return) {
        setView({
          kind: "review",
          repository: selected.pr.repository,
          pullRequestId: selected.pr.id,
          authorArn: selected.pr.authorArn,
        });
      } else if (selected && input === "u") {
        setNote(actions.consoleUrl(selected.pr));
      }
    },
    { isActive: view.kind === "home" && !help.open },
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
          actions.markSeen({ id: view.pullRequestId, authorArn: view.authorArn });
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
          if (!beforePick) setBeforePick({ repos, followsConfig });
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

  if (help.open)
    return (
      <HelpMenu
        title="Home help"
        note="● marks activity since you last opened the PR."
        sections={[{ keys: HOME_HELP }]}
        onClose={help.close}
        onRun={help.run}
      />
    );

  const notes = (inbox?.errors.length ?? 0) + (inbox && loadError ? 1 : 0);
  const height = Math.max((stdout.rows || 24) - CHROME_LINES - notes, 3);
  const top = windowStart(index, height, rows.length);
  const visible = rows.slice(top, top + height);
  const layout = rowLayout(
    (stdout.columns || 80) - 2,
    Math.max(6, ...rows.map((i) => i.pr.repository.length)) + 2,
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate">
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
          {repos ? label(repos) : ""}
          {backTo ? ` only  Esc back to ${label(backTo)}` : ""}
          {refreshing ? "  refreshing…" : ""}
        </Text>
      </Text>
      <FilterLine state={filterBox} />
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
          <InboxLine key={item.pr.id} item={item} selected={item === selected} layout={layout} />
        ))
      )}
      {inbox && loadError ? <Text color="red">Refresh failed: {loadError}</Text> : null}
      <Box marginTop={1}>
        {note ? (
          <Text>{printable(note)}</Text>
        ) : (
          <Text dimColor>
            [ ] switch Enter review r repositories{onSwitch ? " 2 branches 3 browse" : ""} / filter
            R refresh u URL q quit ? help
          </Text>
        )}
      </Box>
    </Box>
  );
}

/** Cursor, unread mark, #id, author or rules, date: the columns beside the repository and title. */
const FIXED = { cursor: 2, mark: 2, id: 7, detail: 22, date: 10 };
const MIN_TITLE = 10;

interface RowLayout {
  readonly width: number;
  readonly repoWidth: number;
  readonly detail: boolean;
  readonly date: boolean;
}

/**
 * Column widths for a row `width` cells wide. The repository column gives way
 * first, down to 6, then the date and the author or rules columns go, so the
 * title keeps MIN_TITLE cells; a row narrower still is cut, never wrapped.
 */
function rowLayout(width: number, repoNatural: number): RowLayout {
  const base = FIXED.cursor + FIXED.mark + FIXED.id;
  const fits = (extra: number) => width - base - extra - MIN_TITLE;
  const date = fits(FIXED.detail + FIXED.date + 6) >= 0;
  const detail = fits(FIXED.detail + 6) >= 0;
  const others = (detail ? FIXED.detail : 0) + (date ? FIXED.date : 0);
  const repoWidth = Math.max(6, Math.min(repoNatural, 28, fits(others)));
  return { width, repoWidth, detail, date };
}

function InboxLine({
  item,
  selected,
  layout,
}: {
  item: InboxItem;
  selected: boolean;
  layout: RowLayout;
}) {
  const { pr } = item;
  return (
    <Box width={layout.width} overflow="hidden">
      <Box width={FIXED.cursor} flexShrink={0}>
        <Text color="cyan">{selected ? ">" : " "}</Text>
      </Box>
      <Box width={FIXED.mark} flexShrink={0}>
        <Text color="yellow">{item.unread ? "●" : " "}</Text>
      </Box>
      <Box width={layout.repoWidth} flexShrink={0}>
        <Text dimColor wrap="truncate">
          {pr.repository}
        </Text>
      </Box>
      <Box width={FIXED.id} flexShrink={0}>
        <Text>#{pr.id}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexBasis={0}>
        <Text bold={item.unread} wrap="truncate">
          {printable(pr.title)}
        </Text>
      </Box>
      {layout.detail ? (
        <Box width={FIXED.detail} flexShrink={0} justifyContent="flex-end">
          <Detail item={item} />
        </Box>
      ) : null}
      {layout.date ? (
        <Box width={FIXED.date} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>{formatRelativeDate(pr.lastActivityDate)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function Detail({ item }: { item: InboxItem }) {
  if (item.section === "awaiting") {
    return <Text wrap="truncate">{shortArn(item.pr.authorArn)}</Text>;
  }
  if (item.detailError) return <Text color="red">details failed</Text>;
  if (!item.rules) return <Text dimColor>…</Text>;
  return (
    <Text wrap="truncate">
      {item.checks ? (
        <Text color={CHECK_COLOR[item.checks]}>CI {CHECK_MARK[item.checks]} </Text>
      ) : null}
      <Text color={item.rules.approved ? "green" : "yellow"}>
        {rulesSummary(item.rules) || "no rules"}
      </Text>
      {item.mergeable === false ? <Text color="red"> conflict</Text> : null}
    </Text>
  );
}

const HOME_HELP: HelpSection["keys"] = [
  ["j / k, ↓ / ↑", "Move"],
  ["< / >, Home / End", "First / last PR"],
  ["] / [, Tab", "Switch between awaiting your approval and your PRs", "]"],
  ["Enter", "Review the PR (marks it read)", "\r"],
  ["r / Ctrl+r", "Pick repositories (w watches, p lists PRs)", "r"],
  ["Esc", "Back from a repository picked with Enter to the watched ones"],
  ["2", "Branch table, for the clone or the repository picked", "2"],
  ["3", "Browse, for the clone or the repository picked", "3"],
  ["/", "Filter by title or repository", "/"],
  ["R", "Refresh", "R"],
  ["u", "Show the PR's console URL", "u"],
  ["q / Ctrl+c", "Quit"],
];
