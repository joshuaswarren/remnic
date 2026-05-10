import test from "node:test";
import assert from "node:assert/strict";
import {
  REMNIC_CHATGPT_MEMORY_INSPECTOR_CANONICAL_TOOL,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
  type RemnicChatGptMemoryInspectorResult,
} from "../src/mcp-memory-inspector-app.js";
import { EngramMcpServer } from "../src/access-mcp.js";
import type { EngramAccessService } from "../src/access-service.js";

interface Capture {
  recalls: Array<Record<string, unknown>>;
  xrays: Array<Record<string, unknown>>;
  actionRequests: Array<Record<string, unknown>>;
}

function fakeService(capture: Capture): EngramAccessService {
  return {
    recall: async (request: Record<string, unknown>) => {
      capture.recalls.push({ ...request });
      return {
        query: String(request.query ?? ""),
        sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : undefined,
        namespace: typeof request.namespace === "string" ? request.namespace : "global",
        context: "Prefers concise, implementation-focused updates.",
        count: 1,
        memoryIds: ["mem-preference-1"],
        results: [
          {
            id: "mem-preference-1",
            path: "preferences/2026-05-01/update-style.md",
            category: "preference",
            status: "active",
            preview: "Prefers concise, implementation-focused updates.",
          },
        ],
        fallbackUsed: false,
        sourcesUsed: ["memories"],
        disclosure: "chunk",
      };
    },
    recallXray: async (request: Record<string, unknown>) => {
      capture.xrays.push({ ...request });
      return {
        snapshotFound: true,
        snapshot: {
          schemaVersion: "1" as const,
          query: String(request.query ?? ""),
          snapshotId: "snap-chatgpt-app",
          capturedAt: 1_779_000_000_000,
          tierExplain: null,
          results: [
            {
              memoryId: "mem-preference-1",
              path: "preferences/2026-05-01/update-style.md",
              servedBy: "hybrid" as const,
              scoreDecomposition: { final: 0.91 },
              admittedBy: ["scope-match", "fresh"],
              provenance: {
                source: "conversation",
                created: "2026-05-01T10:00:00.000Z",
                updated: "2026-05-01T10:00:00.000Z",
                namespace: "work",
                scope: "namespace:work",
                userContextScopes: ["work", "repo"],
                retrievalReason: "hybrid match",
                confidence: 0.83,
                stale: false,
                corrected: false,
                correctionState: "none" as const,
                safeToUse: true,
                safety: "safe" as const,
                safetyReasons: [],
              },
            },
          ],
          filters: [],
          budget: { chars: 4096, used: 51 },
          namespace: typeof request.namespace === "string" ? request.namespace : "global",
          sessionKey: typeof request.sessionKey === "string" ? request.sessionKey : undefined,
        },
      };
    },
    actionConfidence: async (request: Record<string, unknown>) => {
      capture.actionRequests.push(JSON.parse(JSON.stringify(request)) as Record<string, unknown>);
      return {
        schemaVersion: 1,
        decision: "draft",
        confidence: 0.83,
        risk: "medium",
        contextReadiness: "sufficient",
        intendedAction: String(request.intendedAction ?? ""),
        attentionPolicy: "interruption_budgeting",
        principle: "A good agent should spend the user's attention carefully.",
        reasons: ["relevant scoped memory"],
        blockers: [],
        factors: [],
        retrievedMemoryCount: 1,
        usableMemoryCount: 1,
        staleMemoryCount: 0,
        correctedMemoryCount: 0,
        scopeMismatchCount: 0,
        safeToAct: false,
      };
    },
  } as unknown as EngramAccessService;
}

function resultText(response: unknown): string {
  const result = response as { result?: { content?: Array<{ text?: string }> } };
  return result.result?.content?.[0]?.text ?? "";
}

test("ChatGPT Apps inspector advertises app-compatible tool metadata and aliases", async () => {
  const server = new EngramMcpServer(fakeService({ recalls: [], xrays: [], actionRequests: [] }));
  const init = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.deepEqual((init?.result as { capabilities: Record<string, unknown> }).capabilities.resources, {});

  const toolsResponse = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const tools = (toolsResponse?.result as { tools: Array<Record<string, unknown>> }).tools;
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes(REMNIC_CHATGPT_MEMORY_INSPECTOR_CANONICAL_TOOL));
  assert.ok(names.includes(REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL));

  const descriptor = tools.find(
    (tool) => tool.name === REMNIC_CHATGPT_MEMORY_INSPECTOR_CANONICAL_TOOL,
  ) as {
    title?: string;
    annotations?: Record<string, unknown>;
    outputSchema?: { properties?: Record<string, unknown> };
    _meta?: Record<string, unknown>;
  };
  assert.equal(descriptor.title, "Show Remnic Memory Inspector");
  assert.deepEqual(descriptor.outputSchema?.properties?.sessionKey, { type: "string" });
  assert.deepEqual(descriptor.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.equal(
    (descriptor._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri,
    REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
  );
  assert.equal(
    descriptor._meta?.["openai/outputTemplate"],
    REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
  );
});

test("ChatGPT Apps inspector serves a widget resource over MCP resources/read", async () => {
  const server = new EngramMcpServer(fakeService({ recalls: [], xrays: [], actionRequests: [] }));
  const resourcesResponse = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/list",
    params: {},
  });
  const resources = (resourcesResponse?.result as { resources: Array<Record<string, unknown>> })
    .resources;
  const resource = resources.find(
    (entry) => entry.uri === REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
  );
  assert.equal(resource?.mimeType, REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE);
  assert.deepEqual(
    ((resource?._meta as { ui?: { csp?: unknown } } | undefined)?.ui?.csp),
    { connectDomains: [], resourceDomains: [] },
  );

  const readResponse = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "resources/read",
    params: { uri: REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI },
  });
  const contents = (readResponse?.result as {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }).contents;
  assert.equal(contents[0]?.uri, REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI);
  assert.equal(contents[0]?.mimeType, REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE);
  assert.match(contents[0]?.text ?? "", /ui\/notifications\/tool-result/);
  assert.match(contents[0]?.text ?? "", /window\.openai/);
  assert.match(contents[0]?.text ?? "", /sendFollowUpMessage/);
});

test("ChatGPT Apps inspector dispatches canonical alias through recall, X-ray, and action confidence", async () => {
  const capture: Capture = { recalls: [], xrays: [], actionRequests: [] };
  const server = new EngramMcpServer(fakeService(capture), { principal: "user-a" });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: REMNIC_CHATGPT_MEMORY_INSPECTOR_CANONICAL_TOOL,
      arguments: {
        query: " What preferences matter here? ",
        sessionKey: "sess-1",
        namespace: "work",
        currentContextScopes: ["work", "repo"],
      },
    },
  });

  const result = response?.result as {
    isError?: boolean;
    structuredContent?: RemnicChatGptMemoryInspectorResult;
  };
  assert.equal(result.isError, false);
  const structured = result.structuredContent;
  assert.ok(structured, "expected structured content");
  assert.equal(structured.app.resourceUri, REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI);
  assert.equal(structured.query, "What preferences matter here?");
  assert.equal(structured.namespace, "work");
  assert.equal(structured.safeRecallPreview, "Prefers concise, implementation-focused updates.");
  assert.equal(structured.memoryCount, 1);
  assert.deepEqual(structured.memoryIds, ["mem-preference-1"]);
  assert.equal(structured.memories[0]?.source, "conversation");
  assert.equal(structured.memories[0]?.scope, "namespace:work");
  assert.equal(structured.memories[0]?.retrievalReason, "hybrid match");
  assert.equal(structured.memories[0]?.safeToUse, true);
  assert.equal(structured.actionConfidence.decision, "draft");
  assert.equal(structured.affordances.length, 4);

  assert.deepEqual(capture.recalls, [
    {
      query: "What preferences matter here?",
      sessionKey: "sess-1",
      namespace: "work",
      mode: "full",
      disclosure: "chunk",
    },
  ]);
  assert.deepEqual(capture.xrays, [
    {
      query: "What preferences matter here?",
      sessionKey: "sess-1",
      namespace: "work",
      authenticatedPrincipal: "user-a",
    },
  ]);
  assert.equal(capture.actionRequests[0]?.risk, "medium");
  assert.equal(capture.actionRequests[0]?.confidence, 0.83);
  assert.deepEqual(capture.actionRequests[0]?.currentContextScopes, ["work", "repo"]);
  assert.equal(
    (capture.actionRequests[0]?.retrievedMemories as Array<Record<string, unknown>>)[0]?.source,
    "conversation",
  );
});

test("ChatGPT Apps inspector rejects malformed currentContextScopes before service dispatch", async () => {
  const capture: Capture = { recalls: [], xrays: [], actionRequests: [] };
  const server = new EngramMcpServer(fakeService(capture));
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL,
      arguments: {
        query: "q",
        currentContextScopes: ["work", 42],
      },
    },
  });
  assert.match(resultText(response), /currentContextScopes must be an array of strings/);
  assert.deepEqual(capture, { recalls: [], xrays: [], actionRequests: [] });
});
