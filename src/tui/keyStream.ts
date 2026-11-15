import { Readable } from "node:stream";

// One key: a CSI or SS3 sequence, Alt plus a key, a lone Esc, or one code point.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal input is control characters
// oxlint-disable-next-line no-control-regex -- terminal input is control characters
const KEY = /\u001b\[[0-?]*[ -/]*[@-~]|\u001bO.|\u001b[\s\S]|[\s\S]/gu;

/** The keys in one chunk of terminal input, each as the terminal sent it. */
export function splitKeys(chunk: string): string[] {
  return chunk.match(KEY) ?? [];
}

/** Longer than this, text with no escape sequence is a paste, not typing. */
const PASTE = 8;

/**
 * How a chunk reaches the app: key by key, except a paste, which stays whole
 * (as Ink documents) so a text field takes it at once. A held key ("jjjjjjjjjj")
 * is not a paste however long.
 */
export function deliveries(chunk: string): string[] {
  const keys = splitKeys(chunk);
  const paste = keys.length > PASTE && !chunk.includes("\u001b") && keys.some((k) => k !== keys[0]);
  return paste ? [chunk] : keys;
}

type Source = NodeJS.ReadStream;

/**
 * Stdin for Ink that hands over one key per read, and the next only after the
 * app has re-rendered for it. Ink passes a whole chunk to useInput as one input, so
 * a burst ("jjj" from key repeat, or keys queued over a slow link such as
 * CloudShell's) counted as one key or none, and a key that arrived before the
 * re-render reached the previous render's handler.
 */
export function keyStream(source: Source): Source {
  const queue: string[] = [];
  let waiting = false;
  const stream = new Readable({ objectMode: true, read() {} });
  const next = () => {
    const key = queue.shift();
    if (key === undefined) {
      waiting = false;
      return;
    }
    waiting = true;
    stream.push(key);
    // Ordered by the event loop, not by time: the key is read and handled on
    // this turn, and React commits the render it causes in a setImmediate on
    // this turn too; a timer runs on the next turn at the earliest. useKeys
    // (hooks/useKeys.tsx) makes that commit enough. A fixed gap (16 ms) was
    // too short under load, when Ink's useInput still waited for a passive effect.
    setTimeout(next, 0);
  };
  const onData = (data: Buffer | string) => {
    queue.push(...deliveries(typeof data === "string" ? data : data.toString("utf8")));
    if (!waiting) next();
  };
  return Object.assign(stream, {
    isTTY: source.isTTY,
    setRawMode(mode: boolean) {
      source.setRawMode(mode);
      return this;
    },
    setEncoding() {
      return this;
    },
    // Ink refs stdin while some useInput is active: read the terminal only then,
    // so a prompt or editor run between screens keeps its input.
    ref() {
      source.on("data", onData);
      source.ref();
      return this;
    },
    unref() {
      source.off("data", onData);
      source.pause();
      source.unref();
      return this;
    },
  }) as unknown as Source;
}
