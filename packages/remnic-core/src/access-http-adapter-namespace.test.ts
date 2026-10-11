import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessService, type EngramAccessRecallRequest, type EngramAccessRecallResponse } from "./access-service.js";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import type { PluginConfig } from "./types.js";

const FLAT_ADAPTER_IDS = ["claude-code", "codex", "replit", "grok", "opencode", "hermes"];

const NAMESPACED_ADAPTERS = [
  { clientId: "claude-code", principal: "claude-code" },
  { clientId: "codex", principal: "codex" },
  { clientId: "replit", principal: "replit-agent" },
  { clientId: "grok", principal: "grok" },
  { clientId: "opencode", principal: "opencode" },
  { clientId: "hermes", principal: "hermes-agent" },
];

interface TestDaemon {
  service: EngramAccessService;
  port: number;
  close(): Promise<void>;
}

function makeConfig(memoryDir: string, overrides: Partial<PluginConfig> = {}) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    initGateTimeoutMs: 1000,
    ...overrides,
  });
}

async function startServer(overrides: Partial<PluginConfig> = {}): Promise<TestDaemon> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-3166-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir, overrides));
  const service = new EngramAccessService(orchestrator);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    adminConsoleEnabled: false,
  });
  const { port } = await server.start();
  return {
    service,
    port,
    async close() {
      await server.stop();
      await rm(memoryDir, { recursive: true, force: true });
    },
  };
}

interface RecallOutcome {
  status: number;
  isError: boolean;
  text: string;
  payload?: EngramAccessRecallResponse;
}

interface McpToolReply {
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
}

async function mcpRecall(
  port: number,
  args: EngramAccessRecallRequest,
  headers: Record<string, string> = {},
): Promise<RecallOutcome> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "engram.recall", arguments: args },
    }),
  });
  const body: McpToolReply = JSON.parse(await res.text());
  const text = body.result?.content?.[0]?.text ?? "";
  const outcome: RecallOutcome = {
    status: res.status,
    isError: body.result?.isError === true,
    text,
  };
  if (!outcome.isError) outcome.payload = JSON.parse(text);
  return outcome;
}

test("flat daemon: all six built-in adapters resolve the configured default namespace over MCP recall", async () => {
  const daemon = await startServer({
    namespacesEnabled: false,
    defaultNamespace: "flat-tenant",
  });
  try {
    await daemon.service.memoryStore({ content: "the launch codeword is PERIHELION" });
    for (const clientId of FLAT_ADAPTER_IDS) {
      const outcome = await mcpRecall(
        daemon.port,
        { query: "launch codeword" },
        { "x-engram-client-id": clientId },
      );
      assert.equal(outcome.status, 200, `${clientId}: recall must reach the op`);
      assert.equal(outcome.isError, false, `${clientId}: ${outcome.text}`);
      assert.equal(outcome.payload?.namespace, "flat-tenant", `${clientId}: default namespace`);
      assert.ok(
        outcome.payload?.context.includes("PERIHELION"),
        `${clientId}: default-namespace memory must be recalled`,
      );
    }
  } finally {
    await daemon.close();
  }
});

test("flat daemon: explicit X-Engram-Namespace is enforced, not silently dropped", async () => {
  const daemon = await startServer({
    namespacesEnabled: false,
    defaultNamespace: "flat-tenant",
  });
  try {
    await daemon.service.memoryStore({ content: "the launch codeword is PERIHELION" });

    const validDefault = await mcpRecall(daemon.port, { query: "launch codeword" }, {
      "x-engram-client-id": "claude-code",
      "x-engram-namespace": "flat-tenant",
    });
    assert.equal(validDefault.isError, false, validDefault.text);
    assert.equal(validDefault.payload?.namespace, "flat-tenant");
    assert.ok(validDefault.payload?.context.includes("PERIHELION"));

    for (const outcome of [
      await mcpRecall(daemon.port, { query: "launch codeword" }, {
        "x-engram-client-id": "claude-code",
        "x-engram-namespace": "off-books",
      }),
      await mcpRecall(daemon.port, { query: "launch codeword", namespace: "off-books" }, {
        "x-engram-client-id": "claude-code",
      }),
    ]) {
      assert.equal(outcome.isError, true, "non-default namespace must be rejected");
      assert.match(outcome.text, /unsupported namespace: off-books/);
    }
  } finally {
    await daemon.close();
  }
});

test("namespaced daemon: adapters keep their self-namespaces over MCP recall", async () => {
  const daemon = await startServer({
    namespacesEnabled: true,
    defaultNamespace: "main",
    namespacePolicies: NAMESPACED_ADAPTERS.map(({ clientId, principal }) => ({
      name: clientId,
      readPrincipals: [principal],
      writePrincipals: [principal],
    })),
  });
  try {
    await daemon.service.memoryStore({
      content: "main vault code is QUASAR-main",
      namespace: "main",
      authenticatedPrincipal: "operator",
    });
    for (const { clientId, principal } of NAMESPACED_ADAPTERS) {
      await daemon.service.memoryStore({
        content: `the ${clientId} vault code is NOVA-${clientId}`,
        namespace: clientId,
        authenticatedPrincipal: principal,
      });
    }

    for (const { clientId } of NAMESPACED_ADAPTERS) {
      const outcome = await mcpRecall(daemon.port, { query: "vault code" }, {
        "x-engram-client-id": clientId,
      });
      assert.equal(outcome.status, 200, `${clientId}: recall must reach the op`);
      assert.equal(outcome.isError, false, `${clientId}: ${outcome.text}`);
      assert.equal(outcome.payload?.namespace, clientId, `${clientId}: self-namespace kept`);
      assert.ok(
        outcome.payload?.context.includes(`NOVA-${clientId}`),
        `${clientId}: own namespace memory must be recalled`,
      );
      assert.ok(
        !outcome.payload?.context.includes("QUASAR-main"),
        `${clientId}: default namespace must stay isolated`,
      );
    }

    const crossTenant = await mcpRecall(daemon.port, { query: "vault code" }, {
      "x-engram-client-id": "claude-code",
    });
    assert.ok(
      !crossTenant.payload?.context.includes("NOVA-codex"),
      "one adapter's namespace must not leak into another's recall",
    );
  } finally {
    await daemon.close();
  }
});
