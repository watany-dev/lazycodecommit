import type { Key } from "ink";

// lazygit's keys for moving in a list or a scrolled view, beside lazycc's own.

/** < or Home: the first row. */
export const isTop = (input: string, key: Key): boolean => input === "<" || key.home;

/** > or End: the last row. */
export const isBottom = (input: string, key: Key): boolean => input === ">" || key.end;

/** Ctrl+d, J or PgDn: half a page down. */
export const isPageDown = (input: string, key: Key): boolean =>
  (key.ctrl && input === "d") || input === "J" || key.pageDown;

/** Ctrl+u, K or PgUp: half a page up. */
export const isPageUp = (input: string, key: Key): boolean =>
  (key.ctrl && input === "u") || input === "K" || key.pageUp;
