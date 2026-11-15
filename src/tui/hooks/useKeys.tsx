import { type Key, useInput } from "ink";
import React, {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";

type Handler = (input: string, key: Key) => void;
type Listener = { readonly current: { readonly handler: Handler; readonly active: boolean } };

const Bus = createContext<Set<Listener> | null>(null);

/**
 * One Ink useInput for the whole screen, handing each key to every useKeys
 * below it. Ink's own useInput swaps in a render's handler in a passive effect
 * and subscribes a new component the same way, so a key that came before
 * that effect (key repeat, a queued burst, a slow CPU) reached the previous
 * render's handler or no one. Here a component's latest handler, and its
 * subscription, take effect when the render commits.
 */
export function KeysProvider({ children }: { readonly children: ReactNode }) {
  const listeners = useRef(new Set<Listener>()).current;
  useInput((input, key) => {
    // A copy: a handler can open or close a component, which joins or leaves the set.
    // oxlint-disable-next-line unicorn/no-useless-spread -- iterate a snapshot, not the live set
    for (const l of [...listeners]) if (l.current.active) l.current.handler(input, key);
  });
  return <Bus.Provider value={listeners}>{children}</Bus.Provider>;
}

/**
 * useInput whose handler and isActive are always the latest render's.
 * Outside a KeysProvider (a component tested alone) it subscribes itself,
 * which still keeps the handler current.
 */
export function useKeys(handler: Handler, options: { readonly isActive?: boolean } = {}): void {
  const bus = useContext(Bus);
  const latest = useRef({ handler, active: options.isActive ?? true });
  useLayoutEffect(() => {
    latest.current = { handler, active: options.isActive ?? true };
  });
  useLayoutEffect(() => {
    if (!bus) return;
    bus.add(latest);
    return () => {
      bus.delete(latest);
    };
  }, [bus]);
  const own = useCallback<Handler>((input, key) => {
    if (latest.current.active) latest.current.handler(input, key);
  }, []);
  useInput(own, { isActive: bus === null });
}
