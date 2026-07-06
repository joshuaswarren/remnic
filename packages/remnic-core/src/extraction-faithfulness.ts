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
import {
  callOpenAiCompatibleChat,
  resolveFaithfulnessGateEndpoint,
} from "./local-model-endpoint.js";
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
  if (!Array.isArray(data)) {
    // Accept object-wrapped arrays — {"results":[...]}, {"verdicts":[...]},
    // {"entries":[...]}, {"facts":[...]} — a common JSON-object prompt shape the
    // extraction-judge parser already accepts. Rejecting them marked the whole
    // batch malformed_output; in enforce mode those facts then wrote as ACTIVE
    // (gate bypass — codex Ob4RO).
    if (data && typeof data === "object") {
      for (const key of ["results", "verdicts", "entries", "facts"]) {
        const inner = (data as Record<string, unknown>)[key];
        if (Array.isArray(inner)) return parseEntries(inner, expectedCount);
      }
    }
    return null;
  }
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
  fetchImpl: typeof fetch = fetch,
): Promise<LlmCallResult> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Issue #1585 model-lab pointer: when an explicit local fine-tuned endpoint
  // is configured (base URL + model name), try it FIRST — it is the cheapest,
  // deterministic path the operator opted into by setting
  // extractionFaithfulnessBaseUrl. Unset (the default) skips this entirely,
  // preserving byte-identical pre-feature routing (rule 39). Any failure
  // (network, non-2xx, malformed body, timeout) returns null and falls through
  // to the configured chain (checklist §4 graceful degradation).
  const localEndpoint = resolveFaithfulnessGateEndpoint(config);
  if (localEndpoint) {
    // Give the local probe a SMALLER budget than the outer batch timeout so a
    // wedged local model returns null (and falls through to the configured
    // chain) before the batch timer fires. The local endpoint is meant to be
    // the fast path; if it cannot answer within half the budget (min 500ms),
    // abandon it and let the fallback chain use the remainder (codex P2 — the
    // advertised graceful fallback must actually reach the chain, not be starved
    // by a hanging probe sharing the full batch budget).
    const probeBudgetMs = Math.max(500, Math.floor(timeoutMs / 2));
    const result = await callOpenAiCompatibleChat(
      localEndpoint,
      messages,
      { temperature: 0.1, maxTokens: 2048, responseFormatJson: true, timeoutMs: probeBudgetMs },
      fetchImpl,
    );
    if (result?.content) {
      return { content: result.content, modelUsed: result.modelUsed };
    }
    log.debug(
      "extraction-faithfulness: local model-lab endpoint unavailable, trying configured chain",
    );
  }

  // extractionFaithfulnessModel is the LOCAL served model's name (e.g.
  // remnic-faithfulness-gate-v1). When a local endpoint is configured it
  // belongs to that endpoint ONLY — it must NOT leak into the fallback chain
  // as a gateway/local-LLM override, or a local outage forces the configured
  // chain onto an unavailable local-only model and turns graceful fallback
  // into backend_unavailable (codex P2 PRRT_kwDORJXyws6Otp-L). Decouple: the
  // override reaches the fallback chain only when NO local endpoint is
  // configured (the pre-feature model-override contract, preserved
  // byte-identical — rule 39).
  const modelOverride = localEndpoint ? undefined : (config.extractionFaithfulnessModel || undefined);

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
  /**
   * Optional fetch injection (issue #1585). The orchestrator does not pass it
   * (uses global fetch); tests pass a stub to exercise the local model-lab
   * endpoint path without a live server. See callFaithfulnessLlm.
   */
  fetchImpl?: typeof fetch,
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
  // Race the LLM call against the budget so the batch fails open at
  // `timeoutMs` regardless of which backend is in flight. The local backend
  // ignores the batch AbortSignal (it aborts each attempt via its own
  // controller keyed on `timeoutMs`), so awaiting callFaithfulnessLlm directly
  // could block past the budget on a slow/retrying local verifier. The timer
  // both aborts the fallback (which honors the signal) and resolves the race
  // so the batch returns promptly; the in-flight local call aborts on its own
  // per-attempt timeoutMs. (codex review PRRT_kwDORJXyws6ObgMJ.)
  // Manual deferred instead of Promise.withResolvers (ES2024) — plugin-openclaw's
  // standalone tsconfig targets ES2022 lib and this module is reachable from its
  // type graph, so withResolvers would TS2550 there.
  let resolveTimeout!: (value: true) => void;
  const racedTimeout = new Promise<true>((resolve) => {
    resolveTimeout = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    resolveTimeout(true);
  }, timeoutMs);

  try {
    const callPromise = callFaithfulnessLlm(
      FAITHFULNESS_SYSTEM_PROMPT,
      userPrompt,
      config,
      localLlm,
      fallbackLlm,
      timeoutMs,
      controller.signal,
      fetchImpl,
    );
    const settled = await Promise.race([
      callPromise.then(
        (r) => ({ done: true as const, result: r }),
        // An unexpected throw is treated as "no content" (backend_unavailable)
        // so the race never rejects and the outer catch is the final safety net.
        () => ({ done: true as const, result: { content: null, modelUsed: null } }),
      ),
      racedTimeout.then(() => ({ done: false as const })),
    ]);
    const elapsedMs = Date.now() - startedAt;

    if (!settled.done) {
      // The budget elapsed before any backend returned content. Fail open as
      // timeout; the orphaned callPromise resolves/rejects harmlessly (the
      // fallback was aborted; the local client aborts on its own timeoutMs).
      for (const idx of checkableIndices) {
        results[idx] = { ok: false, error: { code: "timeout" } };
      }
      return { results, elapsedMs };
    }

    const llmResult = settled.result;

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
/**
 * Extract a bounded window of `sourceText` centered on the located `quote`,
 * bounded by `contextChars` (the config's "window around the quote" semantics).
 *
 * Used by the fallback-locator path in `runFaithfulnessGateBatch` so the
 * verifier sees surrounding turn text — without it,
 * `extractionFaithfulnessContextChars` is effectively ignored in the
 * production path (codex review PRRT_kwDORJXyws6OblI1). Returns undefined when
 * the quote is absent from sourceText (e.g. it was truncated by maxQuoteChars).
 */
export function extractContextWindow(
  sourceText: string,
  quote: string,
  contextChars: number,
  /**
   * Character offset of `quote` within `sourceText` (from `locateFactQuote`).
   * When the quote string appears more than once — e.g. repeated anaphoric
   * lines after different entities — pass the matched occurrence's offset so
   * the context window centers on the actual match, not the first occurrence
   * (issue #1633, codex PRRT_kwDORJXyws6ObzwI). Defaults to the first
   * occurrence via indexOf for backward compatibility.
   */
  matchedOffset?: number,
): string | undefined {
  if (!sourceText || !quote || !(contextChars > 0)) return undefined;
  let idx: number;
  if (matchedOffset !== undefined && matchedOffset >= 0) {
    const at = sourceText.indexOf(quote, matchedOffset);
    // Fall back to the first occurrence if the matched offset is stale (e.g.
    // the quote was bounded and is not a literal substring at that offset).
    idx = at >= 0 ? at : sourceText.indexOf(quote);
  } else {
    idx = sourceText.indexOf(quote);
  }
  if (idx < 0) return undefined;
  const quoteEnd = idx + quote.length;
  const center = Math.floor((idx + quoteEnd) / 2);
  const half = Math.floor(contextChars / 2);
  let start = Math.max(0, center - half);
  const end = Math.min(sourceText.length, start + contextChars);
  // Re-anchor start so the window uses the full budget when end clamped.
  start = Math.max(0, end - contextChars);
  const window = sourceText.slice(start, end).trim();
  return window.length > 0 ? window : undefined;
}

/**
 * A located fallback quote plus the offset it begins at in the source text.
 * `offset` lets `extractContextWindow` disambiguate repeated occurrences of
 * the same quote string (issue #1633).
 */
export interface LocatedQuote {
  /** Verbatim source span, centered on the matched terms when truncated. */
  quote: string;
  /** Character offset of `quote` within sourceText. */
  offset: number;
}

interface SourceCandidate {
  /** Trimmed candidate text. */
  text: string;
  /** Character offset of `text` within the source string. */
  start: number;
}

/**
 * Split source text into candidate spans (sentences, then line segments as a
 * fallback for transcripts without sentence punctuation), tracking each
 * candidate's start offset so repeated occurrences can be disambiguated
 * (issue #1633).
 */
function splitSourceCandidates(sourceText: string): SourceCandidate[] {
  const candidates: SourceCandidate[] = [];
  const re = /(?<=[.!?])\s+|\n+/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceText)) !== null) {
    pushCandidate(candidates, sourceText, lastEnd, m.index);
    lastEnd = re.lastIndex;
  }
  pushCandidate(candidates, sourceText, lastEnd, sourceText.length);
  return candidates;
}

function pushCandidate(
  out: SourceCandidate[],
  source: string,
  begin: number,
  end: number,
): void {
  const seg = source.slice(begin, end);
  const leadingWS = seg.length - seg.trimStart().length;
  const trimmed = seg.trim();
  if (trimmed.length > 0) {
    out.push({ text: trimmed, start: begin + leadingWS });
  }
}

/**
 * Locate the start offsets of fact-token matches inside a candidate. Used by
 * `locateFactQuote` to build a bounded window that is guaranteed to contain
 * real evidence (issue #1633, codex PRRT_kwDORJXyws6Obrwe / PRRT_kwDORJXyws6Oce-O).
 */
function locateMatchedTokens(factTokens: Set<string>, candidate: string): number[] {
  const lower = candidate.toLowerCase();
  const wordRe = /[a-z0-9]+/g;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(lower)) !== null) {
    const word = m[0];
    if (word.length <= 1) continue;
    if (STOPWORDS.has(word)) continue;
    if (factTokens.has(crudeStem(word))) {
      positions.push(m.index);
    }
  }
  return positions;
}

/**
 * Build a bounded window of `maxChars` from `text` that contains the densest
 * cluster of matched-token positions. Slides a maxChars-wide window anchored
 * at each matched token and keeps the one that captures the most matches
 * (tiebreak: earliest anchor). This guarantees the window includes real
 * evidence even when the matched span is wider than `maxChars` (e.g. fact
 * tokens at both ends of a long sentence with filler between). Centering on
 * the densest cluster's midpoint then uses any leftover budget as leading and
 * trailing context. Returns the window text and its start offset within `text`
 * so callers can translate the in-candidate offset back to a source-text offset.
 */
function boundedWindow(
  text: string,
  matchedPositions: number[],
  maxChars: number,
): { text: string; start: number } {
  if (matchedPositions.length === 0) {
    // Defensive: overlap scoring accepted the candidate but no individual
    // token matched (e.g. all matches were stopwords). Fall back to prefix.
    const end = Math.min(text.length, maxChars);
    return { text: text.slice(0, end), start: 0 };
  }
  // matchedPositions is sorted ascending (the regex scans left-to-right), so a
  // two-pointer sliding window finds the densest maxChars-wide cluster in O(n)
  // instead of O(n^2). This matters when a long unpunctuated candidate carries
  // many repeats of a fact token (pasted logs, minified text) — thousands of
  // positions would otherwise stall extraction before the LLM call (codex
  // PRRT_kwDORJXyws6Ocih3).
  let bestAnchor = matchedPositions[0]!;
  let bestCount = 0;
  let bestLast = bestAnchor;
  let j = 0;
  for (let i = 0; i < matchedPositions.length; i++) {
    const anchor = matchedPositions[i]!;
    const winEnd = anchor + maxChars;
    if (j < i) j = i;
    while (j + 1 < matchedPositions.length && matchedPositions[j + 1]! < winEnd) {
      j++;
    }
    const count = j - i + 1;
    if (count > bestCount) {
      bestCount = count;
      bestAnchor = anchor;
      bestLast = matchedPositions[j]!;
    }
  }
  // The densest cluster [bestAnchor, bestLast] fits within maxChars by
  // construction; center a maxChars window on its midpoint, clamped to text.
  const center = Math.floor((bestAnchor + bestLast) / 2);
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, center - half);
  const end = Math.min(text.length, start + maxChars);
  // Re-anchor start so the window uses the full budget when end clamped.
  start = Math.max(0, end - maxChars);
  return { text: text.slice(start, end), start };
}

export function locateFactQuote(
  factText: string,
  sourceText: string,
  maxQuoteChars = 600,
): LocatedQuote | undefined {
  if (!factText || !sourceText) return undefined;
  const factTokens = tokenize(factText);
  if (factTokens.size === 0) return undefined;
  const candidates = splitSourceCandidates(sourceText);
  if (candidates.length === 0) return undefined;
  // Pick the best-overlap candidate. Tiebreak equal own-overlap scores by a
  // "context" score that includes the immediately PRECEDING candidate's text,
  // so a repeated anaphoric line ("It launched in March") resolves to the
  // occurrence whose neighbor names the fact's entity (issue #1633, codex
  // PRRT_kwDORJXyws6Oce-S). Without this tiebreak the first occurrence wins
  // even when the second is the one the fact refers to.
  let best: { candidate: SourceCandidate; score: number; contextScore: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const score = overlapCoefficient(factTokens, tokenize(candidate.text));
    const prevText = i > 0 ? candidates[i - 1]!.text : "";
    const contextText = prevText ? `${prevText} ${candidate.text}` : candidate.text;
    const contextScore = overlapCoefficient(factTokens, tokenize(contextText));
    if (
      !best ||
      score > best.score ||
      (score === best.score && contextScore > best.contextScore)
    ) {
      best = { candidate, score, contextScore };
    }
  }
  if (!best || best.score < LOCATE_QUOTE_MIN_OVERLAP) return undefined;
  const { text, start } = best.candidate;
  if (text.length <= maxQuoteChars) {
    return { quote: text, offset: start };
  }
  // Build a bounded window around the densest cluster of matched terms instead
  // of returning the first maxQuoteChars prefix (issue #1633). Returning the
  // prefix drops supporting words that fall after char ~600, routing
  // actually-entailed facts to pending_review in enforce mode.
  const matched = locateMatchedTokens(factTokens, text);
  const win = boundedWindow(text, matched, maxQuoteChars);
  return { quote: win.text, offset: start + win.start };
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
    const usingFallbackLocator = sourceQuotes.length === 0;
    let quote: string;
    let matchedOffset: number | undefined;
    if (sourceQuotes.length > 0) {
      quote = sourceQuotes.join("\n");
    } else {
      // Fallback locator returns the matched span AND its offset so the
      // context window centers on the occurrence that actually matched the
      // fact, not the first indexOf hit (issue #1633).
      const located = locateFactQuote(f.content, sourceText);
      if (!located) continue; // no located span — applyFaithfulnessVerdict tags skipped_no_span
      quote = located.quote;
      matchedOffset = located.offset;
    }
    // Pass source context into the verifier so extractionFaithfulnessContextChars
    // actually applies in the fallback-locator path (codex P2
    // PRRT_kwDORJXyws6OblI1). #1575 verified spans already carry full evidence,
    // so context is only synthesized for the fallback locator.
    const fallbackContext =
      usingFallbackLocator
        ? extractContextWindow(
            sourceText,
            quote,
            config.extractionFaithfulnessContextChars,
            matchedOffset,
          )
        : undefined;
    inputs.push({
      factIndex: fi,
      input: {
        factText: f.content,
        quote,
        ...(fallbackContext ? { context: fallbackContext } : {}),
      },
    });
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
