import { PassThrough } from "node:stream";
import * as fc from "fast-check";
import { render } from "ink";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { KeysProvider } from "../hooks/useKeys.js";
import { deliveries, keyStream } from "../keyStream.js";
import { TextField } from "./TextField.js";

type Action =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "left" | "right" | "backspace" | "delete" };

const SEQUENCE = { left: "\u001b[D", right: "\u001b[C", backspace: "\u007f", delete: "\u001b[3~" };

// What a person types or an IME commits: letters, CJK, emoji, combining marks; no control characters.
const typed = fc
  .array(fc.constantFrom("a", "Z", " ", "-", "日", "本", "😀", "👍🏽", "é", "ä", "/", "["), {
    minLength: 1,
    maxLength: 12,
  })
  .map((cs) => cs.join(""));

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: typed.map((text) => ({ type: "text" as const, text })) },
  fc.constantFrom<Action>(
    { type: "left" },
    { type: "right" },
    { type: "backspace" },
    { type: "delete" },
  ),
);

/**
 * The box as its docs describe it: code points, cursor clamped, insert at the
 * cursor. Typing arrives key by key, so at the limit a key that does not fit is
 * dropped and a shorter one after it still goes in; a paste is cut where it stops fitting.
 */
function model(actions: readonly Action[], maxLength: number) {
  let chars: string[] = [];
  let cursor = 0;
  const steps = actions.flatMap((a): Action[] =>
    a.type === "text" ? deliveries(a.text).map((text) => ({ type: "text", text })) : [a],
  );
  for (const a of steps) {
    if (a.type === "left") cursor = Math.max(0, cursor - 1);
    else if (a.type === "right") cursor = Math.min(chars.length, cursor + 1);
    else if (a.type === "backspace" || a.type === "delete") {
      if (cursor === 0) continue;
      chars.splice(cursor - 1, 1);
      cursor -= 1;
    } else if (a.type === "text") {
      const fits: string[] = [];
      let used = chars.join("").length;
      for (const c of a.text) {
        if (used + c.length > maxLength) break;
        used += c.length;
        fits.push(c);
      }
      chars = [...chars.slice(0, cursor), ...fits, ...chars.slice(cursor)];
      cursor += fits.length;
    }
  }
  return chars.join("");
}

function mount(maxLength: number, onValue: (v: string) => void) {
  const source = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 200, rows: 24 });
  function Field() {
    const [value, setValue] = useState("");
    return (
      <TextField
        value={value}
        maxLength={maxLength}
        onChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
    );
  }
  const app = render(
    <KeysProvider>
      <Field />
    </KeysProvider>,
    {
      stdin: keyStream(source as unknown as NodeJS.ReadStream),
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
    },
  );
  return { source, app };
}

describe("TextField, typed into through the terminal", () => {
  it("ends with the text a model of the box predicts, for any keys", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(action, { minLength: 1, maxLength: 12 }),
        fc.constantFrom(Infinity, 5, 12),
        async (actions, maxLength) => {
          let value = "";
          const t = mount(maxLength, (v) => {
            value = v;
          });
          try {
            for (const a of actions) t.source.write(a.type === "text" ? a.text : SEQUENCE[a.type]);
            const expected = model(actions, maxLength);
            await vi.waitFor(() => expect(value).toBe(expected), { timeout: 2000 });
            expect(value.length).toBeLessThanOrEqual(maxLength);
          } finally {
            t.app.unmount();
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 120_000);
});
