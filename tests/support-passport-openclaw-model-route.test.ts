import assert from "node:assert/strict";
import test from "node:test";

import { Orchestrator } from "@remnic/core/orchestrator";
import { EngramAccessService } from "../src/access-service.js";
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

test("the OpenClaw access service keeps a gateway fallback in plugin mode", async () => {
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
  const service = new EngramAccessService(new Orchestrator(config));

  assert.equal(service.supportPassportGatewayRouteRef?.kind, "gateway");
});
