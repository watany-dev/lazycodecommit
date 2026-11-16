import { Text } from "ink";
import React, { useState } from "react";
import { useKeys } from "../hooks/useKeys.js";

interface Props {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
}

/**
 * A one-line text box: type at the cursor, ←/→ move it, Backspace deletes
 * before it, Enter submits. It reads keys through useKeys, not Ink's useInput
 * as ink-text-input did: keyStream hands over a chunk ("abc", an IME commit)
 * key by key, and a handler that is a render behind wrote each key over the
 * one before it (#92). The cursor counts code points, so an emoji is one step.
 */
export function TextField({ value, onChange, onSubmit }: Props) {
  const chars = [...value];
  const [offset, setOffset] = useState(chars.length);
  // The value can shrink from outside (a filter cleared, a paste cut short).
  const cursor = Math.min(offset, chars.length);

  useKeys((input, key) => {
    if (key.return) {
      onSubmit?.(value);
      return;
    }
    if (key.leftArrow) setOffset(Math.max(0, cursor - 1));
    else if (key.rightArrow) setOffset(Math.min(chars.length, cursor + 1));
    else if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setOffset(cursor - 1);
      onChange([...chars.slice(0, cursor - 1), ...chars.slice(cursor)].join(""));
    } else if (input && !key.ctrl && !key.meta && !key.tab) {
      // Up/Down, Esc, PageUp and the like arrive with no input and belong to the screen.
      setOffset(cursor + [...input].length);
      onChange([...chars.slice(0, cursor), input, ...chars.slice(cursor)].join(""));
    }
  });

  return (
    <Text>
      {chars.slice(0, cursor).join("")}
      <Text inverse>{chars[cursor] ?? " "}</Text>
      {chars.slice(cursor + 1).join("")}
    </Text>
  );
}
