/**
 * MCP dispatch tests for `engram.recall_xray` / `remnic.recall_xray`
 * (issue #570 PR 5).  Verifies that:
 *  - the tool is advertised under BOTH the legacy `engram.*` and the
 *    canonical `remnic.*` names (dual-naming invariant);
 *  - both aliases dispatch to the same service method with the same
 *    payload;
 *  - required field validation + namespace threading work.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EngramMcpServer } from "@remnic/core/access-mcp";
import type { EngramAccessService } from "../src/access-service.js";

function fakeService(capture: {
  calls: Array<{
    query: string;
    sessionKey?: string;
    namespace?: string;
    budget?: number;
    authenticatedPrincipal?: string;
  }>;
}): EngramAccessService {
  return {
    recallXray: async (req: {
      query: string;
      sessionKey?: string;
      namespace?: string;
      budget?: number;
      authenticatedPrincipal?: string;
    }) => {
      capture.calls.push({ ...req });
      return {
        snapshotFound: true,
        snapshot: {
          schemaVersion: "1" as const,
          query: req.query,
          snapshotId: "snap-xray-1",
          capturedAt: 1_700_000_000_000,
          tierExplain: null,
          results: [],
          filters: [],
          budget: { chars: 4096, used: 0 },
        },
      };
    },
  } as unknown as EngramAccessService;
}

test("MCP advertises both engram.recall_xray and remnic_recall_xray", async () => {
  const server = new EngramMcpServer(fakeService({ calls: [] }));
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const tools = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const names = (tools?.result as { tools: Array<{ name: string }> }).tools.map(
    (t) => t.name,
  );
  assert.ok(names.includes("engram.recall_xray"), "legacy engram.* name is advertised");
  assert.ok(names.includes("remnic_recall_xray"), "canonical remnic_* alias is advertised");
});

test("MCP engram.recall_xray dispatches to recallXray with threaded params", async () => {
  const capture = { calls: [] as any[] };
  const server = new EngramMcpServer(fakeService(capture));
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "engram.recall_xray",
      arguments: {
        query: "what editor do I use",
        sessionKey: "sess-42",
        namespace: "team-a",
        budget: 2048,
      },
    },
  });
  const result = response?.result as {
    structuredContent: { snapshotFound: boolean; snapshot?: { query: string } };
  };
  assert.equal(result.structuredContent.snapshotFound, true);
  assert.equal(result.structuredContent.snapshot?.query, "what editor do I use");

  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].query, "what editor do I use");
  assert.equal(capture.calls[0].sessionKey, "sess-42");
  assert.equal(capture.calls[0].namespace, "team-a");
  assert.equal(capture.calls[0].budget, 2048);
});

test("MCP remnic.recall_xray alias dispatches identically", async () => {
  const capture = { calls: [] as any[] };
  const server = new EngramMcpServer(fakeService(capture));
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "remnic.recall_xray",
      arguments: { query: "q" },
    },
  });
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].query, "q");
});

test("MCP engram.recall_xray coerces string budget to integer", async () => {
  const capture = { calls: [] as any[] };
  const server = new EngramMcpServer(fakeService(capture));
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "engram.recall_xray",
      arguments: { query: "q", budget: "2048" },
    },
  });
  assert.equal(capture.calls[0].budget, 2048);
});

test("MCP engram.recall_xray rejects invalid budget with a listed-options error", async () => {
  const capture = { calls: [] as any[] };
  const server = new EngramMcpServer(fakeService(capture));
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "engram.recall_xray",
      arguments: { query: "q", budget: -1 },
    },
  });
  // MCP wraps handler errors in `result.isError=true` with a text
  // content node carrying the message.
  const result = response?.result as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  assert.equal(result.isError, true, "expected an error response");
  assert.match(
    String(result.content?.[0]?.text ?? ""),
    /budget expects a positive integer/,
  );
  assert.equal(capture.calls.length, 0, "service must NOT be called when validation fails");
});

test("MCP engram.recall_xray rejects non-string non-number budgets (e.g., booleans, objects)", async () => {
  // Codex P2 on #604: `Number(true)` coerces to 1, so accepting
  // boolean values would silently force a tiny recall budget.  The
  // MCP handler must reject typed-incorrectly inputs up front instead
  // of coercing them.  This exercises the boolean and object cases.
  const capture = { calls: [] as any[] };
  const server = new EngramMcpServer(fakeService(capture));
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  for (const badBudget of [true, false, { v: 1 }, [4096]]) {
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "engram.recall_xray",
        arguments: { query: "q", budget: badBudget as unknown },
      },
    });
    const result = response?.result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    assert.equal(
      result.isError,
      true,
      `expected an error response for budget=${JSON.stringify(badBudget)}`,
    );
    assert.match(
      String(result.content?.[0]?.text ?? ""),
      /budget expects a positive integer/,
    );
  }
  assert.equal(capture.calls.length, 0, "service must NOT be called when validation fails");
});
