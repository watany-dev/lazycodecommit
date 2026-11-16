// Its own module, without the SDK: the CLI path imports it, and must not load the SDK up front.

/** Runs each task given to it with at most `limit` in flight, the rest in the order given. */
export function limiter(limit: number): <R>(task: () => Promise<R>) => Promise<R> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // The slot passes straight to the next task, so `active` stays as it is.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
export function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const run = limiter(limit);
  return Promise.all(items.map((item) => run(() => fn(item))));
}
