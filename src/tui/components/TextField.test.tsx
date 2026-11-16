import { useState } from "react";
import { describe, expect, it } from "vitest";
import { press, render } from "../../testing/keys.js";
import { TextField } from "./TextField.js";

function Field({ initial = "" }: { readonly initial?: string }) {
  const [value, setValue] = useState(initial);
  return <TextField value={value} onChange={setValue} />;
}

describe("TextField", () => {
  it("steps over an emoji in one move and does nothing past either end", async () => {
    const screen = render(<Field initial="😀" />);
    await press(screen, "\u001b[C", "\u001b[D", "\u001b[D", "\u007f", "a");
    expect(screen.lastFrame()).toBe("a😀");
  });

  it("leaves out Ctrl and Alt chords, which belong to the screen", async () => {
    const screen = render(<Field />);
    await press(screen, "\u0001", "\u001bx", "b");
    expect(screen.lastFrame()).toBe("b");
  });
});
