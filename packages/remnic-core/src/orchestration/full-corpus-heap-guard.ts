/**
 * Heap guard for scheduled full-corpus work.
 *
 * A daemon already near Node's default heap limit must not start another
 * multi-GB allocation (the scheduled projection rebuild loads hot, cold, and
 * archived memories plus the lifecycle ledger). Callers postpone the job and
 * arm their existing failure backoff instead.
 */

export interface HeapLimitStatistics {
  used_heap_size: number;
  heap_size_limit: number;
}

export interface FullCorpusHeapPressure {
  /** True when usage is strictly above `limitRatio`. */
  postpone: boolean;
  /** `used_heap_size / heap_size_limit`, or 0 when the statistics are unusable. */
  ratio: number;
}

/**
 * Decide whether a scheduled full-corpus job should wait. Non-finite or
 * non-positive heap limits do not postpone (there is no ratio to trust).
 * Comparison is strict `>` so a limit of `1` never fires.
 */
export function fullCorpusHeapPressure(
  stats: HeapLimitStatistics,
  limitRatio: number,
): FullCorpusHeapPressure {
  const used = stats.used_heap_size;
  const cap = stats.heap_size_limit;
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(cap) || cap <= 0 || !Number.isFinite(limitRatio)) {
    return { postpone: false, ratio: 0 };
  }
  const ratio = used / cap;
  return { postpone: ratio > limitRatio, ratio };
}
