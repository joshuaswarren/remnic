import {
  EngramAccessService,
  type Orchestrator,
  type PluginConfig,
  type SupportPassportExternalRequestHandler,
  SupportPassportModelBridge,
  composeSupportPassportExternalRequestHandlers,
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
  accessOptions?: { reviewDeckEnabled?: boolean },
): SupportPassportServerRuntime {
  const bridge = config.supportPassport.enabled ? new SupportPassportModelBridge() : null;
  const serviceOptions = {
    supportPassportGatewayRoute: bridge?.route,
    reviewDeckEnabled: accessOptions?.reviewDeckEnabled === true,
  };
  return {
    service: new EngramAccessService(orchestrator, serviceOptions),
    externalRequestHandler: composeSupportPassportExternalRequestHandlers(bridge?.requestHandler, fallbackHandler),
    close: () => bridge?.close(),
  };
}
