import type { LocalLlmClient } from "./local-llm.js";
import type { PluginConfig } from "./types.js";

/**
 * Decide whether the optional proactive extraction second-pass should run.
 *
 * The proactive pass is fail-soft enrichment: it re-sends the full conversation
 * to generate follow-up questions on top of the base extraction. On a saturated
 * single-lane local LLM host (one Ollama runner), an optional pass queued behind
 * an in-flight extraction loses its short client deadline while it waits, 500s,
 * and wastes prefill GPU-seconds without ever producing output (issue #2011).
 *
 * Returns false (skip the pass, keep the base extraction unchanged) when:
 * - the pass is disabled by budget config (`0` question / timeout / token caps),
 * - or `proactiveExtractionSkipWhenLocalLlmBusy` is on, the extraction is running
 *   against the local LLM, and that client's background lane is already busy —
 *   so the optional pass would only queue behind concurrent extraction work.
 *
 * The cloud-fallback path has no single-lane saturation, so the busy-lane skip
 * only applies when the local LLM is the active extractor.
 */
export function shouldRunProactivePass(
  config: PluginConfig,
  maxAdditional: number,
  usingLocalLlm: boolean,
  localLlm: LocalLlmClient,
): boolean {
  if (maxAdditional === 0) return false;
  if (config.proactiveExtractionTimeoutMs === 0) return false;
  if (config.proactiveExtractionMaxTokens === 0) return false;
  if (
    config.proactiveExtractionSkipWhenLocalLlmBusy &&
    usingLocalLlm &&
    localLlm.isBackgroundLaneContended()
  ) {
    return false;
  }
  return true;
}
