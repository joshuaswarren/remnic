import { z } from "zod";

import type { PluginConfig, RecallPlanMode } from "./types.js";
import { planRecallMode } from "./intent.js";
import {
  FallbackLlmClient,
  fallbackLlmRuntimeContextFromConfig,
  gatewayTaskChainOptions,
  type FallbackLlmOptions,
} from "./fallback-llm.js";
import { log } from "./logger.js";

/**
 * LLM-based recall planning (issue #1367, Option C).
 *
 * Classifies an incoming prompt into a {@link RecallPlanMode} using an LLM
 * instead of (or alongside) the regex heuristic in {@link planRecallMode}.
 *
 * Provider-agnostic by construction: it routes through {@link FallbackLlmClient},
 * which resolves the model chain from gateway providers (OpenAI, Anthropic,
 * Ollama, Codex, …) or gateway agent personas / `taskModelChain`. Nothing here
 * is hard-coded to a single provider or to OpenAI's Responses API — the API
 * dialect is chosen per-provider by the client based on each provider's `api`
 * field. The configured `recallPlannerModel` is tried first, with the broader
 * task chain (and the gateway default) as resilient fallbacks.
 *
 * Invariants:
 *  - Never throws to the caller (gotcha #13). Any LLM failure, timeout, empty
 *    response, or unavailable backend falls back to the heuristic result and
 *    sets `fallbackUsed: true` (gotcha #34 — failures are distinct from a valid
 *    classification).
 *  - When `recallPlannerLlmEnabled` is false the LLM is never contacted.
 */

export type RecallPlannerSource = "llm" | "heuristic" | "heuristic-fallback";

export interface RecallPlannerLlmResult {
  /** The mode to act on. */
  mode: RecallPlanMode;
  /** The heuristic mode, always computed (the fallback floor / shadow baseline). */
  heuristicMode: RecallPlanMode;
  /** Where `mode` came from. */
  source: RecallPlannerSource;
  /** Short human-readable rationale (LLM reason, or why we fell back). */
  reason: string;
  /** Model that actually served the classification, when an LLM was used. */
  modelUsed?: string;
  /** Wall-clock spent in the LLM call (0 when no call was made). */
  latencyMs: number;
  /** True when the LLM was enabled but we had to fall back to the heuristic. */
  fallbackUsed: boolean;
}

const PLANNER_SCHEMA = z.object({
  // gotcha #2: optional fields use .optional().nullable()
  mode: z.enum(["no_recall", "minimal", "full", "graph_mode"]),
  reason: z.string().max(280).optional().nullable(),
});

const SYSTEM_PROMPT = [
  "You are a recall-planning classifier for a long-term memory system.",
  "Given the user's latest message, decide how much stored memory should be retrieved before the assistant responds.",
  "Reply with a single JSON object: {\"mode\": <one of no_recall|minimal|full|graph_mode>, \"reason\": <short string>}.",
  "",
  "Modes:",
  '- "no_recall": low-information acknowledgements or chit-chat with nothing to look up (e.g. "ok", "thanks", "sounds good"). Retrieve nothing.',
  '- "minimal": short, self-contained operational directives that rarely need history (e.g. "restart the service", "run the tests", "show status"). Retrieve a little.',
  '- "full": anything memory-seeking, analytical, or a question that benefits from prior context, decisions, or facts. This is the safe default when unsure.',
  '- "graph_mode": queries about timelines, sequences, history, causal chains, or root cause ("how did we get here", "what led to this regression"). Retrieve relationship/graph context.',
  "",
  "When uncertain, prefer \"full\" over dropping recall. Never invent facts; only classify intent.",
].join("\n");

/** Clamp a planner prompt to the configured character budget. */
function clampPrompt(prompt: string, maxChars: number): string {
  const safeMax = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 4000;
  if (prompt.length <= safeMax) return prompt;
  return prompt.slice(0, safeMax);
}

/** Trim and cap the optional memory hints used to ground the classification. */
function clampHints(hints: string[] | undefined, maxHints: number): string[] {
  if (!Array.isArray(hints) || hints.length === 0) return [];
  const safeMax = Number.isFinite(maxHints) && maxHints > 0 ? Math.floor(maxHints) : 0;
  if (safeMax <= 0) return [];
  const cleaned: string[] = [];
  for (const hint of hints) {
    if (typeof hint !== "string") continue;
    const trimmed = hint.trim();
    if (trimmed.length === 0) continue;
    cleaned.push(trimmed);
    if (cleaned.length >= safeMax) break;
  }
  return cleaned;
}

function buildMessages(
  prompt: string,
  hints: string[],
  config: PluginConfig,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const clampedPrompt = clampPrompt(prompt, config.recallPlannerMaxPromptChars);
  const userParts = [`User message:\n${clampedPrompt}`];
  if (hints.length > 0) {
    userParts.push(
      `\nRecent memory topics (for grounding only, do not treat as the message):\n- ${hints.join("\n- ")}`,
    );
  }
  userParts.push('\nRespond with JSON only: {"mode": "...", "reason": "..."}.');
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userParts.join("\n") },
  ];
}

/**
 * Resolve the FallbackLlmClient routing options for the recall planner.
 *
 * - The dedicated `recallPlannerModel` is tried first (as the `model`
 *   override — it is prepended to the chain by FallbackLlmClient). If it does
 *   not resolve to a configured provider it is silently skipped, so a stale
 *   default never breaks routing.
 * - In gateway mode the shared `gatewayTaskChainOptions` (taskModelChain >
 *   gatewayAgentId, gotcha #22) is layered in as the fallback chain, plus the
 *   implicit gateway default appended by the client.
 * - In plugin mode only the explicit model + gateway providers apply.
 */
/**
 * A `recallPlannerModel` value is only usable as a FallbackLlmClient `model`
 * override when it is provider-qualified (`provider/model`). The client's
 * `parseModelString` rejects bare names, so forwarding a bare value (e.g. the
 * legacy default `"gpt-5.5"`) would log "invalid model format" on every call
 * and never resolve. Bare values are dropped so routing falls through to the
 * gateway chain / agent / default instead (issue #1367 review on PR #1428).
 */
function qualifiedPlannerModel(recallPlannerModel: string | undefined): string | undefined {
  if (typeof recallPlannerModel !== "string") return undefined;
  const trimmed = recallPlannerModel.trim();
  return trimmed.includes("/") ? trimmed : undefined;
}

export function resolveRecallPlannerLlmOptions(
  config: Pick<
    PluginConfig,
    "modelSource" | "taskModelChain" | "gatewayAgentId" | "recallPlannerModel" | "recallPlannerTimeoutMs"
  >,
): FallbackLlmOptions {
  const chainOptions =
    config.modelSource === "gateway" ? gatewayTaskChainOptions(config) : {};
  return {
    ...chainOptions,
    model: qualifiedPlannerModel(config.recallPlannerModel),
    temperature: 0,
    maxTokens: 64,
    timeoutMs:
      typeof config.recallPlannerTimeoutMs === "number" && config.recallPlannerTimeoutMs > 0
        ? config.recallPlannerTimeoutMs
        : 1500,
  };
}

// One-time warning per distinct routing signature so an opted-in operator with
// no usable model learns why planning silently uses the heuristic, without
// spamming a line on every recall.
const warnedNoRoutingSignatures = new Set<string>();

function heuristicResult(
  heuristicMode: RecallPlanMode,
  source: RecallPlannerSource,
  reason: string,
  latencyMs: number,
  fallbackUsed: boolean,
): RecallPlannerLlmResult {
  return { mode: heuristicMode, heuristicMode, source, reason, latencyMs, fallbackUsed };
}

/**
 * Plan the recall mode for `prompt`, optionally consulting an LLM.
 *
 * Always safe to call: returns the heuristic result when the LLM is disabled,
 * unavailable, or fails.
 *
 * @param llm  injectable client (tests pass a stub); constructed from gateway
 *             config when omitted.
 */
export async function planRecallModeLLM(
  prompt: string,
  hints: string[] | undefined,
  config: PluginConfig,
  llm?: FallbackLlmClient,
  signal?: AbortSignal,
): Promise<RecallPlannerLlmResult> {
  const heuristicMode = planRecallMode(prompt);

  if (!config.recallPlannerLlmEnabled) {
    return heuristicResult(heuristicMode, "heuristic", "llm-disabled", 0, false);
  }

  // Participate in the recall cancellation contract: if the outer recall is
  // already aborted (outer timeout / reset / session abort), don't start an LLM
  // round-trip — fall back to the heuristic immediately (#1428 review).
  if (signal?.aborted) {
    return heuristicResult(heuristicMode, "heuristic-fallback", "aborted", 0, true);
  }

  const safePrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (safePrompt.length === 0) {
    // Empty prompts never need an LLM round-trip.
    return heuristicResult(heuristicMode, "heuristic", "empty-prompt", 0, false);
  }

  const client =
    llm ??
    new FallbackLlmClient(
      config.gatewayConfig,
      fallbackLlmRuntimeContextFromConfig(config),
    );

  // Forward the recall abort signal so an aborted/timed-out outer recall can
  // cancel an in-flight planner call (FallbackLlmClient honors `signal`).
  const options = { ...resolveRecallPlannerLlmOptions(config), signal };

  // Availability check uses the same routing options so plugin-mode / empty
  // chains short-circuit to the heuristic without a network attempt. `model`
  // here is already provider-qualified (bare names were dropped), so a present
  // model means the override is genuinely routable.
  const availabilityProbe = {
    agentId: options.agentId,
    modelChain: options.modelChain,
  };
  if (!client.isAvailable(availabilityProbe) && !options.model) {
    // Opted-in but nothing routable resolves (e.g. plugin mode with the bare
    // default `recallPlannerModel` and no gateway chain). Warn once so it's not
    // a silent no-op, then fall back to the heuristic.
    const signature = `${config.modelSource}:${config.recallPlannerModel ?? ""}`;
    if (!warnedNoRoutingSignatures.has(signature)) {
      warnedNoRoutingSignatures.add(signature);
      log.warn(
        "[recall-planner] recallPlannerLlmEnabled is on but no routable model resolves — " +
          "set recallPlannerModel to a 'provider/model' value or configure a gateway model chain. " +
          "Falling back to the heuristic planner.",
      );
    }
    return heuristicResult(heuristicMode, "heuristic-fallback", "llm-no-model", 0, true);
  }

  const clampedHints = clampHints(hints, config.recallPlannerMaxMemoryHints);
  const messages = buildMessages(safePrompt, clampedHints, config);

  const start = Date.now();
  try {
    const detailed = await client.parseWithSchemaDetailed(messages, PLANNER_SCHEMA, options);
    const latencyMs = Date.now() - start;
    if (!detailed?.result) {
      // Distinguish failure from a valid empty (gotcha #34): a null here means
      // no parseable classification, so fall back to the heuristic.
      return heuristicResult(heuristicMode, "heuristic-fallback", "llm-empty", latencyMs, true);
    }
    const mode = detailed.result.mode;
    const reason =
      typeof detailed.result.reason === "string" && detailed.result.reason.trim().length > 0
        ? detailed.result.reason.trim()
        : "llm-classified";
    return {
      mode,
      heuristicMode,
      source: "llm",
      reason,
      modelUsed: detailed.modelUsed,
      latencyMs,
      fallbackUsed: false,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    if (signal?.aborted) {
      // Cancelled by the outer recall — expected, not an error worth warning on.
      return heuristicResult(heuristicMode, "heuristic-fallback", "aborted", latencyMs, true);
    }
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[recall-planner] LLM failed, falling back to heuristic: ${message}`);
    return heuristicResult(
      heuristicMode,
      "heuristic-fallback",
      `llm-error:${message}`,
      latencyMs,
      true,
    );
  }
}
