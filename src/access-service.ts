export * from "@remnic/core/access-service";

import type { PluginConfig, SupportPassportModelRoute } from "@remnic/core";
import { EngramAccessService as CoreEngramAccessService } from "@remnic/core/access-service";
import { FallbackLlmClient, fallbackLlmRuntimeContextFromConfig } from "@remnic/core/fallback-llm";
import { createOpenClawSupportPassportModelRoute } from "@remnic/plugin-openclaw/support-passport-model-route";

type CoreAccessServiceConstructor = ConstructorParameters<typeof CoreEngramAccessService>;

export function createConfiguredSupportPassportGatewayRoute(
  config: PluginConfig,
  preferredClient?: Pick<FallbackLlmClient, "chatCompletion"> | null
): SupportPassportModelRoute | null {
  const gatewayClient =
    preferredClient ??
    (config.gatewayConfig
      ? new FallbackLlmClient(
          config.gatewayConfig,
          fallbackLlmRuntimeContextFromConfig(config)
        )
      : null);
  return gatewayClient
    ? createOpenClawSupportPassportModelRoute(config, gatewayClient)
    : null;
}

export class EngramAccessService extends CoreEngramAccessService {
  private readonly supportPassportGatewayRoute: SupportPassportModelRoute | null;

  constructor(
    orchestrator: CoreAccessServiceConstructor[0],
    options: NonNullable<CoreAccessServiceConstructor[1]> = {}
  ) {
    super(orchestrator, options);
    const injectedRoute = super.supportPassportGatewayRouteRef;
    this.supportPassportGatewayRoute =
      injectedRoute ??
      createConfiguredSupportPassportGatewayRoute(
        orchestrator.config,
        orchestrator.fastGatewayLlm
      );
  }

  override get supportPassportGatewayRouteRef(): SupportPassportModelRoute | null {
    return this.supportPassportGatewayRoute;
  }
}
