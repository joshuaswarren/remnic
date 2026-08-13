import type { PluginConfig, SupportPassportModelRoute } from "@remnic/core";
import { type FallbackLlmClient, type FallbackLlmOptions, gatewayTaskChainOptions } from "@remnic/core/fallback-llm";

type SupportPassportGatewayConfig = Pick<PluginConfig, "modelSource" | "taskModelChain" | "gatewayAgentId">;

export function createOpenClawSupportPassportModelRoute(
  config: SupportPassportGatewayConfig,
  client: Pick<FallbackLlmClient, "chatCompletion">
): SupportPassportModelRoute {
  return {
    kind: "gateway",
    invoke: async (messages, options) => {
      const routeOptions: FallbackLlmOptions = {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        store: false,
        responsesJsonSchema: options.jsonSchema,
        redactProviderErrors: true,
        includeDefaultModelFallback: false,
        acceptResponse: options.acceptResponse,
        ...gatewayTaskChainOptions(config),
      };
      return await client.chatCompletion(messages, routeOptions);
    },
  };
}
