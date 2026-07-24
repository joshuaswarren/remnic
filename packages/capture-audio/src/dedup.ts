/**
 * Cross-channel dedup (issue #1897, component 2.4).
 *
 * A speakerphone is heard twice: once on the mic and once on the system
 * (loopback) channel. When the mic and system channels transcribe
 * near-identical text in overlapping time, keep the SYSTEM copy (the
 * cleaner far-end signal) and drop the mic copy. Match rule: word-level
 * Jaccard >= 0.8 within +-5 s. Pure over segment arrays so the pipeline
 * and the unit tests share one implementation.
 */

/** Minimum shape needed to dedup; the pipeline's richer segments satisfy it. */
export interface DedupSegment {
  channel: string;
  text: string;
  startUtc: string;
  endUtc: string;
}

/** Default temporal tolerance for "overlapping time" (ms). */
const OVERLAP_TOLERANCE_MS = 5_000;
/** Default word-level Jaccard threshold for "near-identical text". */
const JACCARD_THRESHOLD = 0.8;

function wordSet(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return new Set(words);
}

export function wordJaccard(a: string, b: string): number {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** True when two segments overlap in time, expanded by `toleranceMs` on each side. */
function overlapsWithin(a: DedupSegment, b: DedupSegment, toleranceMs: number): boolean {
  const aStart = Date.parse(a.startUtc);
  const aEnd = Date.parse(a.endUtc);
  const bStart = Date.parse(b.startUtc);
  const bEnd = Date.parse(b.endUtc);
  if (!Number.isFinite(aStart) || !Number.isFinite(aEnd) || !Number.isFinite(bStart) || !Number.isFinite(bEnd)) {
    return false;
  }
  return aStart <= bEnd + toleranceMs && bStart <= aEnd + toleranceMs;
}

/**
 * Drop mic segments that duplicate a system segment (overlapping time +
 * Jaccard >= threshold). System segments and non-duplicate mic segments
 * are preserved in input order. Generic so callers keep their richer type.
 */
export function dedupeCrossChannel<T extends DedupSegment>(
  segments: readonly T[],
  options: { toleranceMs?: number; jaccardThreshold?: number } = {},
): T[] {
  const toleranceMs = options.toleranceMs ?? OVERLAP_TOLERANCE_MS;
  const threshold = options.jaccardThreshold ?? JACCARD_THRESHOLD;
  const systemSegments = segments.filter((s) => s.channel === "system");
  return segments.filter((seg) => {
    if (seg.channel !== "mic") return true;
    const duplicated = systemSegments.some(
      (sys) => overlapsWithin(seg, sys, toleranceMs) && wordJaccard(seg.text, sys.text) >= threshold,
    );
    return !duplicated;
  });
}
