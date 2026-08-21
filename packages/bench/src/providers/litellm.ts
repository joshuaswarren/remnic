import type { LlmProvider, OpenAiCompatibleProviderConfig } from "./types.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

export function createLiteLlmProvider(
  config: OpenAiCompatibleProviderConfig,
): LlmProvider {
  return createOpenAiCompatibleProvider({
    ...config,
    provider: "litellm",
    baseUrl: config.baseUrl ?? "http://localhost:4000",
  });
}
