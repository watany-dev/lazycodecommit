import { Text } from "ink";
import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { press, render } from "../../testing/keys.js";
import { useKeys } from "../hooks/useKeys.js";
import { QuitProvider } from "../hooks/useQuit.js";
import { HelpMenu, type HelpSection, PR_DETAIL_HELP, PR_LIST_HELP, useHelp } from "./Help.js";

const SECTIONS: HelpSection[] = [
  {
    title: "Moving",
    keys: [
      ["j / k", "Move"],
      ["Ctrl+d / Ctrl+u", "Half a page", "\x04"],
    ],
  },
  {
    title: "Acting",
    keys: [
      ["c", "Comment", "c"],
      ["a", "Approve", "a"],
    ],
  },
];

function menu(over: Partial<React.ComponentProps<typeof HelpMenu>> = {}) {
  const onClose = vi.fn();
  const onRun = vi.fn();
  const screen = render(
    <HelpMenu
      title="Test help"
      note="A note."
      sections={SECTIONS}
      onClose={onClose}
      onRun={onRun}
      {...over}
    />,
  );
  return { ...screen, onClose, onRun };
}

describe("HelpMenu", () => {
  it("lists the keys under their section titles, the cursor on the first", () => {
    const { lastFrame } = menu();
    const frame = lastFrame()!;
    expect(frame).toContain("lazycc — Test help");
    expect(frame).toContain("A note.");
    expect(frame.indexOf("Moving")).toBeLessThan(frame.indexOf("Acting"));
    expect(frame).toMatch(/> j \/ k/);
    expect(frame).toContain("Enter run / filter Esc close q quit");
    const lines = frame.split("\n");
    const col = (text: string) => lines.find((l) => l.includes(text))!.indexOf(text);
    expect(col("Move")).toBe(col("Half a page"));
  });

  it("presses the selected key with Enter", async () => {
    const screen = menu();
    await press(screen, "j", "j", "\r");
    expect(screen.onRun).toHaveBeenCalledWith("c");
    expect(screen.onClose).not.toHaveBeenCalled();
  });

  it("only closes on Enter when the row has no key to press", async () => {
    const screen = menu();
    await press(screen, "\r");
    expect(screen.onClose).toHaveBeenCalled();
    expect(screen.onRun).not.toHaveBeenCalled();
  });

  it("goes to the first and last row with < > and Home End", async () => {
    const screen = menu();
    await press(screen, ">");
    expect(screen.lastFrame()).toMatch(/> a +Approve/);
    await press(screen, "<");
    expect(screen.lastFrame()).toMatch(/> j \/ k/);
    await press(screen, "\x1b[F");
    expect(screen.lastFrame()).toMatch(/> a +Approve/);
    await press(screen, "\x1b[H", "k");
    expect(screen.lastFrame()).toMatch(/> j \/ k/);
  });

  it("filters with /, by key or description, dropping empty sections", async () => {
    const screen = menu();
    await press(screen, "/", "a", "p", "p");
    expect(screen.lastFrame()).toContain("Approve");
    expect(screen.lastFrame()).not.toContain("Comment");
    expect(screen.lastFrame()).not.toContain("Moving");
    await press(screen, "\r", "\r");
    expect(screen.onRun).toHaveBeenCalledWith("a");
  });

  it("says when no key matches, and Esc clears the filter before closing", async () => {
    const screen = menu();
    await press(screen, "/", "z", "z");
    expect(screen.lastFrame()).toContain("No key matches.");
    await press(screen, "\u001B");
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("Comment"));
    expect(screen.onClose).not.toHaveBeenCalled();
  });

  it("closes on Esc and ?", async () => {
    const a = menu();
    await press(a, "\u001B");
    await vi.waitFor(() => expect(a.onClose).toHaveBeenCalled());
    const b = menu();
    await press(b, "?");
    expect(b.onClose).toHaveBeenCalled();
  });

  it("quits lazycc on q", async () => {
    const onQuit = vi.fn();
    const screen = render(
      <QuitProvider onQuit={onQuit}>
        <HelpMenu title="t" sections={SECTIONS} onClose={vi.fn()} onRun={vi.fn()} />
      </QuitProvider>,
    );
    await press(screen, "q");
    expect(onQuit).toHaveBeenCalled();
  });
});

/** A screen with one key of its own and a help menu that can press it. */
function Harness() {
  const help = useHelp();
  const [pressed, setPressed] = useState<string[]>([]);
  useKeys(
    (input, key) => {
      if (input === "?") help.show();
      else setPressed((p) => [...p, key.ctrl ? `C-${input}` : input]);
    },
    { isActive: !help.open },
  );
  if (help.open)
    return <HelpMenu title="t" sections={SECTIONS} onClose={help.close} onRun={help.run} />;
  return <Text>pressed: {pressed.join(",")}</Text>;
}

describe("useHelp", () => {
  it("closes the menu and hands the key to the screen", async () => {
    const screen = render(<Harness />);
    await press(screen, "?", "j", "\r");
    await vi.waitFor(() => expect(screen.lastFrame()).toBe("pressed: C-d"));
    await press(screen, "?", ">", "\r");
    await vi.waitFor(() => expect(screen.lastFrame()).toBe("pressed: C-d,a"));
  });

  it("presses nothing when the menu is closed with Esc", async () => {
    const screen = render(<Harness />);
    await press(screen, "?", "\u001B");
    await vi.waitFor(() => expect(screen.lastFrame()).toBe("pressed:"));
  });
});

describe("review help", () => {
  it("names lazygit's keys beside lazycc's own", () => {
    const keys = [...PR_LIST_HELP, ...PR_DETAIL_HELP].flatMap((s) => s.keys.map(([k]) => k));
    expect(keys).toEqual(
      expect.arrayContaining([". / n", ", / p", "f / Ctrl+g", "m / M", "q / Ctrl+c", "Esc"]),
    );
  });
});

describe("HelpMenu, moving and filtering", () => {
  const cursorRow = (frame: string | undefined) =>
    frame?.split("\n").filter((l) => l.includes("> ")) ?? [];

  it("marks only the selected row", () => {
    expect(cursorRow(menu().lastFrame())).toHaveLength(1);
  });

  it("moves up one row with k and the up arrow, and stops at the last row going down", async () => {
    const screen = menu();
    await press(screen, "j", "j", "k");
    expect(screen.lastFrame()).toMatch(/> Ctrl\+d/);
    await press(screen, "\x1b[A");
    expect(screen.lastFrame()).toMatch(/> j \/ k/);
    await press(screen, ">", "j");
    expect(screen.lastFrame()).toMatch(/> a +Approve/);
  });

  it("filters regardless of case, and keeps a row selected when the filter leaves fewer", async () => {
    const screen = menu();
    await press(screen, ">", "/", "A", "P", "P");
    expect(screen.lastFrame()).toMatch(/> a +Approve/);
  });

  it("starts a filter on its first match", async () => {
    const screen = menu();
    await press(screen, ">", "/", "a");
    expect(screen.lastFrame()).toMatch(/> Ctrl\+d/);
  });

  it("does nothing on a key it does not know", async () => {
    const screen = menu();
    await press(screen, "x");
    expect(screen.onClose).not.toHaveBeenCalled();
    expect(screen.onRun).not.toHaveBeenCalled();
    expect(screen.lastFrame()).not.toContain("No key matches.");
  });

  it("shows as many rows as fit below the title, the note and the footer", () => {
    const many: HelpSection[] = [
      { keys: Array.from({ length: 30 }, (_, i) => [`k${i}`, `key ${i}`] as [string, string]) },
    ];
    const rows = (frame: string | undefined) =>
      frame?.split("\n").filter((l) => /\bkey \d+/.test(l)).length;
    expect(rows(menu({ sections: many }).lastFrame())).toBe(16);
    const noNote = render(
      <HelpMenu title="Test help" sections={many} onClose={() => {}} onRun={() => {}} />,
    );
    expect(rows(noNote.lastFrame())).toBe(17);
  });
});

describe("the help of the PR screens", () => {
  it("gives every row a key and a description, and a key to press only when set", () => {
    for (const { keys } of [...PR_LIST_HELP, ...PR_DETAIL_HELP]) {
      for (const [key, description, send] of keys) {
        expect(key.length, description).toBeGreaterThan(0);
        expect(description.length, key).toBeGreaterThan(0);
        if (send !== undefined) expect(send.length, key).toBeGreaterThan(0);
      }
    }
  });
});
