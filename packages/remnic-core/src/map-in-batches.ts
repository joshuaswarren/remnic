export const HARMONIC_READ_BATCH_SIZE = 50;

export async function mapInBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += HARMONIC_READ_BATCH_SIZE) {
    const settled = await Promise.all(items.slice(i, i + HARMONIC_READ_BATCH_SIZE).map(fn));
    for (let j = 0; j < settled.length; j++) results[i + j] = settled[j];
  }
  return results;
}
