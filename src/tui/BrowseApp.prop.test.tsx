import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { BrowseActions } from "../core/browse.js";
import { press, render } from "../testing/keys.js";

vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  useApp: () => ({ exit: vi.fn() }),
}));

const { BrowseApp } = await import("./BrowseApp.js");

// oxlint-disable-next-line no-control-regex -- finding them is the point
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
// oxlint-disable-next-line no-control-regex -- finding them is the point
const CONTROL_ALL = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Branch names git accepts (git check-ref-format refuses bytes below 0x20 and
 * DEL, not the C1 controls U+0080–U+009F, which are two bytes in UTF-8):
 * someone who can push to the repository can name a branch with CSI (U+009B) or OSC (U+009D) in it.
 */
const branch = fc
  .tuple(
    fc.constantFrom("main", "topic", "release/1.0"),
    fc.array(fc.constantFrom("\u009b2J", "\u009d52;c;aGk=\u009c", "\u0085", "\u0090q"), {
      minLength: 1,
      maxLength: 2,
    }),
  )
  .map(([base, parts]) => base + parts.join(""));

function actions(ref: string): BrowseActions {
  return {
    repository: "demo",
    startRef: "main",
    open: async (at) => ({
      kind: "folder",
      ref: at,
      path: "",
      entries: [{ name: "README.md", path: "README.md", type: "file" }],
    }),
    branches: async () => ["main", ref],
    consoleUrl: (at, path) => `https://console/${encodeURIComponent(at)}/${path}`,
  };
}

describe("BrowseApp, on a branch someone else named", () => {
  it("shows the name as the picker does, in the header after it, with no control character", async () => {
    await fc.assert(
      fc.asyncProperty(branch, async (ref) => {
        const r = render(<BrowseApp actions={actions(ref)} path="" />);
        try {
          await vi.waitFor(() => expect(r.lastFrame()).toContain("README.md"));
          await press(r, "b");
          await vi.waitFor(() => expect(r.lastFrame()).toContain("> main"));
          await press(r, "\u001b[B");
          const picker = r.lastFrame() ?? "";
          await press(r, "\r");
          await vi.waitFor(() => expect(r.lastFrame()).not.toContain("Type to filter"));
          for (const frame of [picker, r.lastFrame() ?? ""]) {
            const bad = frame.split("\n").find((l) => CONTROL.test(l));
            expect(bad).toBeUndefined();
          }
          // The header names the ref as the picker showed it, and the folder after it.
          const shown = ref.replace(CONTROL_ALL, "?");
          expect(picker).toContain(`> ${shown}`);
          expect(r.lastFrame()).toContain(`@ ${shown} : /`);
        } finally {
          r.unmount();
        }
      }),
      { numRuns: 10 },
    );
  }, 60_000);
});
