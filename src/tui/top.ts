import type { Key } from "ink";

export type TopView = "home" | "branches" | "browse";

/** What a top-level view asks for: another view (1/2/3), or the repository picker (r). */
export type TopSwitch = { readonly view: TopView } | { readonly pick: true };

const VIEW_KEYS: Record<string, TopView> = { "1": "home", "2": "branches", "3": "browse" };

/** spec: トップレベル3ビュー共通. 1/2/3 switch views; r picks the repository. */
export function topSwitch(input: string, key: Key, current: TopView): TopSwitch | undefined {
  if (key.ctrl || key.meta) return undefined;
  const view = VIEW_KEYS[input];
  if (view) return view === current ? undefined : { view };
  return input === "r" ? { pick: true } : undefined;
}
