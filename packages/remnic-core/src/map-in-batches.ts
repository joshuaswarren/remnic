/**
 * Run `fn` over `items` in `size`-wide parallel batches. A harmonic graph build
 * resolves thousands of per-file reads (nodes, anchors, sources); awaiting
 * each in turn made builds take ~10-20 s on a real corpus, so every recall
 * that missed the cache paid the whole wait (issue #3450). The batch size
 * matches the corpus read path's (readParsedMemoriesFromPaths uses 50, #2307).
 */
export const HARMONIC_READ_BATCH_SIZE = 50;

export async function mapInBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += HARMONIC_READ_BATCH_SIZE) {
    const settled = await Promise.all(items.slice(i, i + HARMONIC_READ_BATCH_SIZE).map(fn));
    for (let j = 0; j < settled.length; j++) results[i + j] = settled[j];
  }
  return results;
}
