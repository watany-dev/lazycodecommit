import { PassThrough } from "node:stream";
import * as fc from "fast-check";
import { render, Text } from "ink";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { KeysProvider, useKeys } from "./hooks/useKeys.js";
import { deliveries, keyStream, splitKeys } from "./keyStream.js";

describe("splitKeys", () => {
  it("splits a burst into keys, keeping escape sequences whole", () => {
    expect(splitKeys("jj\u001b[Ak\u001bOPq\u001bx\u001b")).toEqual([
      "j",
      "j",
      "\u001b[A",
      "k",
      "\u001bOP",
      "q",
      "\u001bx",
      "\u001b",
    ]);
    expect(splitKeys("\u001b[1;5C😀\r")).toEqual(["\u001b[1;5C", "😀", "\r"]);
  });

  it("loses and adds nothing, whatever the input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        expect(splitKeys(s).join("")).toBe(s);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("deliveries", () => {
  it("keeps a paste whole but splits typing and a held key", () => {
    expect(deliveries("hello, world")).toEqual(["hello, world"]);
    expect(deliveries("/rea")).toEqual(["/", "r", "e", "a"]);
    expect(deliveries("jjjjjjjjjjjj")).toHaveLength(12);
    expect(deliveries("jjjjjjjjj\u001b[Ak")).toHaveLength(11);
  });
});

function Counter() {
  const [count, setCount] = useState(0);
  const [typed, setTyped] = useState("");
  // Updates from this render's values, as the screens do: a key handled by a
  // stale handler is lost.
  useKeys((input, key) => {
    if (input === "j") setCount(count + 1);
    else if (key.upArrow) setCount(count + 100);
    else setTyped(typed + input);
  });
  return <Text>{`count=${count} typed=${typed}`}</Text>;
}

function terminal() {
  const source = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let frame = "";
  stdout.on("data", (d) => {
    frame = String(d);
  });
  return { source, stdout, frame: () => frame };
}

describe("keyStream", () => {
  it("gives each key of a burst to the handler of the render before it", async () => {
    const t = terminal();
    const stdin = keyStream(t.source as unknown as NodeJS.ReadStream);
    const app = render(
      <KeysProvider>
        <Counter />
      </KeysProvider>,
      {
        stdin,
        stdout: t.stdout as unknown as NodeJS.WriteStream,
        debug: true,
      },
    );
    t.source.write("jjjjj\u001b[Ajjxy");
    await vi.waitFor(() => expect(t.frame()).toContain("count=107 typed=xy"), { timeout: 2000 });
    // Input after the queue has drained starts it again.
    await new Promise((r) => setTimeout(r, 50));
    t.source.write(Buffer.from("j"));
    await vi.waitFor(() => expect(t.frame()).toContain("count=108"), { timeout: 2000 });
    app.unmount();
    expect(t.source.setRawMode).toHaveBeenCalledWith(true);
    expect(t.source.unref).toHaveBeenCalled();
  });

  it("takes a lone Esc and the key after it as two keys", async () => {
    // Ink holds a lone Esc until the next turn, to tell it from the start of a
    // sequence; the next key must not reach it in time to make an Alt chord.
    const t = terminal();
    const stdin = keyStream(t.source as unknown as NodeJS.ReadStream);
    const seen: string[] = [];
    function Recorder() {
      useKeys((input, key) => {
        seen.push(key.escape ? "esc" : key.meta ? `alt+${input}` : input);
      });
      return <Text>ready</Text>;
    }
    const app = render(
      <KeysProvider>
        <Recorder />
      </KeysProvider>,
      { stdin, stdout: t.stdout as unknown as NodeJS.WriteStream, debug: true },
    );
    t.source.write("\u001b");
    t.source.write("j");
    await vi.waitFor(() => expect(seen).toEqual(["esc", "j"]), { timeout: 2000 });
    app.unmount();
  });

  it("stops reading the terminal while no screen takes input", async () => {
    const t = terminal();
    const stdin = keyStream(t.source as unknown as NodeJS.ReadStream);
    stdin.ref();
    stdin.unref();
    expect(t.source.listenerCount("data")).toBe(0);
    expect(stdin.setEncoding("utf8")).toBe(stdin);
  });
});
