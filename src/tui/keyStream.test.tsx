import { PassThrough } from "node:stream";
import * as fc from "fast-check";
import { render, Text } from "ink";
import type React from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommentInput } from "./components/CommentInput.js";
import { FilterLine, useFilter } from "./components/FilterLine.js";
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

  it("keeps a character whose UTF-8 bytes arrive in two reads", async () => {
    const t = terminal();
    const stdin = keyStream(t.source as unknown as NodeJS.ReadStream);
    const app = render(
      <KeysProvider>
        <Counter />
      </KeysProvider>,
      { stdin, stdout: t.stdout as unknown as NodeJS.WriteStream, debug: true },
    );
    // 日 is three bytes and 本 three more: the first read ends inside 本.
    const bytes = Buffer.from("日本");
    t.source.write(bytes.subarray(0, 4));
    await new Promise((r) => setTimeout(r, 20));
    t.source.write(bytes.subarray(4));
    await vi.waitFor(() => expect(t.frame()).toContain("typed=日本"), { timeout: 2000 });
    app.unmount();
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

  it("reads the terminal again for the next screen after one has closed", async () => {
    // The top-level views are one render each, all on the same process.stdin.
    const t = terminal();
    const options = { stdout: t.stdout as unknown as NodeJS.WriteStream, debug: true };
    const first = render(
      <KeysProvider>
        <Counter />
      </KeysProvider>,
      { ...options, stdin: keyStream(t.source as unknown as NodeJS.ReadStream) },
    );
    t.source.write("j");
    await vi.waitFor(() => expect(t.frame()).toContain("count=1"), { timeout: 2000 });
    first.unmount();
    const second = render(
      <KeysProvider>
        <Counter />
      </KeysProvider>,
      { ...options, stdin: keyStream(t.source as unknown as NodeJS.ReadStream) },
    );
    await vi.waitFor(() => expect(t.frame()).toContain("count=0"), { timeout: 2000 });
    t.source.write("jj");
    await vi.waitFor(() => expect(t.frame()).toContain("count=2"), { timeout: 2000 });
    second.unmount();
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

// The path a key takes in the app (index.tsx): terminal, keyStream, Ink, KeysProvider.
function mount(node: React.ReactNode) {
  const t = terminal();
  const app = render(<KeysProvider>{node}</KeysProvider>, {
    stdin: keyStream(t.source as unknown as NodeJS.ReadStream),
    stdout: t.stdout as unknown as NodeJS.WriteStream,
    debug: true,
  });
  return { ...t, app };
}

describe("text fields behind keyStream", () => {
  const comment = (onSubmit = vi.fn()) =>
    mount(
      <CommentInput
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        isPosting={false}
        error={null}
        onClearError={vi.fn()}
      />,
    );

  it("keeps every key of a chunk typed into the comment box", async () => {
    // A burst over a slow link (CloudShell), or an IME commit of several characters.
    const t = comment();
    t.source.write("abc");
    await vi.waitFor(() => expect(t.frame()).toContain("> abc"), { timeout: 2000 });
    t.source.write("日本語");
    await vi.waitFor(() => expect(t.frame()).toContain("> abc日本語"), { timeout: 2000 });
    t.app.unmount();
  });

  it("posts the whole text when Enter comes in the same chunk", async () => {
    const onSubmit = vi.fn();
    const t = comment(onSubmit);
    t.source.write("LGTM\r");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("LGTM"), { timeout: 2000 });
    t.app.unmount();
  });

  it("edits at the cursor with keys from one chunk", async () => {
    const t = comment();
    // a b ← ← x → Backspace: "xab" with the cursor after a, then a deleted.
    t.source.write("ab\u001b[D\u001b[Dx\u001b[C\u007f");
    await vi.waitFor(() => expect(t.frame()).toContain("> xb"), { timeout: 2000 });
    t.app.unmount();
  });

  it("keeps every key of a chunk typed into the / filter", async () => {
    function Filter() {
      const state = useFilter();
      useKeys((input, key) => {
        if (!state.handleKey(key) && input === "/") state.start();
      });
      return <FilterLine state={state} />;
    }
    const t = mount(<Filter />);
    t.source.write("/fix");
    await vi.waitFor(() => expect(t.frame()).toContain("/fix"), { timeout: 2000 });
    t.source.write("\r");
    await vi.waitFor(() => expect(t.frame()).toContain("filter: fix"), { timeout: 2000 });
    t.app.unmount();
  });
});
