import type { PluginConfig, SupportPassportModelRoute } from "@remnic/core";
import { type FallbackLlmClient, type FallbackLlmOptions, gatewayTaskChainOptions } from "@remnic/core/fallback-llm";

type SupportPassportGatewayConfig = Pick<
  PluginConfig,
  "modelSource" | "taskModelChain" | "gatewayAgentId" | "gatewayConfig"
>;

function hasConfiguredExplicitRoute(config: SupportPassportGatewayConfig): boolean {
  if (config.taskModelChain !== undefined) {
    return typeof config.taskModelChain.primary === "string" && config.taskModelChain.primary.trim().length > 0;
  }

  const agentId = config.gatewayAgentId.trim();
  if (agentId.length === 0) return true;

  const persona = config.gatewayConfig?.agents?.list?.find((agent) => agent.id === agentId);
  return typeof persona?.model?.primary === "string" && persona.model.primary.trim().length > 0;
}

export function createOpenClawSupportPassportModelRoute(
  config: SupportPassportGatewayConfig,
  client: Pick<FallbackLlmClient, "chatCompletion">
): SupportPassportModelRoute {
  const explicitRouteAvailable = hasConfiguredExplicitRoute(config);
  return {
    kind: "gateway",
    invoke: async (messages, options) => {
      if (!explicitRouteAvailable) return null;
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
