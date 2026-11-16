import { Box, type Key, Text } from "ink";
import React, { useState } from "react";
import { TextField } from "./TextField.js";

/** The "/" filter of a list screen: typing narrows, Enter keeps it, Esc clears it. */
export function useFilter() {
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  return {
    filter,
    setFilter,
    filtering,
    start: () => setFiltering(true),
    /** True when the key belonged to the filter box, so the screen ignores it. */
    handleKey(key: Key): boolean {
      if (!filtering) return false;
      if (key.escape) {
        setFiltering(false);
        setFilter("");
      } else if (key.return) setFiltering(false);
      return true;
    },
  };
}

export function FilterLine({ state }: { state: ReturnType<typeof useFilter> }) {
  return (
    <Box>
      {state.filtering ? (
        <>
          <Text>/</Text>
          <TextField value={state.filter} onChange={state.setFilter} />
        </>
      ) : (
        <Text dimColor>{state.filter ? `filter: ${state.filter}` : " "}</Text>
      )}
    </Box>
  );
}

/** First row of a height-row window over length rows that keeps index in view. */
export function windowStart(index: number, height: number, length: number): number {
  return Math.max(0, Math.min(index - height + 1, length - height));
}
