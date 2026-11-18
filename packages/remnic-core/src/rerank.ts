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

/** Snippet chars sent to the local rerank model (full snippets stay in storage). */
export const RERANK_LLM_SNIPPET_CHARS = 64;

/** Hard cap on candidates included in one local rerank prompt (latency). */
export const RERANK_LLM_MAX_CANDIDATES = 8;

/** Decode budget scales with id count so long order lists are not truncated. */
export function rerankOutputTokenBudget(candidateCount: number): number {
  if (candidateCount <= 0) return 48;
  return Math.min(256, 24 + candidateCount * 10);
}

type RerankJsonValue =
  | string
  | number
  | boolean
  | null
  | RerankJsonValue[]
  | { [key: string]: RerankJsonValue };

type RerankOrderPayload = { order: string[] };

function tryParseOrderPayload(raw: string): RerankOrderPayload | null {
  let value: RerankJsonValue;
  try {
    // SAFETY: JSON.parse returns only JSON-shaped values, which match `RerankJsonValue`.
    value = JSON.parse(raw) as RerankJsonValue;
  } catch {
    return null;
  }
  if (value === null || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  // SAFETY: guards above established a plain object record; we only read `order` next.
  const record = value as { order?: RerankJsonValue };
  const orderField = record.order;
  if (!Array.isArray(orderField)) return null;
  const order: string[] = [];
  for (const entry of orderField) {
    if (entry === null || entry === undefined) continue;
    if (!Object.is(entry, String(entry))) continue;
    order.push(String(entry));
  }
  if (order.length === 0) return null;
  return { order };
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
function candidateKey(c: RerankCandidate): string {
  return `${c.id}\0${c.originalIndex}`;
}

function rankedFromOrder(
  order: string[],
  candidates: RerankCandidate[]
): Array<RerankCandidate & { score?: number }> {
  const byId = new Map<string, RerankCandidate[]>();
  for (const c of candidates) {
    const bucket = byId.get(c.id);
    if (bucket) bucket.push(c);
    else byId.set(c.id, [c]);
  }
  const seen = new Set<string>();
  const ranked: Array<RerankCandidate & { score?: number }> = [];
  for (const id of order) {
    const bucket = byId.get(id);
    if (!bucket) continue;
    for (const c of bucket) {
      const key = candidateKey(c);
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push({ ...c });
    }
  }
  for (const c of candidates) {
    const key = candidateKey(c);
    if (!seen.has(key)) ranked.push({ ...c });
  }
  return ranked;
}

/** True when the model reply carried a parseable `order` rerank we should cache. */
export function rerankModelReplyIsStructured(raw: string): boolean {
  return tryParseOrderPayload(raw) !== null;
}

export function parseRerankResponse(
  raw: string,
  candidates: RerankCandidate[]
): Array<RerankCandidate & { score?: number }> {
  const byId = new Map<string, RerankCandidate>();
  for (const c of candidates) byId.set(c.id, c);

  const orderPayload = tryParseOrderPayload(raw);
  if (orderPayload) return rankedFromOrder(orderPayload.order, candidates);

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
  // Keep candidate boundaries explicit; candidate IDs are arbitrary strings.
  return JSON.stringify([query.trim().toLowerCase(), ids]);
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
      }
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

  const take = Math.min(opts.maxCandidates, RERANK_LLM_MAX_CANDIDATES);
  const ids = opts.candidates.slice(0, take).map((c) => c.id);
  if (ids.length <= 1) return ids;

  const key = stableKey(opts.query, ids);
  if (opts.cache && opts.cacheEnabled) {
    const cached = opts.cache.get(key);
    if (cached) return cached;
  }

  const payload = opts.candidates.slice(0, take).map((c) => ({
    id: c.id,
    snippet: clampSnippet(c.snippet, RERANK_LLM_SNIPPET_CHARS),
  }));

  const system =
    'Return JSON only: {"order":["id",...]} with ids best-first. Every id exactly once.';
  const user = JSON.stringify({
    q: opts.query,
    c: payload.map((p) => [p.id, p.snippet]),
  });

  const timeoutMs = Math.min(opts.timeoutMs, 2500);

  const res = await opts.local.chatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      maxTokens: rerankOutputTokenBudget(payload.length),
      temperature: 0.0,
      timeoutMs,
      operation: "rerank",
      priority: "recall-critical",
    }
  );
  if (!res?.content) return null;

  const parsed = parseRerankResponse(
    res.content,
    ids.map((id, i) => ({ id, originalIndex: i }))
  );
  const rankedIds = parsed.map((p) => p.id);

  if (opts.cache && opts.cacheEnabled && rerankModelReplyIsStructured(res.content)) {
    opts.cache.set(key, rankedIds, opts.cacheTtlMs);
  }

  return rankedIds;
}

/**
 * Reorder `results` to match `rankedKeys` (a ranker's output order), keying by
 * `keyOf`. Items not present in `rankedKeys` are appended in their original
 * order. `keyOf` must return a stable identity (e.g. namespace-qualified) so
 * same-relative-path items across namespaces are not conflated.
 */
export function reorderByRankedKeys<T>(
  results: readonly T[],
  rankedKeys: readonly string[],
  keyOf: (item: T) => string,
): T[] {
  const byKey = new Map(results.map((r) => [keyOf(r), r]));
  const reordered: T[] = [];
  for (const key of rankedKeys) {
    const it = byKey.get(key);
    if (it) reordered.push(it);
  }
  const rankedSet = new Set(rankedKeys);
  for (const r of results) if (!rankedSet.has(keyOf(r))) reordered.push(r);
  return reordered;
}
