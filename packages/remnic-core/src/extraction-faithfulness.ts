/**
 * Extraction faithfulness gate — entailment verification of extracted
 * facts against their verified source spans (issue #1576).
 *
 * Part of #1572 (glass-box memory). Depends on #1575 (provenance spans).
 * Improved later by #1585 (fine-tuned local gate model).
 *
 * Unlike the extraction-judge (#376), which gates on fact-worthiness
 * ("is this worth remembering?"), this module gates on faithfulness
 * ("is this fact actually supported by what was said?"). Hallucinated
 * or mis-paraphrased extractions become durable memories, get recalled
 * with confidence, and poison downstream answers — the highest-severity
 * accuracy failure a memory system can have.
 *
 * Design constraints:
 *   - Tagged results only — a backend failure is distinguishable from a
 *     genuine verdict (rule 34 / checklist §22: never conflate "empty"
 *     with "failed").
 *   - The gate consumes the QUOTE, not the whole conversation — passing
 *     full turns re-introduces the hallucination surface you're guarding
 *     and blows the latency budget.
 *   - No module-level state — batch queues hang off the orchestrator
 *     instance (rule 11).
 *   - Byte-identical pre-feature pipeline when mode is "off" (rule 39).
 *   - Graceful degradation — a backend failure never blocks writes
 *     (checklist §4); the fact proceeds with verdict "unchecked".
 *   - Never mutate mw_*\/trust fields — faithfulness is its own
 *     frontmatter island consumed by #1577.
 */

import { createHash } from "node:crypto";

import { log } from "./logger.js";
import type { PluginConfig, MemoryFrontmatter, FaithfulnessFrontmatter } from "./types.js";
import type { LocalLlmClient } from "./local-llm.js";
import { type FallbackLlmClient, gatewayTaskChainOptions } from "./fallback-llm.js";
import { extractJsonCandidates } from "./json-extract.js";

// Re-export for callers importing from this module.
export type { FaithfulnessFrontmatter } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The three entailment verdicts. "unchecked" is NOT a member of this union —
 * it lives only in the frontmatter to mark facts that bypassed the gate
 * (backend failure, no span, mode=off). A real verdict is always one of
 * these three.
 */
export type FaithfulnessVerdict = "entailed" | "contradicted" | "unsupported";

/**
 * Failure codes for tagged-error results. Each is distinguishable so callers
 * and telemetry can tell "no span available" from "the backend was down".
 */
export type FaithfulnessFailureCode =
  | "no_span"
  | "backend_unavailable"
  | "malformed_output"
  | "timeout";

/**
 * Tagged result — success carries the verdict + model + optional rationale;
 * failure carries only the error code. Never conflate the two (rule 34).
 */
export type FaithfulnessResult =
  | { ok: true; verdict: FaithfulnessVerdict; model: string; rationale?: string }
  | { ok: false; error: { code: FaithfulnessFailureCode } };

/**
 * Input for a single faithfulness check. The quote is the verified span from
 * #1575; context is optional surrounding turn text (bounded by
 * faithfulnessContextChars).
 */
export interface FaithfulnessCheckInput {
  factText: string;
  quote: string;
  context?: string;
}

/**
 * Shape persisted to frontmatter (issue #1576). Serialized as a single JSON
 * line so it round-trips through the existing YAML parser without special
 * handling.
 *
 * `verdict: "unchecked"` marks a fact that entered the gate but could not be
 * evaluated (backend failure, timeout). It is distinct from the field being
 * absent (which means the gate was off entirely or the fact predates #1576).
 */

// ---------------------------------------------------------------------------
// Sealed prompt (hash lets #1573-style caching key on it)
// ---------------------------------------------------------------------------

const FAITHFULNESS_SYSTEM_PROMPT = `You are a faithfulness verifier for a memory system. Given a QUOTE from the source conversation and an extracted FACT, determine whether the FACT is supported by the QUOTE.

Rules:
- "entailed" — the FACT directly follows from the QUOTE (paraphrase is OK).
- "contradicted" — the FACT asserts something the QUOTE directly negates.
- "unsupported" — the FACT introduces information not present in the QUOTE.

Answer with a JSON array. Each element: {"index": <int>, "verdict": "entailed"|"contradicted"|"unsupported", "rationale": "<one sentence>"}.

Examples:
QUOTE: "I've been using Vim for about ten years now."
FACT: "The user has used Vim for approximately a decade."
{"index": 0, "verdict": "entailed", "rationale": "Paraphrase of the same duration."}

QUOTE: "I've been using Vim for about ten years now."
FACT: "The user prefers Emacs."
{"index": 0, "verdict": "unsupported", "rationale": "QUOTE mentions Vim, not Emacs."}

QUOTE: "I stopped drinking coffee last month."
FACT: "The user drinks coffee regularly."
{"index": 0, "verdict": "contradicted", "rationale": "QUOTE says they stopped; FACT claims the opposite."}`;

/**
 * SHA-256 hash of the sealed system prompt. Cache keys and prompt-version
 * telemetry include this so a prompt change is detectable (#1573-style
 * caching can invalidate stale entries).
 */
export const FAITHFULNESS_PROMPT_HASH = createHash("sha256")
  .update(FAITHFULNESS_SYSTEM_PROMPT)
  .digest("hex");

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the user-prompt payload for a batch of (fact, quote) pairs.
 * Each pair is numbered so the LLM's response can be correlated back.
 *
 * Context (when provided) is included after the quote, clearly delimited,
 * so the model knows it is supplementary — not the primary evidence.
 */
function buildBatchPrompt(inputs: FaithfulnessCheckInput[], contextChars: number): string {
  const parts: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    if (!inp) continue;
    // The QUOTE is the primary entailment evidence and is already bounded
    // upstream (provenance.maxQuoteChars / locateFactQuote). Send it whole
    // so the verifier never judges entailment on a truncated span. Only the
    // supplementary CONTEXT is bounded by contextChars (the config's "window
    // around the quote" semantics — cursor review).
    parts.push(`--- Item ${i} ---
QUOTE: "${inp.quote}"`);
    if (inp.context && inp.context.trim().length > 0) {
      parts.push(`CONTEXT: "${inp.context.slice(0, contextChars)}"`);
    }
    parts.push(`FACT: "${inp.factText}"

Respond with the JSON array entry for index ${i}.`);
  }
  parts.push(`\nRespond now with a single JSON array covering indexes 0–${inputs.length - 1}.`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const VALID_VERDICTS = new Set<string>(["entailed", "contradicted", "unsupported"]);

/**
 * Parsed LLM response entry — validated shape.
 */
interface ParsedFaithfulnessEntry {
  index: number;
  verdict: FaithfulnessVerdict;
  rationale?: string;
}

/**
 * Parse the LLM response into a map of index → entry. Returns null when the
 * response is unparseable (rules 13/18: malformed output → tagged error,
 * never a crash).
 *
 * Accepts both a bare JSON array and a JSON array embedded in surrounding
 * text (the `extractJsonCandidates` helper handles fenced blocks and
 * code-block-wrapped JSON).
 */
export function parseFaithfulnessResponse(
  raw: string,
  expectedCount: number,
): Map<number, ParsedFaithfulnessEntry> | null {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  const candidates = extractJsonCandidates(raw);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const map = parseEntries(parsed, expectedCount);
    if (map) return map;
  }

  // Last resort: the model may have returned bare objects without array
  // wrapping — try parsing the whole thing as a single entry.
  try {
    const single = JSON.parse(raw.trim());
    const map = parseEntries([single], expectedCount);
    if (map) return map;
  } catch {
    // fall through
  }

  return null;
}

function parseEntries(
  data: unknown,
  expectedCount: number,
): Map<number, ParsedFaithfulnessEntry> | null {
  if (!Array.isArray(data)) return null;
  const map = new Map<number, ParsedFaithfulnessEntry>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const idx = typeof obj.index === "number" ? obj.index : undefined;
    if (idx === undefined || idx < 0 || idx >= expectedCount) continue;
    const verdictRaw = typeof obj.verdict === "string" ? obj.verdict : undefined;
    if (!verdictRaw || !VALID_VERDICTS.has(verdictRaw)) continue;
    const rationale =
      typeof obj.rationale === "string" && obj.rationale.trim().length > 0
        ? obj.rationale.trim().slice(0, 500)
        : undefined;
    map.set(idx, {
      index: idx,
      verdict: verdictRaw as FaithfulnessVerdict,
      rationale,
    });
  }
  return map.size > 0 ? map : null;
}

// ---------------------------------------------------------------------------
// LLM call helper
// ---------------------------------------------------------------------------

interface LlmCallResult {
  content: string | null;
  modelUsed: string | null;
}

/**
 * Call the model routing chain (local → fallback) with the faithfulness
 * classification prompt. Mirrors `callJudgeLlm` in extraction-judge.ts so
 * the same routing, model-override, and gateway-chain logic applies.
 *
 * Returns the raw content string and the model that produced it, or
 * `{ content: null, modelUsed: null }` when every backend is unavailable.
 */
async function callFaithfulnessLlm(
  systemPrompt: string,
  userPrompt: string,
  config: PluginConfig,
  localLlm: LocalLlmClient | null,
  fallbackLlm: FallbackLlmClient | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const modelOverride = config.extractionFaithfulnessModel || undefined;

  // Skip the local backend when (a) modelSource is "gateway", or (b) a
  // faithfulness model override is set. The local client always sends
  // config.localLlmModel and silently ignores options.model, so a local
  // success would run the wrong model and prevent the override from ever
  // reaching the gateway. Routing straight to the gateway honors the
  // override (codex review PRRT_kwDORJXyws6ObYQ8).
  const skipLocal = config.modelSource === "gateway" || Boolean(modelOverride);
  const gatewayChain = gatewayTaskChainOptions(config);

  let modelUsed: string | null = null;

  // Try local LLM first (only when no override routes the call to gateway).
  // The local client uses its OWN per-attempt AbortController keyed on
  // `timeoutMs` (it does not read options.signal — see LocalLlmChatCompletionOptions),
  // so the batch `signal` is not forwarded here; `timeoutMs` bounds each local
  // attempt instead. The batch AbortController still governs the fallback path,
  // which DOES honor the signal. (Matches extraction-judge.ts, which also passes
  // no signal to the local client.)
  if (localLlm && !skipLocal) {
    try {
      const result = await callLocalLlm(localLlm, messages, {
        temperature: 0.1,
        maxTokens: 2048,
        responseFormat: { type: "json_object" },
        timeoutMs,
        operation: "extraction-faithfulness",
      });
      if (result.content) {
        return { content: result.content, modelUsed: result.modelUsed ?? "local" };
      }
    } catch (err) {
      log.debug(
        `extraction-faithfulness: local LLM failed, trying fallback: ${err instanceof Error ? err.message : String(err)}`,
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
          timeoutMs,
          ...(modelOverride ? { model: modelOverride } : {}),
          ...gatewayChain,
          ...(signal ? { signal } : {}),
        },
      );
      if (result?.content) {
        return { content: result.content, modelUsed: result.modelUsed ?? "fallback" };
      }
    } catch (err) {
      log.debug(
        `extraction-faithfulness: fallback LLM failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { content: null, modelUsed: null };
}

/**
 * Call the local LLM's chatCompletion through a narrow, typed interface.
 * LocalLlmClient.chatCompletion accepts an options bag that includes an
 * `operation` discriminator; we forward it so the client can route
 * appropriately.
 */
interface LocalLlmCallOptions {
  temperature: number;
  maxTokens: number;
  responseFormat?: { type: string };
  timeoutMs: number;
  operation: string;
}

interface LocalLlmCallResponse {
  content: string | null;
  modelUsed?: string;
}

async function callLocalLlm(
  client: LocalLlmClient,
  messages: Array<{ role: "system" | "user"; content: string }>,
  options: LocalLlmCallOptions,
): Promise<LocalLlmCallResponse> {
  // LocalLlmClient.chatCompletion returns { content: string } — we use a
  // typed call signature so no `any` leaks. The local client does not
  // expose modelUsed, so we return "local" as the model identifier.
  const result = await client.chatCompletion(messages, options);
  return {
    content: result?.content ?? null,
  };
}

// ---------------------------------------------------------------------------
// Core batch check
// ---------------------------------------------------------------------------

/**
 * Result of a batch faithfulness check — per-input results plus timing.
 */
export interface FaithfulnessBatchResult {
  results: FaithfulnessResult[];
  /** Wall-clock duration of the LLM call (0 when backend was not called). */
  elapsedMs: number;
}

/**
 * Evaluate a batch of (fact, quote) pairs for faithfulness.
 *
 * - Calls the LLM once with all pairs (bounded by `inputs.length`).
 * - On timeout → every input gets `{ ok: false, code: "timeout" }`.
 * - On backend unavailable → `{ ok: false, code: "backend_unavailable" }`.
 * - On malformed output → `{ ok: false, code: "malformed_output" }`.
 * - Inputs with empty quotes get `{ ok: false, code: "no_span" }` and are
 *   NOT sent to the LLM.
 *
 * No module-level state: the caller (orchestrator) owns any caches.
 */
export async function checkFaithfulnessBatch(
  inputs: FaithfulnessCheckInput[],
  config: PluginConfig,
  localLlm: LocalLlmClient | null,
  fallbackLlm: FallbackLlmClient | null,
): Promise<FaithfulnessBatchResult> {
  const timeoutMs =
    typeof config.extractionFaithfulnessTimeoutMs === "number" &&
    Number.isFinite(config.extractionFaithfulnessTimeoutMs) &&
    config.extractionFaithfulnessTimeoutMs > 0
      ? config.extractionFaithfulnessTimeoutMs
      : 8000;

  const contextChars =
    typeof config.extractionFaithfulnessContextChars === "number" &&
    Number.isFinite(config.extractionFaithfulnessContextChars) &&
    config.extractionFaithfulnessContextChars > 0
      ? config.extractionFaithfulnessContextChars
      : 400;

  // Partition: inputs with a real quote vs. inputs without one.
  const results: FaithfulnessResult[] = new Array(inputs.length);
  const checkableIndices: number[] = [];
  const checkableInputs: FaithfulnessCheckInput[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    if (!inp || !inp.quote || inp.quote.trim().length === 0) {
      results[i] = { ok: false, error: { code: "no_span" } };
    } else if (!inp.factText || inp.factText.trim().length === 0) {
      results[i] = { ok: false, error: { code: "no_span" } };
    } else {
      checkableIndices.push(i);
      checkableInputs.push(inp);
    }
  }

  if (checkableInputs.length === 0) {
    return { results, elapsedMs: 0 };
  }

  const userPrompt = buildBatchPrompt(checkableInputs, contextChars);
  const startedAt = Date.now();

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const llmResult = await callFaithfulnessLlm(
      FAITHFULNESS_SYSTEM_PROMPT,
      userPrompt,
      config,
      localLlm,
      fallbackLlm,
      timeoutMs,
      controller.signal,
    );
    const elapsedMs = Date.now() - startedAt;

    // Cursor review: if the LLM returned usable content, use it even when
    // the abort timer raced — a response that lands just as the timer fires
    // has real verdicts. Only fall back to timeout errors when there is no
    // content to parse (the call genuinely did not complete in time).
    if (timedOut && !llmResult.content) {
      for (const idx of checkableIndices) {
        results[idx] = { ok: false, error: { code: "timeout" } };
      }
      return { results, elapsedMs };
    }

    if (!llmResult.content) {
      for (const idx of checkableIndices) {
        results[idx] = { ok: false, error: { code: "backend_unavailable" } };
      }
      return { results, elapsedMs };
    }

    const parsed = parseFaithfulnessResponse(llmResult.content, checkableInputs.length);
    if (!parsed) {
      for (const idx of checkableIndices) {
        results[idx] = { ok: false, error: { code: "malformed_output" } };
      }
      return { results, elapsedMs };
    }

    for (let j = 0; j < checkableIndices.length; j++) {
      const inputIdx = checkableIndices[j];
      if (inputIdx === undefined) continue;
      const entry = parsed.get(j);
      if (entry) {
        results[inputIdx] = {
          ok: true,
          verdict: entry.verdict,
          model: llmResult.modelUsed ?? "unknown",
          ...(entry.rationale ? { rationale: entry.rationale } : {}),
        };
      } else {
        // LLM response was missing this index
        results[inputIdx] = { ok: false, error: { code: "malformed_output" } };
      }
    }

    return { results, elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    if (timedOut || isAbortError(err)) {
      for (const idx of checkableIndices) {
        results[idx] = { ok: false, error: { code: "timeout" } };
      }
      return { results, elapsedMs };
    }
    log.warn(
      `extraction-faithfulness: batch check threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    );
    for (const idx of checkableIndices) {
      results[idx] = { ok: false, error: { code: "backend_unavailable" } };
    }
    return { results, elapsedMs };
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { name?: string; message?: string };
  return (
    maybe.name === "AbortError" ||
    maybe.message === "This operation was aborted" ||
    maybe.message === "The operation was aborted"
  );
}


// ---------------------------------------------------------------------------
// Extraction-path orchestration helpers (issue #1576)
//
// These wrap checkFaithfulnessBatch + verdict application so the orchestrator
// holds only thin delegation (ground rule 4: god files gain thin wiring only).
// The core algorithm lives above; these are call-site glue.
// ---------------------------------------------------------------------------

/**
 * Telemetry counters for the faithfulness gate. Hang off the orchestrator
 * instance (rule 11: no module-level state) and surface via console_state so
 * `remnic doctor` renders the verdict distribution.
 */
export interface FaithfulnessGateCounters {
  entailed: number;
  contradicted: number;
  unsupported: number;
  unchecked: number;
  skippedNoSpan: number;
}

/**
 * Create a fresh zeroed counters object. Callers store it on the orchestrator
 * instance and pass it by reference to the gate helpers, which mutate it.
 */
export function createFaithfulnessCounters(): FaithfulnessGateCounters {
  return { entailed: 0, contradicted: 0, unsupported: 0, unchecked: 0, skippedNoSpan: 0 };
}

/**
 * Structural slice of an extracted fact that the gate reads. Kept loose so
 * this pure module does not depend on the full `ExtractedFact` type.
 */
export interface FaithfulnessGateFact {
  content: string;
  sources?: { quote?: string }[];
}

/**
 * Run the faithfulness batch over a list of extracted facts and return a map
 * keyed by the ORIGINAL fact index → result. Facts without a usable verified
 * source span are omitted from the batch (they are tagged `skipped_no_span`
 * at apply time, never gated — don't punish legacy data). Updates `counters`
 * for console_state telemetry.
 *
 * Fail-open: any pipeline error is caught, logged, and an empty map returned
 * so the caller records `unchecked`/`skipped_no_span` and proceeds — a gate
 * outage must never block memory writes (checklist §4).
 */
// Common English stopwords — filtered before overlap scoring so function
// words (the, a, is, ...) don't dilute the signal between a fact and its
// source sentence.
const STOPWORDS = new Set([
  "the","a","an","and","or","but","is","are","was","were","be","been","being",
  "to","of","in","on","at","for","with","from","by","as","it","its","this","that",
  "these","those","i","you","he","she","we","they","my","your","his","her","our","their",
  "has","have","had","do","does","did","will","would","can","could","should","not","no",
  "s","very","really","just","so","than","then","there","here","about","into","over","under",
]);

/**
 * Crude stemmer: strip common suffixes so "prefers"/"prefer",
 * "using"/"use", "started"/"start" collapse to one token. Not a real
 * stemmer — just enough to raise recall for the interim locator (#1575 will
 * replace this with NLI-verified spans).
 */
function crudeStem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && (word.endsWith("s")) && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Tokenize text into a lowercase, stopword-filtered, crudely-stemmed token
 * set for overlap scoring.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length <= 1) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(crudeStem(raw));
  }
  return tokens;
}

/**
 * Overlap coefficient: |A ∩ B| / min(|A|, |B|). Robust for paraphrase
 * matching where a short fact paraphrases a longer source sentence — a short
 * fact fully supported by a long sentence scores high, unrelated text scores 0.
 */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) intersection++;
  return intersection / small.size;
}

/**
 * Minimum overlap for a located quote to be trusted as the fact's source span.
 * Below this the fact is treated as having no located span (skipped_no_span)
 * rather than judged against an unrelated sentence.
 */
const LOCATE_QUOTE_MIN_OVERLAP = 0.3;

/**
 * Locate the best-matching verbatim span (sentence) from the source turn text
 * for an extracted fact, by token overlap. Returns the quote when a confident
 * match is found, `undefined` otherwise (the gate then records
 * skipped_no_span — never judged against an unrelated span).
 *
 * This is the interim source-text locator that makes the gate functional on
 * real extraction output (where #1575 has not yet attached per-fact
 * `sources`). It produces a genuine located quote per fact so the gate
 * consumes a span, not the whole conversation (issue #1576 design constraint).
 * #1575's NLI-verified per-fact locator will replace this when it lands.
 */
export function locateFactQuote(
  factText: string,
  sourceText: string,
  maxQuoteChars = 600,
): string | undefined {
  if (!factText || !sourceText) return undefined;
  const factTokens = tokenize(factText);
  if (factTokens.size === 0) return undefined;
  // Split source into candidate spans: sentences, then line segments as a
  // fallback for transcripts without sentence punctuation.
  const candidates: string[] = [];
  for (const sentence of sourceText.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (s.length > 0) candidates.push(s);
  }
  if (candidates.length === 0) return undefined;
  let best: { quote: string; score: number } | null = null;
  for (const candidate of candidates) {
    const score = overlapCoefficient(factTokens, tokenize(candidate));
    if (!best || score > best.score) best = { quote: candidate, score };
  }
  if (!best || best.score < LOCATE_QUOTE_MIN_OVERLAP) return undefined;
  return best.quote.length > maxQuoteChars
    ? best.quote.slice(0, maxQuoteChars)
    : best.quote;
}
export async function runFaithfulnessGateBatch(
  facts: readonly FaithfulnessGateFact[],
  mode: "shadow" | "enforce",
  config: PluginConfig,
  localLlm: LocalLlmClient | null,
  fallbackLlm: FallbackLlmClient | null,
  counters: FaithfulnessGateCounters,
  /**
   * The verbatim source turn text the facts were extracted from. When a fact
   * has no #1575 `sources`, locateFactQuote finds a fallback span here so the
   * gate runs on real extraction output. May be empty (replay/import paths
   * with no source turns) — facts then get skipped_no_span.
   */
  sourceText = "",
): Promise<Map<number, FaithfulnessResult> | null> {
  // Phase 1 — build the checkable inputs. This is pure (no LLM, no throw):
  // locateFactQuote and the source/span selection never reject. Keeping it
  // outside the try lets the catch walk the same inputs to tag a pipeline
  // failure as "unchecked" rather than dropping it on the floor.
  const inputs: { factIndex: number; input: FaithfulnessCheckInput }[] = [];
  for (let fi = 0; fi < facts.length; fi++) {
    const f = facts[fi];
    if (!f || typeof f.content !== "string" || !f.content.trim()) continue;
    // Prefer #1575 verified spans; fall back to a located quote from the
    // source turn text so the gate runs even before per-fact sources are
    // attached. Without either, the fact is skipped_no_span (never gated).
    // A composite fact may be supported by multiple adjacent spans — collect
    // every valid source quote so the verifier sees the full evidence, not
    // just sources[0] (codex review PRRT_kwDORJXyws6ObYQ_).
    const sources = Array.isArray(f.sources) ? f.sources : [];
    const sourceQuotes = sources
      .map((s) => (s && typeof s.quote === "string" ? s.quote.trim() : ""))
      .filter((q) => q.length > 0);
    const quote =
      sourceQuotes.length > 0
        ? sourceQuotes.join("\n")
        : locateFactQuote(f.content, sourceText);
    if (!quote) continue; // no located span — applyFaithfulnessVerdict tags skipped_no_span
    inputs.push({ factIndex: fi, input: { factText: f.content, quote } });
  }
  const resultsByFactIndex = new Map<number, FaithfulnessResult>();
  if (inputs.length === 0) return resultsByFactIndex;
  try {
    const batch = await checkFaithfulnessBatch(
      inputs.map((x) => x.input),
      config,
      localLlm,
      fallbackLlm,
    );
    for (let j = 0; j < inputs.length; j++) {
      const entry = inputs[j];
      if (entry) resultsByFactIndex.set(entry.factIndex, batch.results[j]!);
    }
    // Verdict-distribution counters are bumped in applyFaithfulnessVerdict
    // (at the per-fact apply point), NOT here, so console_state reflects
    // facts that actually reached verdict application — not facts later
    // dropped by dedup, importance, or judge gates (cursor review).
    log.info(
      `extraction-faithfulness[${mode}]: ${inputs.length} facts checked, ${batch.elapsedMs}ms`,
    );
  } catch (err) {
    // Fail-open: a pipeline error never blocks writes (checklist §4). Tag each
    // checkable fact as backend_unavailable so applyFaithfulnessVerdict records
    // "unchecked" (issue spec: backend failure → unchecked). Returning null
    // here would make a shadow/enforce batch failure indistinguishable from
    // gate-off, losing the telemetry signal (cursor review). Facts with no
    // located span stay absent → skipped_no_span at apply time.
    log.warn(
      `extraction-faithfulness: pipeline error, tagging ${inputs.length} checkable facts as unchecked (fail-open): ${err instanceof Error ? err.message : String(err)}`,
    );
    for (const { factIndex } of inputs) {
      resultsByFactIndex.set(factIndex, { ok: false, error: { code: "backend_unavailable" } });
    }
  }
  return resultsByFactIndex;
}

/**
 * Apply a pre-computed faithfulness verdict to a single fact, producing the
 * frontmatter record + an optional enforce-mode `pending_review` status.
 *
 * - `resultsByFactIndex` null (gate off) → nothing (rule 39: byte-identical).
 * - fact has no entry (no verified span) → `skipped_no_span`, never gated.
 * - backend failure (`ok: false`) → `unchecked`, fact proceeds (checklist §4).
 * - enforce + unsupported/contradicted → `pending_review` (memory persists,
 *   enters the review queue, never silently dropped).
 *
 * Mutates `counters.skippedNoSpan` for facts without a span.
 */
export function applyFaithfulnessVerdict(
  resultsByFactIndex: Map<number, FaithfulnessResult> | null,
  factLoopIndex: number,
  mode: "off" | "shadow" | "enforce",
  factContent: string,
  counters: FaithfulnessGateCounters,
): {
  faithfulness: FaithfulnessFrontmatter | undefined;
  enforceStatus: "pending_review" | undefined;
} {
  if (!resultsByFactIndex) {
    return { faithfulness: undefined, enforceStatus: undefined };
  }
  const result = resultsByFactIndex.get(factLoopIndex);
  if (!result) {
    // No result for this fact index — it had no verified source span.
    counters.skippedNoSpan++;
    return {
      faithfulness: { verdict: "skipped_no_span", at: new Date().toISOString() },
      enforceStatus: undefined,
    };
  }
  if (result.ok) {
    if (result.verdict === "entailed") counters.entailed++;
    else if (result.verdict === "contradicted") counters.contradicted++;
    else if (result.verdict === "unsupported") counters.unsupported++;
    const fm: FaithfulnessFrontmatter = {
      verdict: result.verdict,
      ...(result.model ? { model: result.model } : {}),
      ...(result.rationale ? { rationale: result.rationale } : {}),
      at: new Date().toISOString(),
    };
    let enforceStatus: "pending_review" | undefined;
    if (
      mode === "enforce" &&
      (result.verdict === "unsupported" || result.verdict === "contradicted")
    ) {
      enforceStatus = "pending_review";
      log.info(
        `extraction-faithfulness[enforce]: routing "${factContent.slice(0, 60)}…" to pending_review (verdict=${result.verdict})`,
      );
    }
    return { faithfulness: fm, enforceStatus };
  }
  // Backend failure — record as unchecked, fact proceeds (graceful degradation).
  counters.unchecked++;
  return {
    faithfulness: { verdict: "unchecked", at: new Date().toISOString() },
    enforceStatus: undefined,
  };
}
// ---------------------------------------------------------------------------
// Frontmatter serialization (single-line JSON, like provenance sources)
// ---------------------------------------------------------------------------

/**
 * Canonical key order for the serialized `faithfulness` frontmatter field.
 * Deterministic emission (rule 38).
 */
const FAITHFULNESS_KEY_ORDER = ["verdict", "model", "rationale", "at"] as const;

/**
 * Serialize the `faithfulness` frontmatter field as a single JSON line,
 * appended to `lines`. Called from `serializeFrontmatter` in storage.ts.
 *
 * Contract: when `fm.faithfulness` is absent, no line is emitted — the
 * memory round-trips byte-identical to pre-#1576 behavior (rule 39).
 */
export function serializeFaithfulnessFields(fm: MemoryFrontmatter, lines: string[]): void {
  if (!fm.faithfulness) return;
  const fm2 = fm.faithfulness;
  const canonical: Record<string, unknown> = {};
  for (const key of FAITHFULNESS_KEY_ORDER) {
    const val = fm2[key];
    if (val !== undefined && val !== null && val !== "") {
      canonical[key] = val;
    }
  }
  // verdict is always present on a valid FaithfulnessFrontmatter
  if (!canonical.verdict) return;
  lines.push(`faithfulness: ${JSON.stringify(canonical)}`);
}

/**
 * Parse the `faithfulness` frontmatter line from its single-line JSON form.
 * Returns `undefined` for missing, blank, or corrupt values so a malformed
 * frontmatter never poisons downstream readers (rule 34 spirit).
 */
export function parseFaithfulnessField(
  raw: string | undefined,
): FaithfulnessFrontmatter | undefined {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    const verdictRaw = typeof obj.verdict === "string" ? obj.verdict : undefined;
    if (!verdictRaw) return undefined;
    const validVerdicts = new Set([
      "entailed",
      "contradicted",
      "unsupported",
      "unchecked",
      "skipped_no_span",
    ]);
    if (!validVerdicts.has(verdictRaw)) return undefined;
    const result: FaithfulnessFrontmatter = {
      verdict: verdictRaw as FaithfulnessFrontmatter["verdict"],
    };
    if (typeof obj.model === "string" && obj.model.length > 0) {
      result.model = obj.model;
    }
    if (typeof obj.rationale === "string" && obj.rationale.length > 0) {
      result.rationale = obj.rationale.slice(0, 500);
    }
    if (typeof obj.at === "string" && obj.at.length > 0) {
      result.at = obj.at;
    }
    return result;
  } catch {
    return undefined;
  }
}
