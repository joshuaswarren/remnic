import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { LocalLlmClient } from "./local-llm.js";
import { orderedLocalServers } from "./local-llm-servers.js";
import type { PluginConfig } from "./types.js";

/**
 * A LiteLLM proxy answers `GET /` with the JSON string "LiteLLM: RUNNING" and
 * runs a live completion against every deployment in its pool on `GET /health`.
 * The availability probe must classify LiteLLM from `/` and never reach
 * `/health`; before this test the once-a-minute probe was the largest load
 * source on the pool behind the proxy.
 */

function createConfig(localLlmUrl: string): PluginConfig {
  return {
    localLlmEnabled: true,
    localLlmModel: "test-local-model",
    localLlmUrl,
    localLlmTimeoutMs: 1_000,
    localLlmRetry5xxCount: 0,
    localLlmRetryBackoffMs: 1,
    localLlmHeaders: {},
    localLlmApiKey: undefined,
    localLlmAuthHeader: false,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 60_000,
    debug: false,
    localLlmReasoningEffort: "none",
    slowLogEnabled: false,
    slowLogThresholdMs: 1_000,
  } as unknown as PluginConfig;
}

async function startServer(
  handle: (path: string, res: http.ServerResponse) => void,
): Promise<{ url: string; paths: string[]; close(): Promise<void> }> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    paths.push(path);
    handle(path, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    paths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function startLiteLlmShapedServer() {
  return startServer((path, res) => {
    if (path === "/") return json(res, "LiteLLM: RUNNING");
    if (path === "/v1/models") return json(res, { data: [{ id: "test-local-model" }] });
    json(res, { healthy_endpoints: [], unhealthy_endpoints: [] });
  });
}

test("a LiteLLM proxy is detected from GET / and /health is never probed", async () => {
  const server = await startLiteLlmShapedServer();
  try {
    const client = new LocalLlmClient(createConfig(server.url));
    assert.equal(await client.checkAvailability(), true);
    assert.equal(client.getDetectedType(), "litellm");
    assert.ok(!server.paths.includes("/health"), `probe hit /health: ${server.paths.join(", ")}`);
    assert.equal(server.paths.filter((p) => p === "/").length, 1, "GET / must be fetched once per pass");
  } finally {
    await server.close();
  }
});

test("LiteLLM is probed first even when the port matches llama.cpp or vLLM", () => {
  for (const port of [8080, 8000, 11434, 1234, 4000]) {
    const order = orderedLocalServers(`http://127.0.0.1:${port}/v1`).map((s) => s.type);
    assert.equal(order[0], "litellm", `port ${port}: ${order.join(" > ")}`);
  }
  const llamaFirst = orderedLocalServers("http://127.0.0.1:8080/v1").map((s) => s.type);
  assert.equal(llamaFirst[1], "llamacpp", "port priority still applies after LiteLLM");
});

test("a root response is fetched once even when a later detector matches it", async () => {
  const server = await startServer((path, res) => {
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
      return;
    }
    json(res, {});
  });
  try {
    const client = new LocalLlmClient(createConfig(server.url));
    assert.equal(await client.checkAvailability(), true);
    assert.equal(client.getDetectedType(), "ollama");
    assert.equal(server.paths.filter((p) => p === "/").length, 1, `paths: ${server.paths.join(", ")}`);
  } finally {
    await server.close();
  }
});
