import { ExtractionEngine } from "../extraction.js";
import { LocalLlmClient } from "../local-llm.js";
import type { ModelRegistry } from "../model-registry.js";
import type { ProfilingCollector } from "../profiling.js";
import type { PluginConfig } from "../types.js";
import type { RevalidationFastChatCompletion } from "./dependency-revalidation.js";

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
