import test from "node:test";
import assert from "node:assert/strict";
import { EngramMcpServer } from "../src/access-mcp.js";
import type { EngramAccessService } from "../src/access-service.js";

function fakeService(capture: { calls: unknown[] }): EngramAccessService {
  return {
    actionConfidence: async (request: unknown) => {
      capture.calls.push(request);
      return {
        schemaVersion: 1,
        decision: "ask",
        confidence: 0.42,
        risk: "medium",
        contextReadiness: "partial",
        attentionPolicy: "interruption_budgeting",
        principle: "A good agent should spend the user's attention carefully.",
        reasons: ["test"],
        blockers: [],
        factors: [],
        retrievedMemoryCount: 0,
        usableMemoryCount: 0,
        staleMemoryCount: 0,
        correctedMemoryCount: 0,
        scopeMismatchCount: 0,
        safeToAct: false,
      };
    },
  } as unknown as EngramAccessService;
}

test("MCP advertises action_confidence under engram and remnic names", async () => {
  const server = new EngramMcpServer(fakeService({ calls: [] }));
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

  const tools = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const names = (tools?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);

  assert.ok(names.includes("engram.action_confidence"));
  assert.ok(names.includes("remnic.action_confidence"));
});

test("MCP action_confidence validates and dispatches to service", async () => {
  const capture = { calls: [] as unknown[] };
  const server = new EngramMcpServer(fakeService(capture));
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "remnic.action_confidence",
      arguments: {
        confidence: 0.74,
        risk: "medium",
        contextReadiness: "partial",
        userRules: [{ kind: "ask-before", description: "Ask before checkout." }],
      },
    },
  });

  const result = response?.result as {
    isError?: boolean;
    structuredContent?: { decision?: string; attentionPolicy?: string };
  };
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.decision, "ask");
  assert.equal(result.structuredContent?.attentionPolicy, "interruption_budgeting");
  assert.deepEqual(capture.calls, [
    {
      confidence: 0.74,
      risk: "medium",
      contextReadiness: "partial",
      userRules: [{ kind: "ask-before", description: "Ask before checkout." }],
    },
  ]);
});

test("MCP action_confidence rejects unknown risk values before service dispatch", async () => {
  const capture = { calls: [] as unknown[] };
  const server = new EngramMcpServer(fakeService(capture));
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "engram.action_confidence",
      arguments: {
        confidence: 0.74,
        risk: "maybe",
      },
    },
  });

  const result = response?.result as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  assert.equal(result.isError, true);
  assert.match(String(result.content?.[0]?.text ?? ""), /Invalid enum value/);
  assert.equal(capture.calls.length, 0);
});
