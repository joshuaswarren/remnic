/**
 * Contradiction Judge — LLM-as-judge for semantic contradiction detection (issue #520).
 *
 * Pairs semantically-similar memories and classifies their relationship.
 * Reuses the extraction-judge adapter pattern but with a contradiction-specific
 * prompt and verdict taxonomy.
 *
 * Design constraints:
 *   - Default verdict on any failure is "needs-user" (rule 48: least-privileged default).
 *   - Never auto-resolve; all verdicts enter the review queue.
 *   - Content-hash caching avoids redundant LLM calls across runs.
 */

import { createHash } from "node:crypto";
import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { FallbackLlmClient } from "../fallback-llm.js";
import { extractJsonCandidates } from "../json-extract.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ContradictionVerdict =
  | "contradicts"
  | "independent"
  | "duplicates"
  | "needs-user";

export interface ContradictionJudgeInput {
  /** Memory ID of the first fact. */
  memoryIdA: string;
  /** Memory ID of the second fact. */
  memoryIdB: string;
  /** Content text of the first fact. */
  textA: string;
  /** Content text of the second fact. */
  textB: string;
  /** Category of the first fact (optional context). */
  categoryA?: string;
  /** Category of the second fact (optional context). */
  categoryB?: string;
}

export interface ContradictionJudgeResult {
  /** Memory IDs of the pair. */
  memoryIdA: string;
  memoryIdB: string;
  /** Verdict from the judge. */
  verdict: ContradictionVerdict;
  /** Human-readable rationale. */
  rationale: string;
  /** Confidence in [0, 1]. */
  confidence: number;
}

export interface ContradictionJudgeBatchResult {
  /** Results keyed by pair key ("idA:idB"). */
  results: Map<string, ContradictionJudgeResult>;
  /** Number served from cache. */
  cached: number;
  /** Number produced by LLM call. */
  judged: number;
  /** Total wall-clock time in ms. */
  elapsed: number;
}

// ── Prompt ─────────────────────────────────────────────────────────────────────

const CONTRADICTION_JUDGE_PROMPT = `You are a memory contradiction classifier. You will receive pairs of stored memories and must classify their semantic relationship.

For each pair, respond with a JSON array where each element has:
- "pairKey": the pairKey provided in the input
- "verdict": one of "contradicts", "independent", "duplicates", "needs-user"
- "rationale": one sentence explaining why
- "confidence": number between 0 and 1

VERDICT DEFINITIONS:
- "contradicts": The two memories make claims that cannot both be true. One must be wrong or outdated.
- "duplicates": The two memories convey essentially the same information (near-paraphrase).
- "independent": The memories are topically similar but do not conflict or duplicate.
- "needs-user": Cannot determine with sufficient confidence; requires human review.

IMPORTANT:
- Be conservative. When in doubt, prefer "needs-user" over a wrong classification.
- Two memories about the same entity/topic are NOT necessarily contradictory.
- Temporal changes ("Joshua uses pnpm" vs "Joshua switched to npm") ARE contradictions.
- Different aspects of the same entity ("Joshua uses pnpm" vs "Joshua works on Remnic") are "independent".`;

// ── Cache ──────────────────────────────────────────────────────────────────────

/** Module-level fallback cache — only used when caller does not supply one. */
let defaultVerdictCache: Map<string, ContradictionJudgeResult> = new Map();
const CACHE_MAX = 10_000;

function pairKey(idA: string, idB: string): string {
  const sorted = [idA, idB].sort();
  return `${sorted[0]}:${sorted[1]}`;
}

function contentHash(a: ContradictionJudgeInput): string {
  // Sort each side pair to be order-independent (matching pairKey behavior)
  const sides = [
    { text: a.textA.trim(), category: (a.categoryA ?? "").trim() },
    { text: a.textB.trim(), category: (a.categoryB ?? "").trim() },
  ].sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey.localeCompare(rightKey);
  });
  const normalized = JSON.stringify(sides);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function createVerdictCache(): Map<string, ContradictionJudgeResult> {
  return new Map();
}

export function clearVerdictCache(): void {
  defaultVerdictCache.clear();
}

export function verdictCacheSize(): number {
  return defaultVerdictCache.size;
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Judge a batch of memory pairs for contradiction.
 *
 * Uses content-hash caching to skip pairs already judged in a prior run.
 * On any LLM failure, all unresolved pairs default to "needs-user".
 */
export async function judgeContradictionPairs(
  pairs: ContradictionJudgeInput[],
  config: PluginConfig,
  localLlm: LocalLlmClient | null,
  fallbackLlm: FallbackLlmClient | null,
  cache?: Map<string, ContradictionJudgeResult>,
): Promise<ContradictionJudgeBatchResult> {
  const startTime = Date.now();
  const results = new Map<string, ContradictionJudgeResult>();
  const activeCache = cache ?? defaultVerdictCache;
  let cached = 0;
  let judged = 0;

  // Partition into cached vs needs-judging
  const toJudge: ContradictionJudgeInput[] = [];
  for (const pair of pairs) {
    const key = pairKey(pair.memoryIdA, pair.memoryIdB);
    const hash = contentHash(pair);
    const cachedResult = activeCache.get(hash);
    if (cachedResult) {
      results.set(key, { ...cachedResult, memoryIdA: pair.memoryIdA, memoryIdB: pair.memoryIdB });
      cached++;
    } else {
      toJudge.push(pair);
    }
  }

  if (toJudge.length === 0) {
    return { results, cached, judged, elapsed: Date.now() - startTime };
  }

  // Build the prompt with all pairs
  const pairDescriptions = toJudge.map((p, i) => {
    const pk = pairKey(p.memoryIdA, p.memoryIdB);
    const catA = p.categoryA ? ` [${p.categoryA}]` : "";
    const catB = p.categoryB ? ` [${p.categoryB}]` : "";
    return `Pair ${i + 1} (pairKey: "${pk}"):${catA} "${p.textA}"${catB} "${p.textB}"`;
  });

  const userMessage = `Classify these ${toJudge.length} memory pair(s):\n\n${pairDescriptions.join("\n\n")}`;

  // Try LLM call
  let llmResponse: string | null = null;

  if (localLlm) {
    try {
      llmResponse = await callLlm(localLlm, config, userMessage);
    } catch (err) {
      log.warn("[contradiction-judge] local LLM call failed: %s", err instanceof Error ? err.message : err);
    }
  }

  if (!llmResponse && fallbackLlm) {
    try {
      llmResponse = await callLlm(fallbackLlm, config, userMessage);
    } catch (err) {
      log.warn("[contradiction-judge] fallback LLM call failed: %s", err instanceof Error ? err.message : err);
    }
  }

  // Parse response or default to needs-user
  if (llmResponse) {
    const candidates = extractJsonCandidates(llmResponse);
    const parsed = parseJudgeResponse(candidates, toJudge);

    for (const result of parsed) {
      const key = pairKey(result.memoryIdA, result.memoryIdB);
      results.set(key, result);

      // Update cache
      const input = toJudge.find(
        (p) => pairKey(p.memoryIdA, p.memoryIdB) === key,
      );
      if (input) {
        const hash = contentHash(input);
        if (activeCache.size >= CACHE_MAX) {
          const firstKey = activeCache.keys().next().value;
          if (firstKey !== undefined) activeCache.delete(firstKey);
        }
        activeCache.set(hash, result);
      }
      judged++;
    }
  } else {
    // All unresolved → needs-user (rule 48)
    for (const pair of toJudge) {
      const key = pairKey(pair.memoryIdA, pair.memoryIdB);
      const result: ContradictionJudgeResult = {
        memoryIdA: pair.memoryIdA,
        memoryIdB: pair.memoryIdB,
        verdict: "needs-user",
        rationale: "LLM call failed; requires manual review",
        confidence: 0,
      };
      results.set(key, result);
      judged++;
    }
  }

  return { results, cached, judged, elapsed: Date.now() - startTime };
}

// ── Internals ──────────────────────────────────────────────────────────────────

async function callLlm(
  client: LocalLlmClient | FallbackLlmClient,
  config: PluginConfig,
  userMessage: string,
): Promise<string> {
  const messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
    { role: "system", content: CONTRADICTION_JUDGE_PROMPT },
    { role: "user", content: userMessage },
  ];
  if ("chatCompletion" in client && typeof client.chatCompletion === "function") {
    const result = await client.chatCompletion(messages, {
      temperature: 0.1,
      maxTokens: 4096,
      operation: "contradiction-judge",
    });
    return result?.content ?? "";
  }
  // FallbackLlmClient — try OpenAI-compatible chat completions
  if ("complete" in client && typeof (client as Record<string, unknown>).complete === "function") {
    const result = await (client as { complete: (msg: Array<{ role: string; content: string }>) => Promise<{ content: string }> }).complete(messages);
    return result.content ?? "";
  }
  return "";
}

function parseJudgeResponse(
  candidates: string[],
  inputs: ContradictionJudgeInput[],
): ContradictionJudgeResult[] {
  const VALID_VERDICTS: ContradictionVerdict[] = ["contradicts", "independent", "duplicates", "needs-user"];
  let conservativeFallback: ContradictionJudgeResult[] | null = null;

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const results: ContradictionJudgeResult[] = [];
      const matchedKeys = new Set<string>();

      for (const item of items) {
        if (!item || typeof item !== "object") continue;

        const verdict = typeof item.verdict === "string" && VALID_VERDICTS.includes(item.verdict as ContradictionVerdict)
          ? (item.verdict as ContradictionVerdict)
          : "needs-user";

        const pairKeyVal = typeof item.pairKey === "string" && item.pairKey.length > 0
          ? item.pairKey
          : null;
        const input = pairKeyVal
          ? inputs.find((p) => pairKey(p.memoryIdA, p.memoryIdB) === pairKeyVal)
          : null;

        if (!input) continue;

        matchedKeys.add(pairKey(input.memoryIdA, input.memoryIdB));

        const confidence = typeof item.confidence === "number"
          ? Math.min(1, Math.max(0, item.confidence))
          : 0.5;

        results.push({
          memoryIdA: input.memoryIdA,
          memoryIdB: input.memoryIdB,
          verdict,
          rationale: typeof item.rationale === "string" ? item.rationale : "No rationale provided",
          confidence,
        });
      }

      // Backfill any inputs the LLM omitted with needs-user
      for (const inp of inputs) {
        const key = pairKey(inp.memoryIdA, inp.memoryIdB);
        if (!matchedKeys.has(key)) {
          results.push({
            memoryIdA: inp.memoryIdA,
            memoryIdB: inp.memoryIdB,
            verdict: "needs-user",
            rationale: "LLM response omitted this pair",
            confidence: 0,
          });
        }
      }

      if (matchedKeys.size > 0) return results;
      if (results.length > 0 && conservativeFallback === null) {
        conservativeFallback = results;
      }
    } catch {
      continue;
    }
  }

  if (conservativeFallback !== null) return conservativeFallback;

  // All parse attempts failed → needs-user for every input
  return inputs.map((p) => ({
    memoryIdA: p.memoryIdA,
    memoryIdB: p.memoryIdB,
    verdict: "needs-user" as ContradictionVerdict,
    rationale: "Failed to parse judge response",
    confidence: 0,
  }));
}

export { pairKey as _pairKey, contentHash as _contentHash };
