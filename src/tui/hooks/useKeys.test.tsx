import { Text } from "ink";
import { render } from "ink-testing-library";
import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { KeysProvider, useKeys } from "./useKeys.js";

/** One event-loop turn: no time for passive effects to run under load. */
const turn = () => new Promise((r) => setTimeout(r, 0));

/** ]c moves on, as the review screen's; d opens a prompt that takes y. */
function Screen({ onYes }: { onYes: () => void }) {
  const [pending, setPending] = useState(false);
  const [moves, setMoves] = useState(0);
  const [asking, setAsking] = useState(false);
  useKeys(
    (input) => {
      if (input === "]") setPending(true);
      else if (input === "c" && pending) {
        setPending(false);
        setMoves(moves + 1);
      } else if (input === "d") setAsking(true);
    },
    { isActive: !asking },
  );
  return (
    <>
      <Text>{`moves=${moves}`}</Text>
      {asking && <Prompt onYes={onYes} />}
    </>
  );
}

function Prompt({ onYes }: { onYes: () => void }) {
  useKeys((input) => {
    if (input === "y") onYes();
  });
  return <Text>sure?</Text>;
}

describe("useKeys under KeysProvider", () => {
  it("gives the next key the handler of the render the last key caused", async () => {
    const r = render(
      <KeysProvider>
        <Screen onYes={() => {}} />
      </KeysProvider>,
    );
    for (const k of ["]", "c", "]", "c"]) {
      r.stdin.write(k);
      await turn();
    }
    await vi.waitFor(() => expect(r.lastFrame()).toContain("moves=2"));
  });

  it("hands the next key to a prompt the last key opened, and not to the screen", async () => {
    const onYes = vi.fn();
    const r = render(
      <KeysProvider>
        <Screen onYes={onYes} />
      </KeysProvider>,
    );
    r.stdin.write("d");
    await turn();
    r.stdin.write("y");
    await vi.waitFor(() => expect(onYes).toHaveBeenCalledOnce());
    // The screen is inactive while it asks: ]c does nothing.
    for (const k of ["]", "c"]) {
      r.stdin.write(k);
      await turn();
    }
    await turn();
    expect(r.lastFrame()).toContain("moves=0");
  });
});

describe("useKeys alone", () => {
  it("keeps its handler current without a provider", async () => {
    const r = render(<Screen onYes={() => {}} />);
    await turn();
    for (const k of ["]", "c"]) {
      r.stdin.write(k);
      await turn();
    }
    await vi.waitFor(() => expect(r.lastFrame()).toContain("moves=1"));
  });
});

describe("useKeys leaving the screen", () => {
  function Listener({ onKey }: { onKey: (input: string) => void }) {
    useKeys((input) => onKey(input));
    return <Text>listening</Text>;
  }

  it("gives no key to a component that is gone", async () => {
    const onKey = vi.fn();
    const r = render(
      <KeysProvider>
        <Listener onKey={onKey} />
      </KeysProvider>,
    );
    await turn();
    r.rerender(
      <KeysProvider>
        <Text>gone</Text>
      </KeysProvider>,
    );
    await turn();
    r.stdin.write("x");
    await turn();
    await turn();
    expect(onKey).not.toHaveBeenCalled();
  });
});
