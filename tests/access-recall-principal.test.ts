import test from "node:test";
import assert from "node:assert/strict";

import { EngramAccessHttpServer } from "../src/access-http.js";
import { EngramMcpServer } from "../src/access-mcp.js";
import type {
  EngramAccessRecallRequest,
  EngramAccessRecallResponse,
  EngramAccessService,
} from "../src/access-service.js";

function recallResponse(request: EngramAccessRecallRequest): EngramAccessRecallResponse {
  return {
    query: request.query,
    ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
    namespace: request.namespace ?? "global",
    context: "",
    count: 0,
    memoryIds: [],
    results: [],
    fallbackUsed: false,
    sourcesUsed: [],
    disclosure: "chunk",
  };
}

function fakeService(capture: { recall?: EngramAccessRecallRequest }): EngramAccessService {
  return {
    briefingEnabled: false,
    recall: async (request: EngramAccessRecallRequest) => {
      capture.recall = { ...request };
      return recallResponse(request);
    },
  } as unknown as EngramAccessService;
}

test("HTTP recall forwards the authenticated transport principal", async () => {
  const capture: { recall?: EngramAccessRecallRequest } = {};
  const server = new EngramAccessHttpServer({
    service: fakeService(capture),
    authToken: "test-token",
    principal: "tenant-a",
    port: 0,
  });
  const status = await server.start();
  try {
    const response = await fetch(`http://${status.host}:${status.port}/engram/v1/recall`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: "what matters here?",
        namespace: "work",
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(capture.recall?.authenticatedPrincipal, "tenant-a");
    assert.equal(capture.recall?.namespace, "work");
  } finally {
    await server.stop();
  }
});

test("MCP recall forwards the effective transport principal", async () => {
  const capture: { recall?: EngramAccessRecallRequest } = {};
  const server = new EngramMcpServer(fakeService(capture));

  const response = await server.handleRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "engram.recall",
        arguments: {
          query: "what matters here?",
          namespace: "work",
        },
      },
    },
    { principalOverride: "tenant-a" },
  );

  assert.equal((response?.result as { isError?: boolean } | undefined)?.isError, false);
  assert.equal(capture.recall?.authenticatedPrincipal, "tenant-a");
  assert.equal(capture.recall?.namespace, "work");
});
