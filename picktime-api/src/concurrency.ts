/** Bounded parallel fan-out with stable result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Run once, then once more if the failure is transient. Caller owns the retry policy. */
export async function retryOnce<T>(fn: () => Promise<T>, retryable: (err: unknown) => boolean): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!retryable(err)) throw err;
    return fn();
  }
}
