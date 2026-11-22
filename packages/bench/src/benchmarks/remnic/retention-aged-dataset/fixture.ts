
import type { MemoryFile } from "@remnic/core";

export interface AgedDatasetGeneratorOptions {
  size: number;
  horizonDays: number;
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
  text: string;
  topicId: number;
  /** Memory IDs that are relevant ground truth for this query. */
  relevantMemoryIds: string[];
}

export interface AgedDatasetFixture {
  options: AgedDatasetGeneratorOptions;
  memories: MemoryFile[];
  queries: AgedQuery[];
}

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

function paretoIndex(rng: () => number, n: number, alpha: number): number {
  if (n <= 1) return 0;
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
  const tableLen = TOPIC_KEYWORDS.length;
  const kws = TOPIC_KEYWORDS[topicId % tableLen];
  const generation = Math.floor(topicId / tableLen);
  const base = kws[slot % kws.length];
  return generation === 0 ? base : `${base}${generation}`;
}

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
  if (
    topicCount <= 0 ||
    !Number.isFinite(topicCount) ||
    !Number.isInteger(topicCount)
  ) {
    throw new Error(`topicCount must be a positive integer, got ${topicCount}`);
  }
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
  const memoriesByTopic: Map<number, string[]> = new Map();

  for (let i = 0; i < size; i += 1) {
    const topicId = paretoIndex(rng, topicCount, paretoAlpha);
    const ageDays = skewedAgeDays(rng, horizonDays, ageSkew);
    const createdMs = nowMs - ageDays * 24 * 60 * 60 * 1000;
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

  const MAX_TOTAL_QUERIES = 200;
  const RELEVANT_PER_QUERY = 5;
  const totalMemoryCount = memories.length;
  const totalShare = Math.min(MAX_TOTAL_QUERIES, Math.max(1, totalMemoryCount));
  const topicEntries = [...memoriesByTopic.entries()].sort(
    (a, b) => a[0] - b[0],
  );
  const rawCounts = topicEntries.map(([, ids]) =>
    Math.max(1, Math.round((ids.length / Math.max(1, totalMemoryCount)) * totalShare)),
  );
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
    const relevantSubset = [...ids]
      .sort((a, b) => {
        const recencyDelta = recencyMs(b) - recencyMs(a);
        if (recencyDelta !== 0) return recencyDelta;
        return a.localeCompare(b);
      })
      .slice(0, RELEVANT_PER_QUERY);
    for (let q = 0; q < topicQueryCount; q += 1) {
      queries.push({
        id: `topic-${topicId}-${q}`,
        text: `${topicWord(topicId, 0)} ${topicWord(topicId, 1)}`,
        topicId,
        relevantMemoryIds: relevantSubset,
      });
    }
  }
  queries.sort((a, b) => {
    if (a.topicId !== b.topicId) return a.topicId - b.topicId;
    return a.id.localeCompare(b.id);
  });

  return { options, memories, queries };
}
