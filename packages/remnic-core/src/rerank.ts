export interface RerankCandidate {
  id: string;
  originalIndex: number;
}

export interface RerankScore {
  id: string;
  score: number;
}

export interface RerankCacheEntry {
  expiresAtMs: number;
  rankedIds: string[];
}

export class RerankCache {
  private entries = new Map<string, RerankCacheEntry>();

  get(key: string): string[] | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAtMs) {
      this.entries.delete(key);
      return null;
    }
    return e.rankedIds.slice();
  }

  set(key: string, rankedIds: string[], ttlMs: number): void {
    this.entries.set(key, { rankedIds: rankedIds.slice(), expiresAtMs: Date.now() + ttlMs });
  }
}

/**
 * Parse a rerank response (JSON) and return candidates sorted by score.
 *
 * Rules:
 * - Unknown IDs in the response are ignored.
 * - Candidates missing from the response keep relative order after scored ones.
 * - Stable tie-breaker: originalIndex ascending.
 */
export function parseRerankResponse(
  raw: string,
  candidates: RerankCandidate[],
): Array<RerankCandidate & { score?: number }> {
  const byId = new Map<string, RerankCandidate>();
  for (const c of candidates) byId.set(c.id, c);

  const scores = new Map<string, number>();
  try {
    const parsed = JSON.parse(raw) as { scores?: Array<Partial<RerankScore>> };
    if (Array.isArray(parsed.scores)) {
      for (const s of parsed.scores) {
        if (!s || typeof s.id !== "string") continue;
        if (!byId.has(s.id)) continue;
        if (typeof s.score !== "number" || !Number.isFinite(s.score)) continue;
        scores.set(s.id, s.score);
      }
    }
  } catch {
    // Ignore parse errors and fall back to original order.
  }

  const withScore = candidates.map((c) => ({
    ...c,
    score: scores.get(c.id),
  }));

  return withScore.sort((a, b) => {
    const as = a.score;
    const bs = b.score;
    if (typeof as === "number" && typeof bs === "number") {
      if (bs !== as) return bs - as;
      return a.originalIndex - b.originalIndex;
    }
    if (typeof as === "number") return -1;
    if (typeof bs === "number") return 1;
    return a.originalIndex - b.originalIndex;
  });
}

function stableKey(query: string, ids: string[]): string {
  // Keep it simple and deterministic; this is not a security boundary.
  return `${query.trim().toLowerCase()}|${ids.join(",")}`;
}

function clampSnippet(snippet: string, maxChars: number): string {
  const s = snippet.replace(/\s+/g, " ").trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

export async function rerankLocalOrNoop(opts: {
  query: string;
  candidates: Array<{ id: string; snippet: string }>;
  local: {
    chatCompletion: (
      messages: Array<{ role: string; content: string }>,
      options?: {
        maxTokens?: number;
        temperature?: number;
        timeoutMs?: number;
        operation?: string;
        priority?: "recall-critical" | "background";
      },
    ) => Promise<{ content: string } | null>;
  };
  enabled: boolean;
  timeoutMs: number;
  maxCandidates: number;
  cache?: RerankCache;
  cacheEnabled: boolean;
  cacheTtlMs: number;
}): Promise<string[] | null> {
  if (!opts.enabled) return null;

  const ids = opts.candidates.slice(0, opts.maxCandidates).map((c) => c.id);
  if (ids.length <= 1) return ids;

  const key = stableKey(opts.query, ids);
  if (opts.cache && opts.cacheEnabled) {
    const cached = opts.cache.get(key);
    if (cached) return cached;
  }

  const payload = opts.candidates.slice(0, opts.maxCandidates).map((c) => ({
    id: c.id,
    snippet: clampSnippet(c.snippet, 400),
  }));

  const system =
    "You are a ranking system. Return JSON only. No markdown, no commentary.";
  const user = JSON.stringify(
    {
      task: "rerank",
      query: opts.query,
      candidates: payload,
      output: {
        scores: [{ id: "string", score: "number 0-100" }],
      },
      rules: [
        "Assign higher score to more relevant candidates.",
        "Prefer durability and direct relevance to the query.",
        "If unsure, keep scores close together.",
      ],
    },
    null,
    0,
  );

  const res = await opts.local.chatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      maxTokens: 800,
      temperature: 0.0,
      timeoutMs: opts.timeoutMs,
      operation: "rerank",
      priority: "recall-critical",
    },
  );
  if (!res?.content) return null;

  const parsed = parseRerankResponse(
    res.content,
    ids.map((id, i) => ({ id, originalIndex: i })),
  );
  const rankedIds = parsed.map((p) => p.id);

  if (opts.cache && opts.cacheEnabled) {
    opts.cache.set(key, rankedIds, opts.cacheTtlMs);
  }

  return rankedIds;
}
