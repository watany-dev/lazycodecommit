import { render as inkRender } from "ink-testing-library";
import type { ReactElement } from "react";
import { expect, vi } from "vitest";

/** What a rendered Ink app gives a test: its stdin and its last frame. */
export interface Screen {
  readonly stdin: { write(data: string): void };
  lastFrame(): string | undefined;
}

let tracked: () => string | undefined = () => undefined;

/** ink-testing-library's render; `press(stdin, ...)` then waits on this screen's frames. */
export function render(tree: ReactElement): ReturnType<typeof inkRender> {
  const screen = inkRender(tree);
  tracked = () => screen.lastFrame();
  return screen;
}

/** Lets a key, or work it started, land before the test looks. */
export function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, SETTLE_MS));
}

/** After a redraw, long enough for useInput to take the new render's handler. */
const SETTLE_MS = 30;
/** How long a key that changes nothing on screen is given. */
const NO_REDRAW_MS = 300;

/**
 * Types each key once the one before it has been taken: it waits for the
 * screen to redraw (or for a key that changes nothing to have had its moment),
 * then a little longer. A key sent before the app re-renders reaches the
 * previous render's handler, which a slow runner makes likely; a fixed sleep
 * between keys is what failed on macOS CI.
 */
export async function press(target: Screen | Screen["stdin"], ...keys: string[]): Promise<void> {
  const stdin = "stdin" in target ? target.stdin : target;
  const frame = "stdin" in target ? () => target.lastFrame() : tracked;
  for (const key of keys) {
    const before = frame();
    stdin.write(key);
    await vi
      .waitFor(() => expect(frame()).not.toBe(before), {
        timeout: NO_REDRAW_MS,
        interval: 5,
      })
      .catch(() => {});
    await settle();
  }
}
