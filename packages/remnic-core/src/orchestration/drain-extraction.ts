import { ExtractionEngine } from "../extraction.js";
import { LocalLlmClient } from "../local-llm.js";
import type { ModelRegistry } from "../model-registry.js";
import type { ProfilingCollector } from "../profiling.js";
import type { PluginConfig } from "../types.js";
import type { RevalidationFastChatCompletion } from "./dependency-revalidation.js";

/**
 * The extraction engine claim-backed drains use. It owns a separate local LLM
 * client, so a drain extraction has its own request lane: it is never queued
 * behind summaries, consolidation or live extraction on the shared client
 * (production waits reached 40 minutes). The client also does not retry after
 * a timed-out attempt (`localLlmRetry5xxCount: 0`): the breaker and per-key
 * backoff own retrying, and a second 600 s attempt only held the engine slot.
 * Rate-limit retries have their own budget and are unchanged.
 */
export function createDrainExtractionEngine(
  config: PluginConfig,
  profiler: ProfilingCollector,
  modelRegistry: ModelRegistry,
  shutdownSignal: AbortSignal,
  fastChatCompletion: RevalidationFastChatCompletion,
): ExtractionEngine {
  const drainConfig: PluginConfig = { ...config, localLlmRetry5xxCount: 0 };
  const client = new LocalLlmClient(drainConfig, modelRegistry, shutdownSignal);
  client.disableThinking = config.localLlmDisableThinking;
  return new ExtractionEngine(drainConfig, profiler, client, config.gatewayConfig, modelRegistry, fastChatCompletion);
}
