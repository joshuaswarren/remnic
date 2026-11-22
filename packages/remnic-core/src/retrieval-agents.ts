
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isAbortError } from "./abort-error.js";
import { log } from "./logger.js";
import type { QmdClient } from "./qmd.js";
import { normalizeRecallTokens } from "./recall-tokenization.js";
import { isEncryptedFile } from "./secure-store/secure-fs.js";
import { isTemporalQuery, recencyWindowBoundsFromPrompt } from "./temporal-index.js";
import type { QmdSearchResult } from "./types.js";
import { isMacOsReplicationJunkBasename } from "./utils/macos-replication-junk.js";
import { isShapedUnnamedEntityRecord } from "./utils/malformed-entity-record.js";



export type SearchAgentSource = "direct" | "contextual" | "temporal";

export interface ParallelSearchResult extends QmdSearchResult {
  agentSource: SearchAgentSource;
}

/** Source-based weights applied during merge. Higher = higher confidence/precision. */
export const PARALLEL_AGENT_WEIGHTS: Record<SearchAgentSource, number> = {
  direct: 1.0, // entity-first: high precision
  temporal: 0.85, // recency-boosted: relevant but broader
  contextual: 0.7, // semantic: broadest, lower precision
};


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
      // Skip only if the query has no letter/number tokens. `\w` and `\b` are
      // ASCII-only, so CJK entity names would never start the direct agent.
      return knownEntityCount > 0 || /[\p{L}\p{N}]{2,}/u.test(query);
    case "temporal":
      return isTemporalQuery(query);
    case "contextual":
      return true;
    default:
      return true;
  }
}


function tokenize(value: string): string[] {
  return normalizeRecallTokens(value).filter((t) => t.length >= 2);
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


/**
 * Direct Facts Agent — entity-first retrieval.
 *
 * Reads entity filenames from the entities directory and scores them by
 * keyword overlap with the query. Returns matching entity file paths as
 * QmdSearchResult[]. Zero LLM inference; pure file I/O.
 *
 * Cost: readdir on entities/ + filename scoring. Typically <5ms.
 * Scored hits are read, up to the result cap, so a malformed record is not returned.
 *
 */
function namespaceRelativeResult(
  result: ParallelSearchResult,
  _memoryDir: string,
  namespaceFromPath?: (p: string) => string,
): ParallelSearchResult {
  if (!namespaceFromPath || !result.path || result.namespace) return result;
  return { ...result, namespace: namespaceFromPath(result.path) };
}

export async function runDirectAgent(
  query: string,
  memoryDir: string,
  maxResults = 10,
  namespaceFromPath?: (p: string) => string,
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

    const scored: Array<{ nameWithoutExt: string; safePath: string; score: number }> = [];
    for (const entry of entries) {
      if (isMacOsReplicationJunkBasename(entry) || !entry.endsWith(".md")) continue;

      // Filename tokens: split on hyphens (normalizeEntityName uses hyphens)
      const nameWithoutExt = entry.slice(0, -3);
      const entityTokens = nameWithoutExt.split("-").filter((t) => t.length >= 2).map((t) => t.toLowerCase());

      const score = overlapScore(queryTokens, entityTokens);
      if (score <= 0) continue;

      const fullPath = path.join(entitiesDir, entry);
      const safePath = await resolveContainedRegularFile(memoryDir, fullPath, canonicalRoot);
      if (!safePath) continue;
      scored.push({ nameWithoutExt, safePath, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const results: ParallelSearchResult[] = [];
    for (const hit of scored) {
      if (results.length >= maxResults) break;
      let bytes: Buffer;
      try {
        bytes = await readFile(hit.safePath);
      } catch {
        continue;
      }
      // Ciphertext has no heading. The secure resolver decrypts after this
      // candidate is kept; this scan does not look up a key.
      if (!isEncryptedFile(bytes) && isShapedUnnamedEntityRecord(bytes.toString("utf8"))) continue;
      results.push(
        namespaceRelativeResult(
          {
            docid: hit.nameWithoutExt,
            path: hit.safePath,
            snippet: "", // populated by augmentWithDirectAndTemporal after merge
            score: hit.score,
            transport: "scoped_prefilter",
            agentSource: "direct",
          },
          memoryDir,
          namespaceFromPath,
        ),
      );
    }

    return results;
  } catch (err) {
    log.debug(`DirectFactAgent error: ${err}`);
    return [];
  }
}


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
  namespaceFromPath?: (p: string) => string,
): Promise<ParallelSearchResult[]> {
  try {
    const canonicalRoot = await realpath(memoryDir);
    let dateIndex: Record<string, string[]> = {};
    try {
      const indexPath = path.join(memoryDir, "state", "index_time.json");
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as { dates?: Record<string, string[]> };
      dateIndex = parsed.dates ?? {};
    } catch {
      return []; // Index missing or unreadable — nothing to return
    }

    const { fromDate, toDate } = recencyWindowBoundsFromPrompt(query);

    const pathToDate = new Map<string, string>();
    for (const [date, datePaths] of Object.entries(dateIndex)) {
      // toDate is an exclusive upper bound (the first day NOT included in the window).
      // e.g. "3 days ago" → fromDate="2026-03-12", toDate="2026-03-13" → only includes 2026-03-12.
      if (date >= fromDate && date < toDate) {
        for (const p of datePaths) {
          if (candidatePaths && !candidatePaths.has(p)) continue;
          if (!pathToDate.has(p)) pathToDate.set(p, date);
        }
      }
    }

    if (pathToDate.size === 0) return [];

    const todayMs = Date.now();

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

      results.push(
        namespaceRelativeResult(
          {
            docid: baseName,
            path: safePath,
            snippet: "", // populated by augmentWithDirectAndTemporal after merge
            score,
            transport: "scoped_prefilter",
            agentSource: "temporal",
          },
          memoryDir,
          namespaceFromPath,
        ),
      );
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  } catch (err) {
    log.debug(`TemporalAgent error: ${err}`);
    return [];
  }
}


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


/**
 * Merge results from multiple agents into a single deduplicated, weighted list.
 * Deduplicates by (namespace, path). Contextual results carry a `namespace`
 * (from the namespace-fanout search); direct/temporal results do not. When a
 * `resolveNamespace` resolver is supplied, the missing namespace is derived from
 * the result path the same canonical way the contextual side derives it
 * (`result.namespace ?? resolveNamespace(result.path)`), so a direct/temporal hit
 * and a contextual hit for the same (namespace, path) collapse to ONE merge key
 * instead of being injected and access-counted twice. Preserves snippets: if a
 * higher-scoring result lacks a snippet, the existing snippet from a lower-scoring
 * source is retained.
 */
function mergeAgentResults(
  allResults: ParallelSearchResult[],
  weights: Record<SearchAgentSource, number>,
  maxResults: number,
  resolveNamespace?: (path: string) => string,
): QmdSearchResult[] {
  const merged = new Map<string, QmdSearchResult>();
  for (const result of allResults) {
    const namespace =
      result.namespace ?? (resolveNamespace && result.path ? resolveNamespace(result.path) : undefined);
    const key = `${namespace ?? ""}\0${result.path || result.docid}`;
    const weightedScore = result.score * weights[result.agentSource];
    const existing = merged.get(key);
    if (!existing || weightedScore > existing.score) {
      merged.set(key, {
        docid: result.docid,
        path: result.path,
        namespace,
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
  /** Optional namespace resolver. Direct/temporal results lack a namespace under
   * namespace fanout; deriving it from the path lets them collapse onto the same
   * merge key as the contextual result for the same (namespace, path). */
  resolveNamespace?: (path: string) => string,
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
    resolveNamespace,
  );
  return populateEmptySnippets(merged, memoryDir);
}


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
  /** Optional namespace resolver so direct/temporal results collapse onto the same
   * (namespace, path) merge key as their contextual counterpart. */
  resolveNamespace?: (path: string) => string,
): Promise<QmdSearchResult[]> {
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
      ? runTemporalAgent(query, memoryDir, maxPerAgent, candidatePaths).catch((err) => {
        log.debug(`augmentWithDirectAndTemporal: TemporalAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
  ]);
  const durationMs = Date.now() - startMs;

  const scopedDirect = directResults;

  const contextualTagged: ParallelSearchResult[] = contextualResults.map((r) => ({
    ...r,
    agentSource: "contextual" as const,
  }));

  log.debug(
    `augmentWithDirectAndTemporal: direct=${scopedDirect.length} temporal=${temporalResults.length} contextual=${contextualTagged.length} agentMs=${durationMs}ms`,
  );

  if (scopedDirect.length === 0 && temporalResults.length === 0) {
    return (contextualResults as QmdSearchResult[]).slice(0, maxResults);
  }

  const merged = mergeAgentResults(
    [...contextualTagged, ...scopedDirect, ...temporalResults],
    weights,
    maxResults,
    resolveNamespace,
  );

  return populateEmptySnippets(merged, memoryDir);
}


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
  /** Optional namespace resolver so direct/temporal results collapse onto the same
   * (namespace, path) merge key as the contextual result for the same path. */
  resolveNamespace?: (path: string) => string;
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

  const merged = mergeAgentResults(
    [...contextualResults, ...directResults, ...temporalResults],
    options.agentWeights ?? PARALLEL_AGENT_WEIGHTS,
    maxResults,
    options.resolveNamespace,
  );
  return populateEmptySnippets(merged, memoryDir);
}
