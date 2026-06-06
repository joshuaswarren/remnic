/**
 * Extraction Judge — LLM-as-judge fact-worthiness gate (issue #376).
 *
 * Evaluates extracted facts against a durability rubric before they are
 * persisted. Facts that are unlikely to be useful 30+ days from now or
 * across sessions are rejected (or shadow-logged depending on config).
 *
 * Design constraints:
 *   - Corrections and principles are auto-approved (safety bypass).
 *   - Critical-importance facts are auto-approved.
 *   - Batches respect extractionJudgeBatchSize.
 *   - Content-hash caching avoids redundant LLM calls.
 *   - Performance budget: <= 1.5s per batch.
 */

import { createHash } from "node:crypto";
import { log } from "./logger.js";
import type { PluginConfig, ImportanceLevel } from "./types.js";
import type { LocalLlmClient } from "./local-llm.js";
import { type FallbackLlmClient, gatewayTaskChainOptions } from "./fallback-llm.js";
import { extractJsonCandidates } from "./json-extract.js";
import { normalizeProcedureSteps } from "./procedural/procedure-types.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface JudgeCandidate {
  text: string;
  category: string;
  confidence: number;
  tags?: string[];
  /** Local importance level, set by caller before judging. */
  importanceLevel?: ImportanceLevel;
}

/**
 * Verdict kinds (issue #562, PR 1).
 *
 * - `"accept"`: fact is durable, persist it.
 * - `"reject"`: fact is not durable, drop it.
 * - `"defer"`: fact is ambiguous; push it back into the buffer for another
 *   pass with fresh context. Inspired by MemReader (arxiv 2604.07877).
 *
 * PR 1 only introduces the type. No emit path produces `"defer"` yet — the
 * defer-capable prompt, buffer re-routing, telemetry, and GRPO data
 * collection are landing in PRs 2, 3, and 4 respectively.
 */
export type JudgeVerdictKind = "accept" | "reject" | "defer";

/**
 * Judge verdict shape.
 *
 * Back-compat note: `kind` is optional. Verdicts serialized before PR 1
 * (both in-memory cache entries and any persisted caches) only carry
 * `{ durable, reason }`. Downstream consumers must either read `durable`
 * directly, or use {@link getVerdictKind} / {@link isDurableVerdict} which
 * gracefully fall back to the boolean when `kind` is missing, and ignore
 * unknown future `kind` values rather than crashing.
 */
export interface JudgeVerdict {
  /**
   * True iff the fact should be persisted. For `"defer"` verdicts this is
   * `false` — a deferred fact is not (yet) persisted, so callers that only
   * look at `durable` will treat defer as "skip this turn", which matches
   * the pre-PR-1 fail-closed behavior for non-accepted verdicts.
   */
  durable: boolean;
  reason: string;
  /**
   * Optional explicit verdict kind. Added in PR 1 of issue #562. Legacy
   * verdicts (including cache entries produced before this field existed)
   * do not set `kind`; use {@link getVerdictKind} to read this safely.
   */
  kind?: JudgeVerdictKind;
}

/**
 * Resolve a verdict's effective kind.
 *
 * - If `kind` is explicitly set to one of the known values, return it.
 * - If `kind` is absent, infer from `durable` (back-compat with pre-PR-1
 *   cache entries and emit paths that have not been updated yet).
 * - If `kind` is set to an unrecognised value (forward-compat, e.g. a
 *   future cache entry loaded by an older build), fall back to `durable`
 *   so we never crash on unknown strings.
 */
export function getVerdictKind(verdict: JudgeVerdict): JudgeVerdictKind {
  const raw = verdict.kind;
  if (raw === "accept" || raw === "reject" || raw === "defer") {
    return raw;
  }
  return verdict.durable ? "accept" : "reject";
}

/**
 * Type guard: returns `true` only for verdicts that should be persisted.
 * Treats both `"reject"` and `"defer"` as "not durable" — defer means the
 * caller should re-evaluate later, not write now.
 */
export function isDurableVerdict(verdict: JudgeVerdict): boolean {
  return getVerdictKind(verdict) === "accept";
}

/**
 * Validate a cache entry loaded from persistence / another process.
 *
 * Strict: accepts legacy `{ durable, reason }` entries and new entries
 * whose `kind` is one of the three known `JudgeVerdictKind` values.
 * Rejects structurally wrong types and unknown `kind` strings so the
 * type-guard narrowing is sound — callers that receive
 * `value is JudgeVerdict` can safely treat `kind` as the declared
 * union.
 *
 * Forward-compat is handled by {@link normalizeCachedVerdict}, which
 * drops unknown `kind` strings before validation so a newer build's
 * cache entry still loads instead of being rejected.
 */
export function isValidCachedVerdict(value: unknown): value is JudgeVerdict {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.durable !== "boolean") return false;
  if (typeof v.reason !== "string") return false;
  if (v.kind !== undefined) {
    if (v.kind !== "accept" && v.kind !== "reject" && v.kind !== "defer") {
      return false;
    }
  }
  return true;
}

/**
 * Forward-compatible cache-entry loader.
 *
 * Drops unknown `kind` strings to `undefined` (so `getVerdictKind` can
 * fall back to `durable`), then validates structurally. Non-string
 * `kind` values are still treated as structural violations and rejected.
 * Returns the sanitised verdict, or `null` when the entry is structurally
 * unusable.
 */
export function normalizeCachedVerdict(value: unknown): JudgeVerdict | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.durable !== "boolean") return null;
  if (typeof v.reason !== "string") return null;
  let kind: JudgeVerdictKind | undefined;
  if (v.kind !== undefined) {
    if (typeof v.kind !== "string") return null;
    if (v.kind === "accept" || v.kind === "reject" || v.kind === "defer") {
      kind = v.kind;
    }
    // Unknown string `kind`: dropped to undefined for forward-compat.
  }
  const out: JudgeVerdict = { durable: v.durable, reason: v.reason };
  if (kind !== undefined) out.kind = kind;
  return out;
}

export interface JudgeBatchResult {
  verdicts: Map<number, JudgeVerdict>;
  /** Number of verdicts served from cache. */
  cached: number;
  /** Number of verdicts produced by an LLM call. */
  judged: number;
  /** Total wall-clock time in milliseconds. */
  elapsed: number;
  /**
   * Number of verdicts in this batch that resolved to `"defer"` (issue #562,
   * PR 2). Callers can use this to decide whether to retain buffer turns for
   * the next extraction pass.
   */
  deferred: number;
  /**
   * Number of defers that were forcibly converted to `"reject"` because the
   * same candidate text had already been deferred at least
   * `extractionJudgeMaxDeferrals` times. Rolled out of `deferred` — a
   * candidate counted here is *not* also in `deferred`.
   */
  deferredCappedToReject: number;
}

/**
 * Per-verdict observation emitted by `judgeFactDurability` when an
 * `onVerdict` callback is supplied (issue #562, PR 3). Used to wire the
 * observation ledger / telemetry stream without coupling the judge module
 * directly to filesystem I/O. One event is emitted for every resolved
 * verdict, including auto-approved and cache-hit paths.
 */
export interface JudgeVerdictObservation {
  verdict: JudgeVerdict;
  /** The original `JudgeCandidate` passed in (same reference). */
  candidate: JudgeCandidate;
  /** SHA-256 of `text\0category`, same key the cache/deferCounter use. */
  contentHash: string;
  /** Verdict resolution path. Useful for debugging + dashboards. */
  source: "auto-approve" | "cache" | "llm" | "llm-cap-rejected" | "fail-open";
  /**
   * How many times this candidate had already been deferred before this
   * verdict resolved. 0 when the candidate had never been deferred.
   */
  priorDeferrals: number;
  /**
   * Milliseconds from batch start to now. Shared across verdicts emitted in
   * the same batch.
   */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Prompt (embedded; mirrors prompts/extraction_judge.prompt.md)
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are a memory curator evaluating whether extracted facts are **durable** — worth storing for long-term recall across sessions.

A fact is **durable** if it will still be useful 30+ days from now and is relevant across multiple sessions, not just the current task.

Return one of three verdicts per candidate:

ACCEPT — the fact is durable, persist it:
- Personal preferences, identities, or relationships
- Decisions with rationale that affect future work
- Corrections to previously held beliefs
- Principles, rules, or constraints the user wants respected
- Stable facts about projects, tools, or workflows
- Commitments, deadlines, or obligations

REJECT — the fact is not durable, drop it:
- Transient task details ("currently debugging line 42")
- Ephemeral state ("the build is running now")
- Routine operations ("ran npm install")
- Conversational filler or acknowledgements
- Information that will be stale within hours
- Step-by-step instructions for a one-time task

DEFER — the fact MIGHT be durable but needs more context to decide. The candidate will be re-evaluated on a later extraction pass with fresh context; if it cannot be resolved within a small number of re-evaluations it will be rejected.
- Ambiguous referents ("he said they'd follow up on it")
- Partial or in-progress statements that might become durable once completed
- Future-tense commitments whose subject or timeline is unclear
- Facts whose durability hinges on context not present in the candidate text

Do NOT use defer as a soft reject. Reject facts you are confident are transient. Only defer when another turn of context would genuinely change the verdict.

Return a JSON array of objects with these fields:
- index: number (the candidate index)
- kind: string — one of "accept", "reject", "defer"
- reason: string (brief explanation, under 80 characters)

You may also include durable (boolean) for backwards compatibility: true for accept, false for reject or defer. If kind is omitted, durable determines the verdict.

Rules:
1. Return exactly one verdict per input candidate, matched by index.
2. When in doubt between accept and reject, lean toward accept — false negatives (losing a useful fact) are worse than false positives (keeping a marginal one).
3. Use defer only when another turn of context would genuinely change the verdict.
4. Output valid JSON only. No markdown fences, no commentary.

Example output:
[{"index": 0, "kind": "accept", "durable": true, "reason": "Stable personal preference"}, {"index": 1, "kind": "reject", "durable": false, "reason": "Ephemeral build status"}, {"index": 2, "kind": "defer", "durable": false, "reason": "Ambiguous pronoun"}]`;

// ---------------------------------------------------------------------------
// Content-hash cache (in-memory, per-process fallback)
// ---------------------------------------------------------------------------

/** Maximum entries before evicting the oldest half. */
const VERDICT_CACHE_MAX_SIZE = 10_000;

/** Module-level fallback cache, used when callers do not pass their own. */
const defaultVerdictCache = new Map<string, JudgeVerdict>();

/**
 * Per-content-hash deferral counter (issue #562, PR 2).
 *
 * When the judge emits a `"defer"` verdict for a candidate whose content
 * has already been deferred `extractionJudgeMaxDeferrals` times, the verdict
 * is forcibly converted to `"reject"` so a pathological LLM response cannot
 * produce an infinite defer loop.
 *
 * Module-level with a size cap so stale test state cannot leak between runs
 * in the unlikely case a caller does not clear it between processes.
 */
const defaultDeferCounts = new Map<string, number>();
const DEFER_COUNT_MAX_SIZE = 20_000;

function cacheKey(text: string, category: string): string {
  return createHash("sha256").update(`${text}\0${category}`).digest("hex");
}

/**
 * Resolve the effective defer cap from config, defaulting to 2 when the
 * config value is missing or non-positive. Matches the PR 2 spec.
 */
function resolveDeferCap(config: PluginConfig): number {
  const raw = (config as { extractionJudgeMaxDeferrals?: number })
    .extractionJudgeMaxDeferrals;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  return 2;
}

/**
 * Enforce the max-size invariant on a verdict cache. When the cache exceeds
 * VERDICT_CACHE_MAX_SIZE, the oldest half of entries are deleted (Map
 * iteration order is insertion order).
 */
function enforceMaxCacheSize(cache: Map<string, JudgeVerdict>): void {
  if (cache.size <= VERDICT_CACHE_MAX_SIZE) return;
  const deleteCount = Math.floor(cache.size / 2);
  let deleted = 0;
  for (const key of cache.keys()) {
    if (deleted >= deleteCount) break;
    cache.delete(key);
    deleted++;
  }
}

// ---------------------------------------------------------------------------
// Categories that bypass the judge (safety / correctness)
// ---------------------------------------------------------------------------

const AUTO_APPROVE_CATEGORIES = new Set(["correction", "principle"]);

/** Explicit trigger phrasing — procedures must match to persist (issue #519). */
const PROCEDURE_TRIGGER_RE =
  /(when you|whenever|before you|before running|always\s|first\b.*\bthen|to deploy|to ship|run these steps|follow these steps|how (i|we)\s|recipe for|workflow|each time you)/i;

/**
 * Deterministic gate for extracted `procedure` memories: ≥2 steps with non-empty
 * intents and explicit trigger wording in title and/or steps.
 */
export function validateProcedureExtraction(input: {
  content: string;
  procedureSteps?: unknown;
}): JudgeVerdict {
  const steps = normalizeProcedureSteps(input.procedureSteps);
  if (steps.length < 2) {
    return { durable: false, reason: "Procedure requires at least two steps with intents" };
  }
  const combined = [input.content, ...steps.map((s) => s.intent)].join(" ").toLowerCase();
  if (!PROCEDURE_TRIGGER_RE.test(combined)) {
    return { durable: false, reason: "Procedure missing explicit trigger phrasing" };
  }
  return { durable: true, reason: "Procedure structure validated" };
}

// ---------------------------------------------------------------------------
// Core judge function
// ---------------------------------------------------------------------------

/**
 * Evaluate a batch of candidate facts for durability.
 *
 * Auto-approves corrections, principles, and critical-importance facts.
 * Remaining candidates are batched (up to extractionJudgeBatchSize),
 * checked against an in-memory content-hash cache, and sent to the LLM
 * for verdict.
 */
export async function judgeFactDurability(
  candidates: JudgeCandidate[],
  config: PluginConfig,
  localLlm: LocalLlmClient | null,
  fallbackLlm: FallbackLlmClient | null,
  cache?: Map<string, JudgeVerdict>,
  deferCounts?: Map<string, number>,
  onVerdict?: (observation: JudgeVerdictObservation) => void,
): Promise<JudgeBatchResult> {
  const startMs = Date.now();
  const verdicts = new Map<number, JudgeVerdict>();
  let cached = 0;
  let judged = 0;
  let deferred = 0;
  let deferredCappedToReject = 0;

  // Use caller-provided cache for per-orchestrator scoping, or fall back
  // to the module-level default cache.
  const verdictCache = cache ?? defaultVerdictCache;
  const deferCountMap = deferCounts ?? defaultDeferCounts;
  const deferCap = resolveDeferCap(config);

  // Lazy emit (Codex P2): when `onVerdict` is undefined (default path —
  // telemetry off), payload construction is skipped entirely. Callers
  // pass a factory instead of a pre-built observation so the `sha256`
  // `contentHash` and surrounding object allocation only run when a
  // subscriber is present. For large batches with telemetry off this
  // removes per-verdict overhead that would otherwise fire on every
  // auto-approved / cache / fail-open path.
  const emit = (build: () => JudgeVerdictObservation): void => {
    if (!onVerdict) return;
    let observation: JudgeVerdictObservation;
    try {
      observation = build();
    } catch (err) {
      log.debug(
        `extraction-judge: onVerdict builder threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    try {
      onVerdict(observation);
    } catch (err) {
      // Fail-open: telemetry errors must never block extraction.
      log.debug(
        `extraction-judge: onVerdict callback threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (candidates.length === 0) {
    return {
      verdicts,
      cached,
      judged,
      elapsed: 0,
      deferred,
      deferredCappedToReject,
    };
  }

  // Indices that need LLM judgment
  const pendingIndices: number[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];

    // Auto-approve safety categories
    if (AUTO_APPROVE_CATEGORIES.has(c.category)) {
      const v: JudgeVerdict = {
        durable: true,
        reason: `Auto-approved: ${c.category} category bypasses judge`,
      };
      verdicts.set(i, v);
      emit(() => ({
        verdict: v,
        candidate: c,
        contentHash: cacheKey(c.text, c.category),
        source: "auto-approve",
        priorDeferrals: 0,
        elapsedMs: Date.now() - startMs,
      }));
      continue;
    }

    // Auto-approve critical importance
    if (c.importanceLevel === "critical") {
      const v: JudgeVerdict = {
        durable: true,
        reason: "Auto-approved: critical importance",
      };
      verdicts.set(i, v);
      emit(() => ({
        verdict: v,
        candidate: c,
        contentHash: cacheKey(c.text, c.category),
        source: "auto-approve",
        priorDeferrals: 0,
        elapsedMs: Date.now() - startMs,
      }));
      continue;
    }

    // Check cache
    const key = cacheKey(c.text, c.category);
    const cachedVerdict = verdictCache.get(key);
    if (cachedVerdict) {
      verdicts.set(i, cachedVerdict);
      cached++;
      emit(() => ({
        verdict: cachedVerdict,
        candidate: c,
        contentHash: key,
        source: "cache",
        priorDeferrals: deferCountMap.get(key) ?? 0,
        elapsedMs: Date.now() - startMs,
      }));
      continue;
    }

    pendingIndices.push(i);
  }

  // If all resolved without LLM, return early
  if (pendingIndices.length === 0) {
    return {
      verdicts,
      cached,
      judged,
      elapsed: Date.now() - startMs,
      deferred,
      deferredCappedToReject,
    };
  }

  // Batch the pending candidates up to batchSize
  const batchSize = config.extractionJudgeBatchSize;
  for (let batchStart = 0; batchStart < pendingIndices.length; batchStart += batchSize) {
    const batchIndices = pendingIndices.slice(batchStart, batchStart + batchSize);
    const batchPayload = batchIndices.map((idx) => ({
      index: idx,
      text: candidates[idx].text,
      category: candidates[idx].category,
      confidence: candidates[idx].confidence,
    }));

    const userPrompt = JSON.stringify(batchPayload);

    try {
      const llmResponse = await callJudgeLlm(
        userPrompt,
        config,
        localLlm,
        fallbackLlm,
      );

      if (llmResponse) {
        const parsed = parseJudgeResponse(llmResponse, batchIndices);
        // Per-batch defer-increment dedupe (codex P2): a single extraction
        // pass must not advance the cap more than once for identical
        // candidate content, even if the same text appears multiple times
        // in the same LLM response. Duplicate hits share the first
        // increment's `priorDeferrals` snapshot.
        const deferredThisBatch = new Set<string>();
        for (const [idx, rawVerdict] of parsed.entries()) {
          const c = candidates[idx];
          const key = cacheKey(c.text, c.category);
          let verdict = rawVerdict;
          let source: JudgeVerdictObservation["source"] = "llm";
          const priorDefers = deferCountMap.get(key) ?? 0;

          // Defer cap (issue #562, PR 2). A candidate that has already been
          // deferred `deferCap` times is forcibly rejected so a pathological
          // LLM response cannot produce an infinite defer loop.
          if (getVerdictKind(verdict) === "defer") {
            if (priorDefers >= deferCap) {
              verdict = {
                durable: false,
                reason: `Defer cap reached (${deferCap} prior defers); rejecting`,
                kind: "reject",
              };
              source = "llm-cap-rejected";
              // Only clear + count the cap conversion once per batch for
              // this key — duplicates in the same response all resolve to
              // reject but should not inflate the cap-rejection counter.
              if (!deferredThisBatch.has(key)) {
                deferCountMap.delete(key);
                deferredCappedToReject++;
                deferredThisBatch.add(key);
              }
            } else if (!deferredThisBatch.has(key)) {
              deferCountMap.set(key, priorDefers + 1);
              deferred++;
              deferredThisBatch.add(key);
              // Bound the per-process defer-counter map.
              if (deferCountMap.size > DEFER_COUNT_MAX_SIZE) {
                const drop = Math.floor(deferCountMap.size / 2);
                let dropped = 0;
                for (const k of deferCountMap.keys()) {
                  if (dropped >= drop) break;
                  deferCountMap.delete(k);
                  dropped++;
                }
              }
            }
            // else: duplicate defer for a key already counted this batch —
            // no additional counter increment, verdict still marked defer.
          } else {
            // On accept/reject, clear any outstanding defer counter so a
            // future reappearance of the same text starts fresh.
            deferCountMap.delete(key);
          }

          verdicts.set(idx, verdict);
          judged++;
          // Cache non-defer verdicts. Defer is intentionally NOT cached:
          // caching it would short-circuit the re-evaluation pass that is
          // the entire point of the defer verdict.
          if (getVerdictKind(verdict) !== "defer") {
            verdictCache.set(key, verdict);
          }
          emit(() => ({
            verdict,
            candidate: c,
            contentHash: key,
            source,
            priorDeferrals: priorDefers,
            elapsedMs: Date.now() - startMs,
          }));
        }
        // Evict oldest entries if cache exceeds max size
        enforceMaxCacheSize(verdictCache);
      }
    } catch (err) {
      // Fail-open: if the LLM call fails, approve all candidates in this batch
      log.warn(
        `extraction-judge: LLM call failed, approving batch (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fill in any missing verdicts from this batch (fail-open: approve).
    // Clear defer counts so a transient outage doesn't leave stale state
    // that causes later defers to hit the cap early.
    for (const idx of batchIndices) {
      if (!verdicts.has(idx)) {
        const c = candidates[idx];
        const hash = cacheKey(c.text, c.category);
        // Capture the prior deferral count BEFORE clearing so the
        // telemetry event reflects the true state rather than always 0.
        const priorDefers = deferCountMap.get(hash) ?? 0;
        deferCountMap.delete(hash);
        const v: JudgeVerdict = {
          durable: true,
          reason: "Approved by default (judge unavailable or parse error)",
        };
        verdicts.set(idx, v);
        emit(() => {
          return {
            verdict: v,
            candidate: c,
            contentHash: hash,
            source: "fail-open",
            priorDeferrals: priorDefers,
            elapsedMs: Date.now() - startMs,
          };
        });
      }
    }
  }

  return {
    verdicts,
    cached,
    judged,
    elapsed: Date.now() - startMs,
    deferred,
    deferredCappedToReject,
  };
}

// ---------------------------------------------------------------------------
// LLM call helpers
// ---------------------------------------------------------------------------

async function callJudgeLlm(
  userPrompt: string,
  config: PluginConfig,
  localLlm: LocalLlmClient | null,
  fallbackLlm: FallbackLlmClient | null,
): Promise<string | null> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const modelOverride = config.extractionJudgeModel || undefined;

  // When modelSource is "gateway", skip localLlm and go directly to fallback
  // (the gateway-routed backend). This respects the operator's explicit
  // routing preference.
  const skipLocal = config.modelSource === "gateway";

  // Route judge-gated extractions through the SAME shared resolution as every
  // other background task (taskModelChain > gatewayAgentId in gateway mode), so
  // the judge never silently falls back to the persona/default chain when a
  // task chain is configured (gotcha #22, #39). Issue #1365 / PR #1425.
  const gatewayChain = gatewayTaskChainOptions(config);

  // Try local LLM first (unless modelSource says gateway)
  if (localLlm && !skipLocal) {
    try {
      const result = await (localLlm as any).chatCompletion(messages, {
        temperature: 0.1,
        maxTokens: 2048,
        responseFormat: { type: "json_object" },
        timeoutMs: 1500,
        operation: "extraction-judge",
        ...(modelOverride ? { model: modelOverride } : {}),
      });
      if (result?.content) {
        return result.content;
      }
    } catch (err) {
      log.debug(
        `extraction-judge: local LLM failed, trying fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Try fallback LLM
  if (fallbackLlm) {
    try {
      const result = await fallbackLlm.chatCompletion(
        messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
        {
          temperature: 0.1,
          maxTokens: 2048,
          timeoutMs: 1500,
          ...(modelOverride ? { model: modelOverride } : {}),
          ...gatewayChain,
        },
      );
      if (result?.content) {
        return result.content;
      }
    } catch (err) {
      log.debug(
        `extraction-judge: fallback LLM failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseJudgeResponse(
  raw: string,
  expectedIndices: number[],
): Map<number, JudgeVerdict> {
  const result = new Map<number, JudgeVerdict>();
  const expectedSet = new Set(expectedIndices);

  try {
    // Try direct parse first, then fall back to JSON extraction
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const candidates = extractJsonCandidates(raw);
      if (candidates.length > 0) {
        parsed = JSON.parse(candidates[0]);
      }
    }

    if (!Array.isArray(parsed)) {
      // Might be wrapped in an object with a key
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const values = Object.values(parsed as Record<string, unknown>);
        for (const v of values) {
          if (Array.isArray(v)) {
            parsed = v;
            break;
          }
        }
      }
      if (!Array.isArray(parsed)) {
        log.debug("extraction-judge: response is not an array, cannot parse");
        return result;
      }
    }

    for (const item of parsed) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as any).index !== "number"
      ) {
        continue;
      }
      const idx = (item as any).index as number;
      if (!expectedSet.has(idx)) continue;

      // Parse kind first — it's the primary signal in PR 2 and above.
      // Fall back to durable for pre-PR-2 model responses that only return
      // the boolean.
      let kind: JudgeVerdictKind | undefined;
      const rawKind = (item as any).kind;
      const rawAction = (item as any).action;
      if (rawKind === "accept" || rawKind === "reject" || rawKind === "defer") {
        kind = rawKind;
      } else if (
        rawAction === "accept" ||
        rawAction === "reject" ||
        rawAction === "defer"
      ) {
        // Tolerate `action` as an alias — MemReader uses that word in the
        // paper and models may echo it.
        kind = rawAction;
      }

      const hasDurable = typeof (item as any).durable === "boolean";
      const durableFromModel = hasDurable
        ? ((item as any).durable as boolean)
        : undefined;

      // Resolve the durable flag from kind when present; otherwise trust
      // the model's boolean; otherwise fail-open to durable=true.
      let durable: boolean;
      if (kind === "accept") {
        durable = true;
      } else if (kind === "reject" || kind === "defer") {
        durable = false;
      } else if (durableFromModel !== undefined) {
        durable = durableFromModel;
      } else {
        durable = true; // fail-open
      }

      const reason =
        typeof (item as any).reason === "string"
          ? ((item as any).reason as string).slice(0, 120)
          : "No reason provided";

      const verdict: JudgeVerdict = { durable, reason };
      if (kind !== undefined) verdict.kind = kind;
      result.set(idx, verdict);
    }
  } catch (err) {
    log.debug(
      `extraction-judge: failed to parse response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cache management (exposed for testing)
// ---------------------------------------------------------------------------

/** Clear the in-memory default verdict cache. Primarily for tests. */
export function clearVerdictCache(): void {
  defaultVerdictCache.clear();
  defaultDeferCounts.clear();
}

/** Return the current default verdict cache size. Primarily for tests. */
export function verdictCacheSize(): number {
  return defaultVerdictCache.size;
}

/** Create a new per-instance verdict cache. Orchestrators should hold one. */
export function createVerdictCache(): Map<string, JudgeVerdict> {
  return new Map();
}

/**
 * Create a new per-instance defer-counter map. Orchestrators should hold one
 * alongside their verdict cache so defer counts survive across extraction
 * passes within a single orchestrator but do not leak across orchestrators.
 */
export function createDeferCountMap(): Map<string, number> {
  return new Map();
}
