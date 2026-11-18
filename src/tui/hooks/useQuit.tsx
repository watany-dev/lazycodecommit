import { useApp } from "ink";
import React, { createContext, type ReactNode, useContext } from "react";

const QuitContext = createContext<(() => void) | null>(null);

/** Tells the caller that q asked to leave lazycc, not just the current view. */
export function QuitProvider({
  onQuit,
  children,
}: {
  readonly onQuit: () => void;
  readonly children: ReactNode;
}) {
  return <QuitContext.Provider value={onQuit}>{children}</QuitContext.Provider>;
}

/** q, as in lazygit: leave lazycc from any screen. */
export function useQuit(): () => void {
  const { exit } = useApp();
  const onQuit = useContext(QuitContext);
  return () => {
    onQuit?.();
    exit();
  };
}
