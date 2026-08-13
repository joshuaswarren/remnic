import {
  EngramAccessService,
  SupportPassportModelBridge,
  composeSupportPassportExternalRequestHandlers,
  type Orchestrator,
  type PluginConfig,
  type SupportPassportExternalRequestHandler,
} from "@remnic/core";

export interface SupportPassportServerRuntime {
  service: EngramAccessService;
  externalRequestHandler: SupportPassportExternalRequestHandler;
  close(): void;
}

export function createSupportPassportServerRuntime(
  orchestrator: Orchestrator,
  config: PluginConfig,
  fallbackHandler?: SupportPassportExternalRequestHandler,
): SupportPassportServerRuntime {
  const bridge =
    config.supportPassport.enabled && config.modelSource === "gateway"
      ? new SupportPassportModelBridge()
      : null;
  return {
    service: new EngramAccessService(orchestrator, {
      supportPassportGatewayRoute: bridge?.route,
    }),
    externalRequestHandler: composeSupportPassportExternalRequestHandlers(
      bridge?.requestHandler,
      fallbackHandler,
    ),
    close: () => bridge?.close(),
  };
}
