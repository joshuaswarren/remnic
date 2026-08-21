/**
 * Synthetic aged-dataset fixture generator (issue #686 PR 2/6).
 *
 * Generates a hermetic corpus of memories spanning a configurable horizon
 * with Pareto-distributed query frequencies (a few "hot" topics queried
 * often; long-tail memories rarely queried). The fixture is deterministic
 * given a seed so bench results are reproducible.
 *
 * Why synthetic: the issue's goal is to measure structural properties of
 * the tier policy (recall@K, p95 latency proxy, hot/cold split) at 1- and
 * 2-year scale. A real corpus at that scale is unavailable and would risk
 * leaking personal data into a public-repo bench. The synthetic generator
 * is parameterized so the bench can be tuned for either horizon.
 */

import type { MemoryFile } from "@remnic/core";

export interface AgedDatasetGeneratorOptions {
  /** Total memory count. */
  size: number;
  /** Horizon in days. e.g. 365 (1y), 730 (2y). */
  horizonDays: number;
  /** Number of distinct topics. Each memory belongs to one topic. */
  topicCount: number;
  /**
   * Pareto shape parameter. Higher → more skewed (fewer hot topics carry
   * most queries). 1.16 ≈ Zipf with alpha 1, the classic "80/20" curve.
   */
  paretoAlpha: number;
  /**
   * Age skew. >1 means more old memories than recent (long-tail aged
   * dataset). =1 means uniform. <1 means more recent memories.
   */
  ageSkew: number;
  /** Deterministic seed. */
  seed: number;
  /** ISO timestamp anchoring "now" so bench is reproducible. */
  nowIso: string;
}

export interface AgedQuery {
  /**
   * Unique per-query identifier across the entire fixture. Used as the
   * task identifier in benchmark results; downstream consumers
   * (reporters, dedup, storage) key on this so collisions would
   * silently collapse rows.
   */
  id: string;
  /** Synthetic query text (topic-derived keywords). */
  text: string;
  /** ID of the topic this query targets. */
  topicId: number;
  /** Memory IDs that are relevant ground truth for this query. */
  relevantMemoryIds: string[];
}

export interface AgedDatasetFixture {
  options: AgedDatasetGeneratorOptions;
  memories: MemoryFile[];
  queries: AgedQuery[];
}

/**
 * Mulberry32 PRNG — small, deterministic, fast.
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a Zipf-distributed integer in [0, n).
 * Higher `alpha` = more skewed toward index 0.
 *
 * Uses a Zipf-style discrete distribution: P(rank=k) ∝ (k+1)^-alpha
 * across k ∈ [0, n-1], sampled by inverse-CDF lookup. This produces a
 * true long tail across all ranks; the previous Pareto-clamp approach
 * collapsed high-tail samples onto the last index, creating an
 * artificial second hotspot. (Codex P1 review on PR #698.)
 */
function paretoIndex(rng: () => number, n: number, alpha: number): number {
  if (n <= 1) return 0;
  // Build a rank-weight array (cached per-call; n is small for our bench).
  const weights: number[] = new Array(n);
  let total = 0;
  for (let k = 0; k < n; k += 1) {
    const w = Math.pow(k + 1, -alpha);
    weights[k] = w;
    total += w;
  }
  const u = rng() * total;
  let cum = 0;
  for (let k = 0; k < n; k += 1) {
    cum += weights[k];
    if (u <= cum) return k;
  }
  return n - 1;
}

/**
 * Skewed age in [0, horizonDays].
 * skew=1 → uniform, skew>1 → bias toward old, skew<1 → bias toward recent.
 */
function skewedAgeDays(rng: () => number, horizon: number, skew: number): number {
  const u = rng();
  return Math.floor(Math.pow(u, 1 / skew) * horizon);
}

const TOPIC_KEYWORDS = [
  ["alpha", "primary", "core"],
  ["beta", "secondary", "supporting"],
  ["gamma", "tertiary", "auxiliary"],
  ["delta", "change", "diff"],
  ["epsilon", "tiny", "minor"],
  ["zeta", "edge", "boundary"],
  ["eta", "ratio", "measure"],
  ["theta", "angle", "rotation"],
  ["iota", "small", "incremental"],
  ["kappa", "agreement", "consent"],
  ["lambda", "function", "compute"],
  ["mu", "average", "mean"],
  ["nu", "frequency", "cadence"],
  ["xi", "random", "noise"],
  ["omicron", "small", "letter"],
  ["pi", "circle", "ratio"],
];
const MAX_PRNG_SEED = 0xffffffff;

function topicWord(topicId: number, slot: number): string {
  // Disambiguate distinct topics that wrap past the keyword table's
  // length so query/content text stays unique even when topicCount
  // exceeds 16.  (Codex P2 + Cursor Medium review on PR #698: a bare
  // modulo collapsed topic 0 and topic 16 to identical text, and a
  // hyphenated `keyword-N` suffix was defeated by the ranker's
  // `[^a-z0-9]` tokenizer which splits the suffix back off.)  Format:
  // keyword for the first wrap, keyword + Nth-generation digit
  // CONCATENATED (no hyphen) so the result remains a single token after
  // tokenization — `alpha`, `alpha1`, `alpha2`, ...
  const tableLen = TOPIC_KEYWORDS.length;
  const kws = TOPIC_KEYWORDS[topicId % tableLen];
  const generation = Math.floor(topicId / tableLen);
  const base = kws[slot % kws.length];
  return generation === 0 ? base : `${base}${generation}`;
}

/**
 * Build a synthetic aged-corpus fixture.
 */
export function generateAgedDataset(
  options: AgedDatasetGeneratorOptions,
): AgedDatasetFixture {
  const {
    size,
    horizonDays,
    topicCount,
    paretoAlpha,
    ageSkew,
    seed,
    nowIso,
  } = options;

  if (size <= 0 || !Number.isFinite(size) || !Number.isInteger(size)) {
    throw new Error(`size must be a positive integer, got ${size}`);
  }
  // topicCount must be an integer — `new Array(n)` and the Zipf weight
  // builder both crash with a `RangeError` on fractional inputs.  Reject
  // here so callers see a clear validation error rather than a deep
  // stack trace from `paretoIndex` (Codex P2 review on PR #698).
  if (
    topicCount <= 0 ||
    !Number.isFinite(topicCount) ||
    !Number.isInteger(topicCount)
  ) {
    throw new Error(`topicCount must be a positive integer, got ${topicCount}`);
  }
  // paretoAlpha and ageSkew must be finite positive numbers — otherwise
  // the samplers silently produce degenerate corpora (collapsed topic
  // distribution or collapsed ages) and the bench reports successful
  // but useless results (Codex P2 review on PR #698).
  if (!Number.isFinite(paretoAlpha) || paretoAlpha <= 0) {
    throw new Error(
      `paretoAlpha must be a finite positive number, got ${paretoAlpha}`,
    );
  }
  if (!Number.isFinite(ageSkew) || ageSkew <= 0) {
    throw new Error(
      `ageSkew must be a finite positive number, got ${ageSkew}`,
    );
  }
  if (
    horizonDays <= 0 ||
    !Number.isFinite(horizonDays) ||
    !Number.isInteger(horizonDays)
  ) {
    throw new Error(`horizonDays must be a positive integer, got ${horizonDays}`);
  }
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > MAX_PRNG_SEED
  ) {
    throw new Error(
      `seed must be an integer in [0, ${MAX_PRNG_SEED}], got ${seed}`,
    );
  }

  const rng = mulberry32(seed);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`nowIso must be a valid ISO timestamp, got ${nowIso}`);
  }

  const memories: MemoryFile[] = [];
  // Track memories per topic so we can build relevant-id lists for queries.
  const memoriesByTopic: Map<number, string[]> = new Map();

  for (let i = 0; i < size; i += 1) {
    const topicId = paretoIndex(rng, topicCount, paretoAlpha);
    const ageDays = skewedAgeDays(rng, horizonDays, ageSkew);
    const createdMs = nowMs - ageDays * 24 * 60 * 60 * 1000;
    // Recent access bias: a few memories are accessed more often, mostly
    // mirroring the topic Pareto skew (a memory in a hot topic gets more
    // accesses).
    const accessCount = Math.max(
      0,
      Math.floor(rng() * 16 * Math.pow(2, -topicId / 4)),
    );
    const lastAccessedMs =
      accessCount > 0
        ? createdMs +
          Math.floor(rng() * Math.max(1, nowMs - createdMs))
        : createdMs;
    const id = `bench-mem-${seed}-${i.toString(16)}`;
    // Spread confidenceTier across the 4 production tiers so the bench
    // exercises the full range of demotion eligibility. Hot topics
    // (low topicId after Pareto sampling) lean toward "explicit" /
    // "implied"; cold-tail topics lean toward "inferred" / "speculative".
    // This mirrors the realistic distribution of facts produced by
    // extraction at scale.
    const confidenceTier =
      topicId === 0
        ? "explicit"
        : topicId === 1
          ? "implied"
          : topicId < topicCount / 2
            ? "inferred"
            : "speculative";
    const baseConfidence =
      confidenceTier === "explicit"
        ? 0.9
        : confidenceTier === "implied"
          ? 0.75
          : confidenceTier === "inferred"
            ? 0.55
            : 0.3;
    const memoryFile: MemoryFile = {
      path: `synthetic/facts/${id}.md`,
      frontmatter: {
        id,
        category: "fact",
        created: new Date(createdMs).toISOString(),
        updated: new Date(createdMs).toISOString(),
        source: "bench",
        confidence: baseConfidence + (rng() - 0.5) * 0.1,
        confidenceTier,
        tags: [topicWord(topicId, 0)],
        accessCount,
        lastAccessed: new Date(lastAccessedMs).toISOString(),
      },
      content: [
        topicWord(topicId, 0),
        topicWord(topicId, 1),
        topicWord(topicId, 2),
        `record-${i}`,
      ].join(" "),
    };
    memories.push(memoryFile);

    let perTopic = memoriesByTopic.get(topicId);
    if (!perTopic) {
      perTopic = [];
      memoriesByTopic.set(topicId, perTopic);
    }
    perTopic.push(id);
  }

  // Build a Pareto-weighted query workload.  Topic memory counts are
  // already Pareto-distributed (memories were sampled via
  // `paretoIndex`), so emitting one query per memory in a topic —
  // proportionally trimmed to the global `MAX_TOTAL_QUERIES` cap —
  // yields aggregate scores that reflect realistic hot-topic-heavy
  // traffic instead of weighting every topic equally.  Total queries
  // scale with total memory count so each topic's share of the workload
  // is proportional to its share of the corpus.
  //
  // Each query carries a *bounded* relevant-memory subset (the K most
  // recently-accessed members of the topic, capped at RELEVANT_PER_QUERY).
  // Without this cap, `recall_at_5` is structurally capped at
  // `5 / size_of_topic` for large topics — recall@5 against a 695-member
  // topic can never exceed ~0.007, making `recall_at_5_delta` insensitive
  // to tier-policy changes. Bounding the relevant set lets recall@5 range
  // freely across [0, 1]. (Cursor Bugbot medium-severity review on PR #698.)
  const MAX_TOTAL_QUERIES = 200;
  const RELEVANT_PER_QUERY = 5;
  const totalMemoryCount = memories.length;
  const totalShare = Math.min(MAX_TOTAL_QUERIES, Math.max(1, totalMemoryCount));
  // First pass: compute proportional integer query counts per topic.
  const topicEntries = [...memoriesByTopic.entries()].sort(
    (a, b) => a[0] - b[0],
  );
  const rawCounts = topicEntries.map(([, ids]) =>
    Math.max(1, Math.round((ids.length / Math.max(1, totalMemoryCount)) * totalShare)),
  );
  // Second pass: trim to MAX_TOTAL_QUERIES if rounding pushed us over.
  // Trim from the largest topics first so we don't drop sparse topics
  // below the floor of 1. If every topic is already at 1 and we're
  // STILL over the cap (high-topic fixtures), drop the lowest-frequency
  // topics entirely rather than emit > MAX_TOTAL_QUERIES queries.
  // (Codex P2 reviews on PR #698.)
  let runningTotal = rawCounts.reduce((s, n) => s + n, 0);
  while (runningTotal > MAX_TOTAL_QUERIES) {
    let maxIdx = 0;
    for (let i = 1; i < rawCounts.length; i += 1) {
      if (rawCounts[i] > rawCounts[maxIdx]) maxIdx = i;
    }
    if (rawCounts[maxIdx] > 1) {
      rawCounts[maxIdx] -= 1;
      runningTotal -= 1;
      continue;
    }
    // All topics are at the floor of 1 — drop the smallest-share topics
    // (the lowest topicId's memory count is largest by Pareto, so the
    // last-rank topic with the smallest memory count is dropped first).
    let smallestTopicMemoryCount = Number.POSITIVE_INFINITY;
    let smallestTopicEntryIdx = -1;
    for (let i = 0; i < rawCounts.length; i += 1) {
      if (rawCounts[i] === 0) continue;
      const topicMemoryCount = topicEntries[i][1].length;
      if (topicMemoryCount < smallestTopicMemoryCount) {
        smallestTopicMemoryCount = topicMemoryCount;
        smallestTopicEntryIdx = i;
      }
    }
    if (smallestTopicEntryIdx === -1) break;
    rawCounts[smallestTopicEntryIdx] = 0;
    runningTotal -= 1;
  }

  // Hoist the memory id→file lookup out of the per-topic loop — it's
  // identical for every topic, so building it once removes O(topics ×
  // memories) work without changing semantics. (Cursor low-severity
  // review on PR #698.)
  const memoryLookup = new Map<string, MemoryFile>();
  for (const memory of memories) {
    memoryLookup.set(memory.frontmatter.id, memory);
  }
  const recencyMs = (id: string): number => {
    const m = memoryLookup.get(id);
    if (!m) return 0;
    return Date.parse(
      m.frontmatter.lastAccessed
        ?? m.frontmatter.updated
        ?? m.frontmatter.created,
    );
  };

  const queries: AgedQuery[] = [];
  for (let i = 0; i < topicEntries.length; i += 1) {
    const [topicId, ids] = topicEntries[i];
    const topicQueryCount = rawCounts[i];
    if (topicQueryCount === 0) continue;
    // Choose the K most recently-touched memories as the bounded
    // relevant set. The fixture appends to `ids` in generation order,
    // not recency order, so we must sort by lastAccessed (falling back
    // to created/updated for memories with no access history) before
    // slicing. Without this sort, the "relevant" set is arbitrary early
    // memories, which `rankMemories` (recency-tiebreaker) systematically
    // misses, depressing recall scores and making the delta metric noisy
    // about real tier-policy behavior. (Codex P1 review on PR #698.)
    // Use the SAME tie-break the ranker applies (`id.localeCompare`)
    // so the labeled relevant set and the ranker's top-K agree on
    // which memories are "first" when timestamps tie.  Without this
    // alignment, `accessCount === 0` entries that share `ageDays`
    // ended up with a relevant set ordered by generation (stable sort
    // input order) and a ranker output ordered by id, depressing
    // recall@K through pure tie-break noise.  (Codex Medium review
    // on PR #698.)  Mirror this exact comparator in
    // `rankMemories` (runner.ts).
    const relevantSubset = [...ids]
      .sort((a, b) => {
        const recencyDelta = recencyMs(b) - recencyMs(a);
        if (recencyDelta !== 0) return recencyDelta;
        return a.localeCompare(b);
      })
      .slice(0, RELEVANT_PER_QUERY);
    for (let q = 0; q < topicQueryCount; q += 1) {
      queries.push({
        // Per-topic instance index keeps duplicates within a topic
        // distinguishable. Downstream consumers (reporters, dedup,
        // storage) key on taskId, so collisions would silently collapse
        // rows.
        id: `topic-${topicId}-${q}`,
        text: `${topicWord(topicId, 0)} ${topicWord(topicId, 1)}`,
        topicId,
        relevantMemoryIds: relevantSubset,
      });
    }
  }
  // Sort by topicId for determinism, with stable ordering within a topic.
  queries.sort((a, b) => {
    if (a.topicId !== b.topicId) return a.topicId - b.topicId;
    return a.id.localeCompare(b.id);
  });

  return { options, memories, queries };
}
