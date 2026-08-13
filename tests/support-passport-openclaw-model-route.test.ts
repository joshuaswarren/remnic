import assert from "node:assert/strict";
import test from "node:test";

import { Orchestrator } from "@remnic/core/orchestrator";
import type { SupportPassportModelRoute } from "@remnic/core";
import {
  EngramAccessService,
  createConfiguredSupportPassportGatewayRoute,
} from "../src/access-service.js";
import { parseConfig } from "../src/config.js";

test("the OpenClaw access service injects its gateway route without a direct OpenAI key", async () => {
  const config = parseConfig({
    modelSource: "gateway",
    openaiApiKey: false,
    taskModelChain: { primary: "gateway/local-model" },
    gatewayConfig: {
      agents: { defaults: { model: { primary: "gateway/local-model" } } },
      models: {
        providers: {
          gateway: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            models: [{ id: "local-model", name: "local-model" }],
          },
        },
      },
    },
  });
  const service = new EngramAccessService(new Orchestrator(config));

  assert.equal(service.supportPassportGatewayRouteRef?.kind, "gateway");
});

test("plugin mode keeps the configured gateway fallback for delegate workers", () => {
  const config = parseConfig({
    modelSource: "plugin",
    openaiApiKey: false,
    localLlmEnabled: true,
    localLlmFallback: true,
    gatewayConfig: {
      agents: { defaults: { model: { primary: "gateway/local-model" } } },
      models: {
        providers: {
          gateway: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            models: [{ id: "local-model", name: "local-model" }],
          },
        },
      },
    },
  });
  assert.equal(createConfiguredSupportPassportGatewayRoute(config)?.kind, "gateway");
});

test("the OpenClaw access service preserves an explicitly injected gateway route", () => {
  const route: SupportPassportModelRoute = {
    kind: "gateway",
    invoke: async () => ({ content: "{}", modelUsed: "injected/model" }),
  };
  const config = parseConfig({
    modelSource: "gateway",
    openaiApiKey: false,
  });
  const service = new EngramAccessService(new Orchestrator(config), {
    supportPassportGatewayRoute: route,
  });

  assert.equal(service.supportPassportGatewayRouteRef, route);
});
