/**
 * Parallel Specialized Retrieval (v9.1 — ASMR-inspired)
 *
 * Replaces single-pass hybrid search with three parallel specialized agents:
 *
 *   1. DirectFactAgent  — entity-first lookup via entity filename index (<5ms)
 *   2. ContextualAgent  — existing hybridSearch (same cost as current single-pass)
 *   3. TemporalAgent    — temporal index prefilter + recency scoring (<10ms)
 *
 * All agents run via Promise.all(), so total latency = max(agents), not sum.
 * No new LLM inference is introduced — agents reuse existing search primitives.
 *
 * Graceful degradation: any agent error/timeout does not block the others.
 *
 * References:
 *   - Supermemory ASMR: https://blog.supermemory.ai/...
 *   - Spec: docs/ideas/parallel-specialized-retrieval.md
 */

import path from "node:path";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { log } from "./logger.js";
import type { QmdSearchResult } from "./types.js";
import type { QmdClient } from "./qmd.js";
import { isTemporalQuery, recencyWindowBoundsFromPrompt } from "./temporal-index.js";
import { isAbortError } from "./abort-error.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SearchAgentSource = "direct" | "contextual" | "temporal";

export interface ParallelSearchResult extends QmdSearchResult {
  /** Which retrieval agent produced this result. */
  agentSource: SearchAgentSource;
}

/** Source-based weights applied during merge. Higher = higher confidence/precision. */
export const PARALLEL_AGENT_WEIGHTS: Record<SearchAgentSource, number> = {
  direct: 1.0, // entity-first: high precision
  temporal: 0.85, // recency-boosted: relevant but broader
  contextual: 0.7, // semantic: broadest, lower precision
};

// ─── Query classification ────────────────────────────────────────────────────

/**
 * Decide whether a given agent should run for this query.
 * Agent 1 (direct) is the only one that may be skipped — when the query
 * contains no proper-noun-like tokens, entity lookups will return nothing.
 * Agents 2 (contextual) and 3 (temporal) always run.
 */
export function shouldRunAgent(
  agent: SearchAgentSource,
  query: string,
  knownEntityCount: number,
): boolean {
  switch (agent) {
    case "direct":
      // Skip only if query has no word-like tokens at all. Both capitalized and
      // lowercase entity names are stored (normalizeEntityName lowercases them),
      // so gating on capitalization would silently skip most real entity lookups.
      return knownEntityCount > 0 || /\b\w{2,}/.test(query);
    case "temporal":
      // Only run temporal agent when the query actually asks about a time window.
      // Running it for every query injects recency bias into semantic searches.
      return isTemporalQuery(query);
    case "contextual":
      return true;
    default:
      return true;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function overlapScore(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  const hits = queryTokens.filter((t) => candidateSet.has(t)).length;
  return hits / Math.max(queryTokens.length, candidateTokens.length);
}

async function resolveContainedRegularFile(
  memoryDir: string,
  candidatePath: string,
  canonicalRoot?: string,
): Promise<string | null> {
  try {
    const root = canonicalRoot ?? await realpath(memoryDir);
    const absolute = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(memoryDir, candidatePath);
    const entryStat = await lstat(absolute);
    if (entryStat.isSymbolicLink()) return null;
    const fileStat = await stat(absolute);
    if (!fileStat.isFile()) return null;
    const canonical = await realpath(absolute);
    if (canonical !== root && !canonical.startsWith(root + path.sep)) return null;
    return absolute;
  } catch {
    return null;
  }
}

// ─── Agent 1: Direct Facts ───────────────────────────────────────────────────

/**
 * Direct Facts Agent — entity-first retrieval.
 *
 * Reads entity filenames from the entities directory and scores them by
 * keyword overlap with the query. Returns matching entity file paths as
 * QmdSearchResult[]. Zero LLM inference; pure file I/O.
 *
 * Cost: readdir on entities/ + filename scoring. Typically <5ms.
 *
 */
export async function runDirectAgent(
  query: string,
  memoryDir: string,
  maxResults = 10,
): Promise<ParallelSearchResult[]> {
  try {
    const canonicalRoot = await realpath(memoryDir);
    const entitiesDir = path.join(memoryDir, "entities");
    let entries: string[];
    try {
      entries = await readdir(entitiesDir);
    } catch {
      return []; // entities dir missing or unreadable — not an error
    }

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const results: ParallelSearchResult[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      // Filename tokens: split on hyphens (normalizeEntityName uses hyphens)
      const nameWithoutExt = entry.slice(0, -3);
      const entityTokens = nameWithoutExt.split("-").filter((t) => t.length >= 2).map((t) => t.toLowerCase());

      const score = overlapScore(queryTokens, entityTokens);
      if (score <= 0) continue;

      const fullPath = path.join(entitiesDir, entry);
      const safePath = await resolveContainedRegularFile(memoryDir, fullPath, canonicalRoot);
      if (!safePath) continue;

      results.push({
        docid: nameWithoutExt,
        path: safePath,
        snippet: "", // populated by augmentWithDirectAndTemporal after merge
        score,
        transport: "scoped_prefilter",
        agentSource: "direct",
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  } catch (err) {
    log.debug(`DirectFactAgent error: ${err}`);
    return [];
  }
}

// ─── Agent 3: Temporal ───────────────────────────────────────────────────────

/**
 * Temporal Agent — recency-focused retrieval.
 *
 * Uses the temporal index (index_time.json) to find memories from the
 * recent time window derived from the query (default: last 7 days).
 * Combines recency decay with query-filename token overlap so results stay
 * relevant to the query content, not just recency. Zero LLM inference; File I/O + math.
 *
 * Cost: read index_time.json + date range scan. Typically <10ms.
 */
export async function runTemporalAgent(
  query: string,
  memoryDir: string,
  maxResults = 20,
  /** Optional candidate set from query-aware prefilter. Applied BEFORE the top-K cap so
   * in-scope entries are not displaced by newer out-of-scope entries. */
  candidatePaths?: Set<string> | null,
): Promise<ParallelSearchResult[]> {
  try {
    const canonicalRoot = await realpath(memoryDir);
    // Read index_time.json once — used for both date-range filtering and recency scoring.
    let dateIndex: Record<string, string[]> = {};
    try {
      const indexPath = path.join(memoryDir, "state", "index_time.json");
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as { dates?: Record<string, string[]> };
      dateIndex = parsed.dates ?? {};
    } catch {
      return []; // Index missing or unreadable — nothing to return
    }

    // Derive both window edges from the same function so fromDate/toDate always use
    // consistent pattern-matching and priority ordering.
    const { fromDate, toDate } = recencyWindowBoundsFromPrompt(query);

    // Build path → date map, filtering to the recency window in one pass.
    // Apply candidatePaths here (before scoring + top-K) so in-scope entries are
    // not displaced by newer out-of-scope entries at the slice boundary.
    const pathToDate = new Map<string, string>();
    for (const [date, datePaths] of Object.entries(dateIndex)) {
      // toDate is an exclusive upper bound (the first day NOT included in the window).
      // e.g. "3 days ago" → fromDate="2026-03-12", toDate="2026-03-13" → only includes 2026-03-12.
      if (date >= fromDate && date < toDate) {
        for (const p of datePaths) {
          // Skip paths excluded by the query-aware prefilter scope
          if (candidatePaths && !candidatePaths.has(p)) continue;
          if (!pathToDate.has(p)) pathToDate.set(p, date);
        }
      }
    }

    if (pathToDate.size === 0) return [];

    const todayMs = Date.now();

    // Extract non-temporal topic tokens for tag-based relevance boost.
    // Purely temporal words (dates, relative time) and common stopwords are stripped
    // so the signal reflects the subject the user is asking about (e.g. "auth" in
    // "what changed in auth last week"), not the time window itself.
    const TEMPORAL_STOPWORDS = new Set([
      "today", "yesterday", "this", "last", "week", "month", "year",
      "morning", "night", "now", "earlier", "since", "after", "before",
      "ago", "hours", "days", "weeks", "months",
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
      "what", "when", "where", "who", "why", "how", "the", "a", "an",
      "and", "or", "in", "on", "at", "to", "of", "for", "with", "by",
      "from", "changed", "happened", "was", "were", "is", "are", "did",
      "about", "that", "have", "had", "has", "been", "any", "all",
    ]);
    const topicTokens = tokenize(query).filter((t) => !TEMPORAL_STOPWORDS.has(t));

    // Load tag index for topical scoring, in parallel with existence checks.
    // Fail-open: if the tag index is unavailable, topicBoost = 0 and scores
    // degrade gracefully to recency-only ordering (existing behaviour).
    const entries = [...pathToDate.entries()];
    const tagIndexPromise: Promise<Map<string, string[]>> = topicTokens.length > 0
      ? readFile(path.join(memoryDir, "state", "index_tags.json"), "utf-8")
          .then((raw) => {
            const parsed = JSON.parse(raw) as { tags?: Record<string, { paths?: string[] } | string[]> };
            const result = new Map<string, string[]>();
            for (const [tag, node] of Object.entries(parsed.tags ?? {})) {
              const tagPaths = Array.isArray(node) ? node : (node.paths ?? []);
              for (const tp of tagPaths) {
                const existing = result.get(tp);
                if (existing) existing.push(tag);
                else result.set(tp, [tag]);
              }
            }
            return result;
          })
          .catch(() => new Map<string, string[]>())
      : Promise.resolve(new Map<string, string[]>());

    // Parallel: existence checks + tag index read.
    const [safePathResults, pathToTags] = await Promise.all([
      Promise.all(entries.map(([p]) => resolveContainedRegularFile(memoryDir, p, canonicalRoot))),
      tagIndexPromise,
    ]);

    const results: ParallelSearchResult[] = [];

    for (let i = 0; i < entries.length; i++) {
      const [p, dateStr] = entries[i];
      const safePath = safePathResults[i];
      if (!safePath) continue; // skip stale or out-of-root index entry
      const ageMs = todayMs - new Date(dateStr).getTime();
      const ageDays = ageMs / 86_400_000;
      // Exponential recency decay with half-life of ~30 days.
      // score ≈ 1.0 at day 0, ≈ 0.79 at 7 days, ≈ 0.36 at 30 days, ≈ 0.13 at 60 days.
      const recencyScore = Math.exp(-ageDays / 30);

      // Topical boost: fraction of non-temporal query tokens matched by this file's tags.
      // Adds up to +30% on recency score for a perfect tag match; zero when query is
      // purely temporal (no topic tokens) or the tag index doesn't cover the file.
      let topicBoost = 0;
      if (topicTokens.length > 0) {
        const tags = pathToTags.get(p) ?? pathToTags.get(safePath);
        if (tags && tags.length > 0) {
          const tagSet = new Set(tags.flatMap((t) => tokenize(t)));
          const hits = topicTokens.filter((t) => tagSet.has(t)).length;
          topicBoost = hits / topicTokens.length;
        }
      }
      const score = recencyScore * (1 + topicBoost * 0.3);

      const baseName = path.basename(safePath, ".md");

      results.push({
        docid: baseName,
        path: safePath,
        snippet: "", // populated by augmentWithDirectAndTemporal after merge
        score,
        transport: "scoped_prefilter",
        agentSource: "temporal",
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  } catch (err) {
    log.debug(`TemporalAgent error: ${err}`);
    return [];
  }
}

// ─── Agent 2: Contextual ─────────────────────────────────────────────────────

/**
 * Contextual Agent — broad semantic/hybrid search.
 *
 * Delegates to the existing hybridSearch (BM25 + vector). Same cost as the
 * current single-pass retrieval — this agent introduces no additional LLM calls.
 */
export async function runContextualAgent(
  query: string,
  qmd: QmdClient,
  collection: string | undefined,
  maxResults: number,
  signal?: AbortSignal,
): Promise<ParallelSearchResult[]> {
  try {
    const results = await qmd.hybridSearch(
      query,
      collection,
      maxResults,
      signal ? { signal } : undefined,
    );
    return results.map((r: QmdSearchResult) => ({ ...r, agentSource: "contextual" as const }));
  } catch (err) {
    if (isAbortError(err)) throw err;
    log.debug(`ContextualAgent error: ${err}`);
    return [];
  }
}

// ─── Merge helper ─────────────────────────────────────────────────────────────

/**
 * Merge results from multiple agents into a single deduplicated, weighted list.
 * Preserves snippets: if a higher-scoring result lacks a snippet, the existing
 * snippet from a lower-scoring source is retained.
 */
function mergeAgentResults(
  allResults: ParallelSearchResult[],
  weights: Record<SearchAgentSource, number>,
  maxResults: number,
): QmdSearchResult[] {
  const merged = new Map<string, QmdSearchResult>();
  for (const result of allResults) {
    const key = result.path || result.docid;
    const weightedScore = result.score * weights[result.agentSource];
    const existing = merged.get(key);
    if (!existing || weightedScore > existing.score) {
      merged.set(key, {
        docid: result.docid,
        path: result.path,
        // Preserve any snippet from the existing entry when the new one has none
        snippet: result.snippet || existing?.snippet || "",
        score: weightedScore,
        transport: "hybrid",
      });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * For merged results that have an empty snippet, attempt to read the first
 * 200 characters of the file as a fallback preview. Bounded to MAX_SNIPPET_READS
 * to cap I/O when many specialized-agent results are present.
 */
const SNIPPET_PREVIEW_CHARS = 200;
const MAX_SNIPPET_READS = 8;

/** Strip YAML frontmatter (---...---) and return the document body. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  // Skip the closing "---" line and any leading blank lines
  return raw.slice(end + 4).replace(/^\n+/, "");
}

async function populateEmptySnippets(results: QmdSearchResult[], memoryDir?: string): Promise<QmdSearchResult[]> {
  const needsSnippet = results.filter((r) => !r.snippet && r.path);
  if (needsSnippet.length === 0) return results;
  const canonicalRoot = memoryDir ? await realpath(memoryDir).catch(() => null) : null;

  const toRead = needsSnippet.slice(0, MAX_SNIPPET_READS);
  const snippetMap = new Map<string, string>();

  await Promise.all(
    toRead.map(async (r) => {
      try {
        const safePath = canonicalRoot && r.path
          ? await resolveContainedRegularFile(memoryDir!, r.path, canonicalRoot)
          : null;
        if (!safePath) return;
        const raw = await readFile(safePath, "utf-8");
        // Memory files start with YAML frontmatter — skip it so the snippet
        // contains actual memory content, not metadata fields.
        const body = stripFrontmatter(raw);
        const preview = body.slice(0, SNIPPET_PREVIEW_CHARS).replace(/\s+/g, " ").trim();
        if (preview) snippetMap.set(r.path, preview);
      } catch {
        // File unreadable — leave snippet empty
      }
    }),
  );

  if (snippetMap.size === 0) return results;
  return results.map((r) => (r.path && snippetMap.has(r.path) ? { ...r, snippet: snippetMap.get(r.path)! } : r));
}

/**
 * Merge pre-computed direct and temporal agent results with contextual results.
 *
 * This is the merge half of augmentWithDirectAndTemporal. Expose it separately so
 * callers that started agents concurrently with the contextual search (for true
 * parallel latency) can merge after all three complete, without re-running agents.
 *
 * Handles the same cases as augmentWithDirectAndTemporal:
 * - Returns contextual unchanged (no reweighting) when both agents return nothing
 * - Applies maxResults cap in all paths
 * - Populates snippets for results discovered only by specialized agents
 */
export async function mergeWithAgentResults(
  contextualResults: QmdSearchResult[],
  directResults: ParallelSearchResult[],
  temporalResults: ParallelSearchResult[],
  weights: Record<SearchAgentSource, number>,
  maxResults: number,
  memoryDir?: string,
): Promise<QmdSearchResult[]> {
  if (directResults.length === 0 && temporalResults.length === 0) {
    return contextualResults.slice(0, maxResults);
  }

  const contextualTagged: ParallelSearchResult[] = contextualResults.map((r) => ({
    ...r,
    agentSource: "contextual" as const,
  }));

  const merged = mergeAgentResults(
    [...contextualTagged, ...directResults, ...temporalResults],
    weights,
    maxResults,
  );
  return populateEmptySnippets(merged, memoryDir);
}

// ─── Augmentation helper (used by tests; orchestrator uses inline logic) ─────
//
// NOTE: This function passes the same `memoryDir` to both direct and temporal
// agents. The orchestrator's inline implementation differs: it passes a
// namespace-specific storage dir to runDirectAgent and the shared root to
// runTemporalAgent. augmentWithDirectAndTemporal is intentionally simpler
// (single-dir assumption) and is exercised by unit tests where both agents
// operate on the same temporary directory.

/**
 * Augment a set of contextual (hybridSearch) results with direct and temporal
 * agent results, returning a merged, deduplicated list.
 *
 * **Test helper** — production recall uses the inline orchestrator path which
 * passes namespace-specific directories to each agent. This function uses a
 * simplified single-directory contract suitable for unit tests.
 *
 * Direct and temporal agents run in parallel, then all three are merged with
 * configurable weights.
 *
 * Contextual weight is always applied to `contextualResults` so scoring is
 * consistent regardless of whether direct/temporal agents return anything.
 *
 * Snippets: snippets from contextual results are preserved during merge. For
 * results discovered only by direct/temporal agents (no contextual match),
 * the first ~200 chars of the file are read as a fallback preview so downstream
 * formatters and rerankers have content to work with, not just a path.
 */
export async function augmentWithDirectAndTemporal(
  query: string,
  memoryDir: string,
  contextualResults: QmdSearchResult[],
  weights: Record<SearchAgentSource, number>,
  maxPerAgent: number,
  maxResults: number,
  /** Optional candidate set from query-aware prefilter (time/tag scoped). Agents' results are
   * filtered to this set when provided so recall stays within the operator-specified scope. */
  candidatePaths?: Set<string> | null,
): Promise<QmdSearchResult[]> {
  // maxPerAgent=0 is a hard disable: skip agents entirely and return contextual unchanged
  if (maxPerAgent === 0) return contextualResults;

  const knownEntityCount = (query.match(/\b[A-Z][a-z]{1,}/g) ?? []).length;
  const runDirect = shouldRunAgent("direct", query, knownEntityCount);
  const runTemporal = shouldRunAgent("temporal", query, knownEntityCount);

  const startMs = Date.now();
  const [directResults, temporalResults] = await Promise.all([
    runDirect
      ? runDirectAgent(query, memoryDir, maxPerAgent).catch((err) => {
        log.debug(`augmentWithDirectAndTemporal: DirectAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
    runTemporal
      // Pass candidatePaths so scope-filtering happens before the top-K cap inside runTemporalAgent,
      // preventing out-of-scope newer entries from displacing in-scope ones at the slice boundary.
      ? runTemporalAgent(query, memoryDir, maxPerAgent, candidatePaths).catch((err) => {
        log.debug(`augmentWithDirectAndTemporal: TemporalAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
  ]);
  const durationMs = Date.now() - startMs;

  // Direct agent results (entities/) intentionally bypass candidatePaths.
  //
  // Why: candidatePaths is built from temporal + tag indexes, which never include
  // entity files (entities/*.md). Applying the filter here would silently drop ALL
  // direct-agent results for any scoped query, making the direct agent a no-op.
  // Entity files are identified by filename matching (query tokens vs. entity name),
  // so they are already query-scoped independently of the time/tag prefilter.
  // Temporal results are scoped inside runTemporalAgent() before the top-K cap.
  const scopedDirect = directResults;

  // Tag contextual results with their source so they can participate in weighted merge.
  // We do NOT cap contextual here: contextualResults comes from fetchQmdMemoryResultsWithArtifactTopUp
  // which intentionally over-fetches so downstream phases (graph expansion, lifecycle filtering,
  // reranking) can drop candidates. Capping before the merge would remove that headroom.
  const contextualTagged: ParallelSearchResult[] = contextualResults.map((r) => ({
    ...r,
    agentSource: "contextual" as const,
  }));

  log.debug(
    `augmentWithDirectAndTemporal: direct=${scopedDirect.length} temporal=${temporalResults.length} contextual=${contextualTagged.length} agentMs=${durationMs}ms`,
  );

  // If no specialized agents contributed anything (e.g. fresh setup without entities/ or temporal
  // index), skip reweighting entirely — applying the contextual weight penalty with zero benefit
  // would silently reduce every result score by ~30% compared to the non-augmented path.
  if (scopedDirect.length === 0 && temporalResults.length === 0) {
    return (contextualResults as QmdSearchResult[]).slice(0, maxResults);
  }

  // Merge all three; contextual first so its snippets are preserved when a higher-scoring
  // direct/temporal result overrides the same path (see mergeAgentResults snippet logic).
  // Note: maxPerAgent=0 is handled by the early-return guard above; we never reach here with 0.
  const merged = mergeAgentResults(
    [...contextualTagged, ...scopedDirect, ...temporalResults],
    weights,
    maxResults,
  );

  // Populate snippets for results discovered only by direct/temporal (no contextual preview)
  return populateEmptySnippets(merged, memoryDir);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export interface ParallelRetrievalOptions {
  collection?: string;
  maxResults?: number;
  signal?: AbortSignal;
  /** If true, skip the contextual agent (hybridSearch is already running externally). */
  skipContextual?: boolean;
  /** Max results per agent (capped before merge). */
  maxResultsPerAgent?: number;
  /** Override default agent weights. Falls back to PARALLEL_AGENT_WEIGHTS when absent. */
  agentWeights?: Record<SearchAgentSource, number>;
}

/**
 * Run parallel specialized retrieval agents and merge results.
 *
 * When `skipContextual` is true, only the direct and temporal agents run.
 * This is the intended usage inside the orchestrator, where hybridSearch
 * already runs as the primary search — we augment with the cheap extra agents.
 *
 * Total latency = max(agent_latencies), not sum.
 * Agent errors are isolated — others still return results.
 */
export async function parallelRetrieval(
  query: string,
  qmd: QmdClient,
  memoryDir: string,
  options: ParallelRetrievalOptions = {},
): Promise<QmdSearchResult[]> {
  const maxResults = options.maxResults ?? 20;
  const maxPerAgent = options.maxResultsPerAgent ?? maxResults;
  const startMs = Date.now();

  // Rough entity detection: count proper-noun-like tokens in query
  const knownEntityCount = (query.match(/\b[A-Z][a-z]{1,}/g) ?? []).length;

  const runDirect = shouldRunAgent("direct", query, knownEntityCount);
  const runTemporal = shouldRunAgent("temporal", query, knownEntityCount);
  const runContextual = !options.skipContextual && shouldRunAgent("contextual", query, knownEntityCount);

  const [directResults, temporalResults, contextualResults] = await Promise.all([
    runDirect
      ? runDirectAgent(query, memoryDir, maxPerAgent).catch((err) => {
        log.debug(`parallelRetrieval: DirectAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
    runTemporal
      ? runTemporalAgent(query, memoryDir, maxPerAgent).catch((err) => {
        log.debug(`parallelRetrieval: TemporalAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
    runContextual
      ? runContextualAgent(query, qmd, options.collection, maxPerAgent, options.signal).catch((err) => {
        if (isAbortError(err)) throw err;
        log.debug(`parallelRetrieval: ContextualAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
  ]);

  const durationMs = Date.now() - startMs;
  log.debug(
    `parallelRetrieval: direct=${directResults.length} temporal=${temporalResults.length} contextual=${contextualResults.length} durationMs=${durationMs}ms`,
  );

  // Contextual results go first so their snippets are preserved when a higher-scoring
  // direct/temporal result overrides the same path in mergeAgentResults.
  const merged = mergeAgentResults(
    [...contextualResults, ...directResults, ...temporalResults],
    options.agentWeights ?? PARALLEL_AGENT_WEIGHTS,
    maxResults,
  );
  return populateEmptySnippets(merged, memoryDir);
}
