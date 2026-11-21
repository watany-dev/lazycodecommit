/** Collapses per-file blob arrivals into one React state update. */
export function createBatcher<T>(
  apply: (items: T[]) => void,
  delayMs: number,
): { enqueue: (item: T) => void; flush: () => void } {
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function take(): T[] {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const items = pending;
    pending = [];
    return items;
  }

  return {
    enqueue(item: T) {
      pending.push(item);
      if (timer !== null) return;
      timer = setTimeout(() => {
        apply(take());
      }, delayMs);
    },
    flush() {
      const items = take();
      if (items.length > 0) apply(items);
    },
  };
}
