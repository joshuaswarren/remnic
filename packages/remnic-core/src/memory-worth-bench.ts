/**
 * Issue #560 PR 5 — Memory Worth recall filter benchmark.
 *
 * Self-contained precision benchmark for `applyMemoryWorthFilter`. Seeds a
 * synthetic corpus where a small subset of memories have known-bad outcome
 * history, then compares top-K precision with the filter off vs. on.
 *
 * Why a dedicated in-package file (rather than the full `@remnic/bench`
 * harness): the filter is a pure function over candidate scores and counter
 * data; it doesn't need QMD, the orchestrator, or the schema-tier fixtures.
 * Running it as a plain `tsx` script keeps the signal tight — any drift in
 * the scorer's math shows up as a precision delta here, no integration
 * wiring required.
 *
 * The `runMemoryWorthBench()` export is the programmatic entry point;
 * `runMemoryWorthBenchCli()` is what `tsx` calls when this file is executed
 * directly. Both return (or print) a structured result so CI can gate on
 * it if we later want to.
 *
 * Verdict for PR 5: run the bench once, confirm filter-on ≥ filter-off on
 * precision@K across every seed, and only then flip the default to `true`.
 */

import {
  applyMemoryWorthFilter,
  type MemoryWorthCounters,
} from "./memory-worth-filter.js";

/**
 * One synthetic query + candidate pool + relevance labels.
 *
 * Candidates are scored by the pretend retrieval tier (`baseScore`); the
 * ground-truth relevance is `isRelevant`; `counters` seeds each candidate's
 * outcome history. Some "bad" candidates have baseline scores just above
 * the "good" candidates — the filter should be able to demote them.
 */
interface BenchCase {
  id: string;
  candidates: {
    path: string;
    baseScore: number;
    isRelevant: boolean;
    counters?: MemoryWorthCounters;
  }[];
  /** Top-K used for precision@K. */
  k: number;
}

/**
 * Deterministic pseudo-random number generator (mulberry32) so the bench
 * produces identical results across runs, making precision changes easy to
 * attribute to code rather than seed drift.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a synthetic test case.
 *
 * Corpus design:
 *   - 20 candidates per case.
 *   - Top 5 by base score include 2 "traps" — memories that the retriever
 *     ranks highly but whose outcome history is 10/0 failures. These should
 *     be sunk by the filter.
 *   - 3 lower-ranked memories are genuinely relevant with 10/0 success
 *     history. The filter should promote them into the top 5.
 *   - Remaining 15 are noise at the neutral prior (no counter data).
 *
 * `k = 5`, so the ideal precision@K is 3/5 = 0.6 (three genuinely relevant
 * items, after filter promotion). Without the filter, precision@5 is 0/5
 * because the top 5 by base score are the 2 traps + 3 irrelevant neutral
 * items.
 */
function buildCase(caseIndex: number, rng: () => number): BenchCase {
  const candidates: BenchCase["candidates"] = [];
  // 2 high-ranked traps: high base score, bad outcome history, NOT relevant.
  for (let i = 0; i < 2; i += 1) {
    candidates.push({
      path: `case-${caseIndex}-trap-${i}.md`,
      baseScore: 0.95 - i * 0.02,
      isRelevant: false,
      counters: { mw_success: 0, mw_fail: 10 },
    });
  }
  // 3 high-ranked irrelevant neutral items.
  for (let i = 0; i < 3; i += 1) {
    candidates.push({
      path: `case-${caseIndex}-noise-high-${i}.md`,
      baseScore: 0.9 - i * 0.02,
      isRelevant: false,
    });
  }
  // 3 lower-ranked TRUE POSITIVES with strong success history — the filter
  // must float these into the top 5.
  for (let i = 0; i < 3; i += 1) {
    candidates.push({
      path: `case-${caseIndex}-gold-${i}.md`,
      baseScore: 0.7 - i * 0.05,
      isRelevant: true,
      counters: { mw_success: 10, mw_fail: 0 },
    });
  }
  // 12 irrelevant noise candidates at random lower scores.
  for (let i = 0; i < 12; i += 1) {
    candidates.push({
      path: `case-${caseIndex}-noise-low-${i}.md`,
      baseScore: rng() * 0.5,
      isRelevant: false,
    });
  }
  // Shuffle to remove any input-order bias.
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }
  return { id: `case-${caseIndex}`, candidates, k: 5 };
}

function computePrecisionAtK(
  orderedPaths: string[],
  relevant: Set<string>,
  k: number,
): number {
  const topK = orderedPaths.slice(0, k);
  if (topK.length === 0) return 0;
  let hits = 0;
  for (const p of topK) if (relevant.has(p)) hits += 1;
  return hits / Math.min(k, topK.length);
}

export interface MemoryWorthBenchResult {
  cases: number;
  k: number;
  /** Mean precision@K with the filter disabled. */
  precisionAtK_off: number;
  /** Mean precision@K with the filter enabled. */
  precisionAtK_on: number;
  /** `on - off`; positive means filter helps, zero means tied. */
  delta: number;
  /** Filter-on wins at least as often as it loses, case-by-case. */
  filterWinsOrTies: boolean;
}

/**
 * Run the benchmark over N synthetic cases using a fixed PRNG seed. Returns
 * aggregate precision numbers + a boolean verdict.
 */
export function runMemoryWorthBench(options?: {
  cases?: number;
  seed?: number;
  now?: Date;
}): MemoryWorthBenchResult {
  const requestedCases = options?.cases ?? 50;
  // Reject non-positive-integer case counts. Passing 0 would divide by zero
  // and produce a NaN precision that the `filterWinsOrTies` boolean would
  // still mark as `true` — dangerously misleading since this result is used
  // to justify the default flip. Fractional values would inflate precision
  // because the loop rounds up (Array.from ceil) but the average divides
  // by the fractional input.
  if (
    !Number.isFinite(requestedCases) ||
    !Number.isInteger(requestedCases) ||
    requestedCases < 1
  ) {
    throw new Error(
      `runMemoryWorthBench: cases must be a positive integer; got ${requestedCases}`,
    );
  }
  const numCases = requestedCases;
  const rng = mulberry32(options?.seed ?? 0xdeadbeef);
  const now = options?.now ?? new Date("2026-01-01T00:00:00.000Z");

  let sumOff = 0;
  let sumOn = 0;
  let onWinsOrTies = 0;

  for (let i = 0; i < numCases; i += 1) {
    const c = buildCase(i, rng);
    const relevant = new Set(
      c.candidates.filter((x) => x.isRelevant).map((x) => x.path),
    );

    // Filter OFF: sort by baseScore descending.
    const off = [...c.candidates]
      .sort((a, b) => b.baseScore - a.baseScore)
      .map((x) => x.path);
    const pOff = computePrecisionAtK(off, relevant, c.k);

    // Filter ON: build counter map and apply the filter.
    const counters = new Map<string, MemoryWorthCounters>();
    for (const cand of c.candidates) {
      if (cand.counters) counters.set(cand.path, cand.counters);
    }
    const filtered = applyMemoryWorthFilter(
      c.candidates.map((x) => ({ path: x.path, score: x.baseScore })),
      { counters, now },
    );
    const on = filtered.map((x) => x.path);
    const pOn = computePrecisionAtK(on, relevant, c.k);

    sumOff += pOff;
    sumOn += pOn;
    if (pOn >= pOff) onWinsOrTies += 1;
  }

  const avgOff = sumOff / numCases;
  const avgOn = sumOn / numCases;
  return {
    cases: numCases,
    k: 5,
    precisionAtK_off: avgOff,
    precisionAtK_on: avgOn,
    delta: avgOn - avgOff,
    filterWinsOrTies: onWinsOrTies === numCases,
  };
}

/**
 * CLI entry point — run the bench and print a structured result. Exits
 * non-zero if the filter ever loses to the no-filter baseline (so CI can
 * gate on this in the future).
 */
export function runMemoryWorthBenchCli(): void {
  const result = runMemoryWorthBench();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (!result.filterWinsOrTies) {
    // eslint-disable-next-line no-console
    console.error("memory-worth bench: filter lost to no-filter baseline on at least one case");
    process.exit(1);
  }
}

// When this file is invoked directly (e.g. `tsx memory-worth-bench.ts`),
// run the CLI. Use url.pathToFileURL to produce a normalized file:// URL
// from `process.argv[1]` — that handles Windows drive letters,
// URL-encoded characters (spaces, etc.), and symlinked entrypoints. A
// naïve `file://${process.argv[1]}` comparison fails on all three and
// would silently skip runMemoryWorthBenchCli() on those platforms.
if (process.argv[1]) {
  try {
    // Lazy import so this file can still be loaded in environments that
    // don't have node:url (browsers, Deno test runners in some modes).
    const { pathToFileURL } = await import("node:url");
    if (import.meta.url === pathToFileURL(process.argv[1]).href) {
      runMemoryWorthBenchCli();
    }
  } catch {
    // If the normalization fails for any reason, fall back to the naive
    // comparison. Worse case: the bench doesn't auto-run; callers can
    // always invoke `runMemoryWorthBenchCli()` or `runMemoryWorthBench()`
    // explicitly.
    if (import.meta.url === `file://${process.argv[1]}`) {
      runMemoryWorthBenchCli();
    }
  }
}
