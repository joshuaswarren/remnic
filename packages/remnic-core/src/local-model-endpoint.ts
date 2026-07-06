/**
 * Local fine-tuned model endpoint resolver + openai-compatible caller
 * (issue #1585 model-lab integration).
 *
 * Remnic's two classification workloads — the extraction faithfulness gate
 * (#1576) and passive-correction intent detection (#1581) — can run on small
 * fine-tuned models served locally (Ollama / vLLM) instead of prompted
 * frontier LLMs. The model-lab (`model-lab/`) produces those models; this
 * module is the config-side half: it resolves the optional local endpoint
 * pointer from config and, when set, makes a minimal openai-compatible
 * chat-completions call to it.
 *
 * Design:
 *   - **Pointers are optional.** Empty defaults preserve the existing routing
 *     chain exactly (rule 39 / byte-identical pre-feature). A resolver returns
 *     `null` when the pointer is unset, so callers short-circuit before any
 *     network.
 *   - **Graceful degradation.** A local-endpoint failure (network, non-2xx,
 *     malformed body, timeout) returns `null`; callers fall back to the
 *     configured chain (checklist §4 — never block writes on a classifier).
 *   - **No inline casts.** The fetch JSON is narrowed with `in` / `typeof`
 *     guards (project rule: never assert a shape to read one property).
 *   - **Injectable fetch.** `callOpenAiCompatibleChat` takes an optional
 *     `fetchImpl` so the caller is unit-testable without a live server.
 */

import type { PluginConfig } from "./types.js";

/** A resolved local endpoint: where to call + which model to name. */
export interface LocalModelEndpoint {
  /** Base URL, e.g. `http://localhost:11434/v1` (no trailing slash required). */
  baseUrl: string;
  /** Model name the server expects, e.g. `remnic-faithfulness-gate-v1`. */
  model: string;
}

/** A chat message in the openai-compatible shape this caller sends. */
export interface EndpointChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options for a single local-endpoint chat call. */
export interface EndpointChatOptions {
  /** Per-call timeout in ms. The caller's batch AbortSignal is NOT forwarded
   *  (matches the local-LLM precedent: each attempt is bounded by its own
   *  timer so one slow server can't starve the batch). */
  timeoutMs: number;
  /** Sampling temperature — classification wants low entropy (0.0–0.2). */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
  /** Request JSON-object output (the gate emits a JSON verdict array). */
  responseFormatJson?: boolean;
}

/** Result of a local-endpoint chat call. */
export interface EndpointChatResult {
  content: string;
  /** The model the server reports it used (falls back to the requested name). */
  modelUsed: string;
}

/**
 * Resolve the faithfulness-gate local endpoint from config (issue #1585).
 *
 * Returns the endpoint only when BOTH a base URL and a model name are
 * configured; otherwise `null` (gate uses its existing routing chain). The
 * gate's verifier needs a model identity, so a base URL alone is intentionally
 * insufficient — silently calling whatever the server's default model is would
 * be an unreviewed behavioral change.
 */
export function resolveFaithfulnessGateEndpoint(
  config: Pick<PluginConfig, "extractionFaithfulnessModel" | "extractionFaithfulnessBaseUrl">,
): LocalModelEndpoint | null {
  const baseUrl = config.extractionFaithfulnessBaseUrl.trim();
  const model = config.extractionFaithfulnessModel.trim();
  if (!baseUrl || !model) return null;
  return { baseUrl, model };
}

/**
 * Resolve the correction-intent local endpoint from config (issue #1581/#1585).
 *
 * Same contract as the gate resolver. Consumption by the model-backed
 * detector is the consuming child's job — the rule-based
 * `detectPassiveCorrections` remains the default path; this pointer lets a
 * future model-backed detector route to a fine-tuned local classifier when an
 * operator configures one.
 */
export function resolveCorrectionIntentEndpoint(
  config: Pick<PluginConfig, "correctionIntentModel" | "correctionIntentBaseUrl">,
): LocalModelEndpoint | null {
  const baseUrl = config.correctionIntentBaseUrl.trim();
  const model = config.correctionIntentModel.trim();
  if (!baseUrl || !model) return null;
  return { baseUrl, model };
}

type FetchLike = typeof fetch;

/**
 * Make an openai-compatible chat-completions call to a local endpoint.
 *
 * POSTs to `${baseUrl}/chat/completions` with `{ model, messages, ... }` and
 * returns the first choice's content. Any failure (non-2xx, network error,
 * malformed body, timeout) returns `null` so callers fall back gracefully.
 *
 * The response is narrowed with runtime guards — never an unchecked cast — so
 * a surprising server response fails closed (`null`) rather than reading a
 * fabricated field.
 */
export async function callOpenAiCompatibleChat(
  endpoint: LocalModelEndpoint,
  messages: EndpointChatMessage[],
  options: EndpointChatOptions,
  fetchImpl: FetchLike = fetch,
): Promise<EndpointChatResult | null> {
  const url = joinBaseUrl(endpoint.baseUrl, "/chat/completions");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: endpoint.model,
      messages,
      temperature: options.temperature ?? 0.1,
    };
    if (typeof options.maxTokens === "number") {
      body.max_tokens = options.maxTokens;
    }
    if (options.responseFormatJson) {
      body.response_format = { type: "json_object" };
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Network error or abort — fail closed, let the caller fall back.
      return null;
    }
    if (!response.ok) return null;
    const parsed: unknown = await response.json().catch(() => null);
    const content = extractFirstChoiceContent(parsed);
    if (content === null) return null;
    return { content, modelUsed: extractModel(parsed) ?? endpoint.model };
  } finally {
    clearTimeout(timer);
  }
}

/** Join a base URL and a path, tolerating a trailing slash on the base. */
function joinBaseUrl(base: string, path: string): string {
  return base.endsWith("/") ? `${base.slice(0, -1)}${path}` : `${base}${path}`;
}

/**
 * Narrow the openai-compatible response and pull the first choice's content.
 *
 * `in` / `typeof` guards only — no `as` cast (project rule). Returns `null`
 * for any shape that isn't `{ choices: [{ message: { content: string } }, …] }`.
 */
function extractFirstChoiceContent(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  // After `in`, TS narrows the property to `unknown` — read it directly, no cast.
  if (!("choices" in data) || !Array.isArray(data.choices)) return null;
  const choices: unknown[] = data.choices;
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    if (!("message" in choice)) continue;
    const message = choice.message;
    if (!message || typeof message !== "object") continue;
    if (!("content" in message)) continue;
    const content = message.content;
    if (typeof content === "string" && content.length > 0) return content;
  }
  return null;
}

/** Narrow the `model` field from the response (best-effort, may be absent). */
function extractModel(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("model" in data)) return null;
  const model = data.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}
