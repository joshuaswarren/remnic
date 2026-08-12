export * from "@remnic/core/access-service";

import { EngramAccessService as CoreEngramAccessService } from "@remnic/core/access-service";
import type { SupportPassportModelRoute } from "@remnic/core";
import { FallbackLlmClient, fallbackLlmRuntimeContextFromConfig } from "@remnic/core/fallback-llm";

import { createOpenClawSupportPassportModelRoute } from "../packages/plugin-openclaw/src/support-passport-model-route.js";

type CoreAccessServiceConstructor = ConstructorParameters<typeof CoreEngramAccessService>;

export class EngramAccessService extends CoreEngramAccessService {
  private readonly supportPassportGatewayRoute: SupportPassportModelRoute | null;

  constructor(
    orchestrator: CoreAccessServiceConstructor[0],
    options: NonNullable<CoreAccessServiceConstructor[1]> = {}
  ) {
    super(orchestrator, options);
    const gatewayClient =
      orchestrator.fastGatewayLlm ??
      (orchestrator.config.gatewayConfig
        ? new FallbackLlmClient(
            orchestrator.config.gatewayConfig,
            fallbackLlmRuntimeContextFromConfig(orchestrator.config)
          )
        : null);
    this.supportPassportGatewayRoute = gatewayClient
      ? createOpenClawSupportPassportModelRoute(orchestrator.config, gatewayClient)
      : null;
  }

  override get supportPassportGatewayRouteRef(): SupportPassportModelRoute | null {
    return this.supportPassportGatewayRoute;
  }
}
