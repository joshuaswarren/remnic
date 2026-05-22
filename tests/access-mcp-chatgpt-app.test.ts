import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChatGptMemoryInspectorActionRequest,
  buildChatGptMemoryInspectorResult,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_CANONICAL_TOOL,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL,
  REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
  type RemnicChatGptMemoryInspectorResult,
} from "../src/mcp-memory-inspector-app.js";
import { EngramMcpServer } from "../src/access-mcp.js";
import type {
  EngramAccessRecallResponse,
  EngramAccessService,
} from "../src/access-service.js";

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
      const recall = {
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
        recall,
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

  const templatesResponse = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/templates/list",
    params: {},
  });
  assert.deepEqual(
    (templatesResponse?.result as { resourceTemplates: unknown[] }).resourceTemplates,
    [],
  );

  const readResponse = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri: REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI },
  });
  const contents = (readResponse?.result as {
    contents: Array<{
      uri: string;
      mimeType: string;
      text: string;
      _meta?: Record<string, unknown>;
    }>;
  }).contents;
  assert.equal(contents[0]?.uri, REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI);
  assert.equal(contents[0]?.mimeType, REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE);
  assert.deepEqual(
    ((contents[0]?._meta as { ui?: { csp?: unknown } } | undefined)?.ui?.csp),
    { connectDomains: [], resourceDomains: [] },
  );
  assert.equal(
    contents[0]?._meta?.["openai/widgetDescription"],
    "Inspect retrieved Remnic memories, provenance, safety, and correction/scoping affordances.",
  );
  assert.match(contents[0]?.text ?? "", /ui\/notifications\/tool-result/);
  assert.match(contents[0]?.text ?? "", /window\.openai/);
  assert.match(contents[0]?.text ?? "", /sendFollowUpMessage/);
});

test("ChatGPT Apps inspector dispatches canonical alias through X-ray and action confidence", async () => {
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

  assert.deepEqual(capture.recalls, []);
  assert.deepEqual(capture.xrays, [
    {
      query: "What preferences matter here?",
      sessionKey: "sess-1",
      namespace: "work",
      currentContextScopes: ["work", "repo"],
      authenticatedPrincipal: "user-a",
      mode: "full",
      disclosure: "chunk",
      includeRecall: true,
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

test("ChatGPT Apps inspector uses internal session metadata for sessionless authenticated calls", async () => {
  const capture: Capture = { recalls: [], xrays: [], actionRequests: [] };
  const server = new EngramMcpServer(fakeService(capture), { principal: "user-a" });

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: REMNIC_CHATGPT_MEMORY_INSPECTOR_CANONICAL_TOOL,
      arguments: {
        query: "What preferences matter here?",
        namespace: "work",
      },
    },
  });

  const result = response?.result as {
    isError?: boolean;
    structuredContent?: RemnicChatGptMemoryInspectorResult;
  };
  assert.equal(result.isError, false);
  assert.ok(result.structuredContent, "expected structured content");
  assert.equal(result.structuredContent.sessionKey, undefined);
  assert.equal(result.structuredContent.memoryCount, 1);
  assert.deepEqual(result.structuredContent.memoryIds, ["mem-preference-1"]);

  assert.deepEqual(capture.recalls, []);
  const recallSessionKey = capture.xrays[0]?.sessionKey;
  assert.equal(typeof recallSessionKey, "string");
  assert.match(String(recallSessionKey), /^remnic:chatgpt-memory-inspector:/);
  assert.notEqual(recallSessionKey, "user-a");
});

test("ChatGPT Apps inspector withholds preview when blocked memory is beyond visible cards", () => {
  const recallResults = Array.from({ length: 9 }, (_, index) => ({
    id: `mem-${index + 1}`,
    path: `memories/mem-${index + 1}.md`,
    category: "preference",
    status: "active",
    preview: index === 8 ? "blocked private detail" : `safe preview ${index + 1}`,
  }));
  const xrayResults = recallResults.map((memory, index) => ({
    memoryId: memory.id,
    path: memory.path,
    servedBy: "hybrid" as const,
    scoreDecomposition: { final: 0.9 },
    admittedBy: ["test"],
    provenance: {
      source: "conversation",
      scope: "namespace:work",
      userContextScopes: ["work"],
      retrievalReason: "test",
      confidence: 0.9,
      stale: false,
      corrected: false,
      correctionState: "none" as const,
      safeToUse: index !== 8,
      safety: index === 8 ? ("blocked" as const) : ("safe" as const),
      safetyReasons: index === 8 ? ["blocked in current context"] : [],
    },
  }));
  const recall: EngramAccessRecallResponse = {
    query: "show preferences",
    namespace: "work",
    context: "safe public detail\nblocked private detail",
    count: 9,
    memoryIds: recallResults.map((memory) => memory.id),
    results: recallResults,
    fallbackUsed: false,
    sourcesUsed: ["memories"],
    disclosure: "chunk",
  };
  const result = buildChatGptMemoryInspectorResult(
    { query: "show preferences", namespace: "work" },
    recall,
    {
      schemaVersion: "1",
      query: "show preferences",
      snapshotId: "snap-blocked-after-visible-slice",
      capturedAt: 1_779_000_000_000,
      tierExplain: null,
      results: xrayResults,
      filters: [],
      budget: { chars: 4096, used: 100 },
      namespace: "work",
    },
    {
      schemaVersion: 1,
      decision: "ask",
      confidence: 0.5,
      risk: "medium",
      contextReadiness: "partial",
      attentionPolicy: "interruption_budgeting",
      principle: "A good agent should spend the user's attention carefully.",
      reasons: [],
      blockers: [],
      factors: [],
      retrievedMemoryCount: 9,
      usableMemoryCount: 8,
      staleMemoryCount: 0,
      correctedMemoryCount: 0,
      scopeMismatchCount: 1,
      safeToAct: false,
    },
  );

  assert.equal(result.memories.length, 8);
  assert.match(result.safeRecallPreview, /1 retrieved memory is blocked/);
  assert.doesNotMatch(result.safeRecallPreview, /blocked private detail/);
});

test("ChatGPT Apps inspector redacts blocked visible memory card previews", () => {
  const recall: EngramAccessRecallResponse = {
    query: "show preferences",
    namespace: "work",
    context: "blocked private detail",
    count: 1,
    memoryIds: ["mem-blocked"],
    results: [
      {
        id: "mem-blocked",
        path: "memories/mem-blocked.md",
        category: "preference",
        status: "active",
        preview: "blocked private detail",
      },
    ],
    fallbackUsed: false,
    sourcesUsed: ["memories"],
    disclosure: "chunk",
  };
  const result = buildChatGptMemoryInspectorResult(
    { query: "show preferences", namespace: "work" },
    recall,
    {
      schemaVersion: "1",
      query: "show preferences",
      snapshotId: "snap-visible-blocked",
      capturedAt: 1_779_000_000_000,
      tierExplain: null,
      results: [
        {
          memoryId: "mem-blocked",
          path: "memories/mem-blocked.md",
          servedBy: "hybrid",
          scoreDecomposition: { final: 0.9 },
          admittedBy: ["test"],
          provenance: {
            source: "conversation",
            scope: "namespace:work/private",
            userContextScopes: ["private"],
            retrievalReason: "test",
            confidence: 0.9,
            stale: false,
            corrected: false,
            correctionState: "none",
            safeToUse: false,
            safety: "blocked",
            safetyReasons: ["blocked in current context"],
          },
        },
      ],
      filters: [],
      budget: { chars: 4096, used: 100 },
      namespace: "work",
    },
    {
      schemaVersion: 1,
      decision: "ask",
      confidence: 0.5,
      risk: "medium",
      contextReadiness: "partial",
      attentionPolicy: "interruption_budgeting",
      principle: "A good agent should spend the user's attention carefully.",
      reasons: [],
      blockers: [],
      factors: [],
      retrievedMemoryCount: 1,
      usableMemoryCount: 0,
      staleMemoryCount: 0,
      correctedMemoryCount: 0,
      scopeMismatchCount: 1,
      safeToAct: false,
    },
  );

  assert.match(result.safeRecallPreview, /1 retrieved memory is blocked/);
  assert.match(result.memories[0]?.preview ?? "", /Preview withheld/);
  assert.doesNotMatch(result.memories[0]?.preview ?? "", /blocked private detail/);
});

test("ChatGPT Apps inspector matches X-ray provenance by path before duplicate ids", () => {
  const recall: EngramAccessRecallResponse = {
    query: "show preferences",
    namespace: "work",
    context: "blocked private detail\nsafe work detail",
    count: 2,
    memoryIds: ["mem-shared", "mem-shared"],
    results: [
      {
        id: "mem-shared",
        path: "private/mem-shared.md",
        category: "preference",
        status: "active",
        preview: "blocked private detail",
      },
      {
        id: "mem-shared",
        path: "work/mem-shared.md",
        category: "preference",
        status: "active",
        preview: "safe work detail",
      },
    ],
    fallbackUsed: false,
    sourcesUsed: ["memories"],
    disclosure: "chunk",
  };
  const result = buildChatGptMemoryInspectorResult(
    { query: "show preferences", namespace: "work" },
    recall,
    {
      schemaVersion: "1",
      query: "show preferences",
      snapshotId: "snap-duplicate-id-paths",
      capturedAt: 1_779_000_000_000,
      tierExplain: null,
      results: [
        {
          memoryId: "mem-shared",
          path: "private/mem-shared.md",
          servedBy: "hybrid",
          scoreDecomposition: { final: 0.9 },
          admittedBy: ["test"],
          provenance: {
            source: "conversation",
            scope: "namespace:private",
            userContextScopes: ["work"],
            retrievalReason: "test",
            confidence: 0.9,
            stale: false,
            corrected: false,
            correctionState: "none",
            safeToUse: false,
            safety: "blocked",
            safetyReasons: ["blocked in current context"],
          },
        },
        {
          memoryId: "mem-shared",
          path: "work/mem-shared.md",
          servedBy: "hybrid",
          scoreDecomposition: { final: 0.8 },
          admittedBy: ["test"],
          provenance: {
            source: "conversation",
            scope: "namespace:work",
            userContextScopes: ["work"],
            retrievalReason: "test",
            confidence: 0.8,
            stale: false,
            corrected: false,
            correctionState: "none",
            safeToUse: true,
            safety: "safe",
            safetyReasons: [],
          },
        },
      ],
      filters: [],
      budget: { chars: 4096, used: 100 },
      namespace: "work",
    },
    {
      schemaVersion: 1,
      decision: "ask",
      confidence: 0.5,
      risk: "medium",
      contextReadiness: "partial",
      attentionPolicy: "interruption_budgeting",
      principle: "A good agent should spend the user's attention carefully.",
      reasons: [],
      blockers: [],
      factors: [],
      retrievedMemoryCount: 2,
      usableMemoryCount: 1,
      staleMemoryCount: 0,
      correctedMemoryCount: 0,
      scopeMismatchCount: 1,
      safeToAct: false,
    },
  );

  assert.match(result.memories[0]?.preview ?? "", /Preview withheld/);
  assert.doesNotMatch(result.memories[0]?.preview ?? "", /blocked private detail/);
  assert.equal(result.memories[1]?.preview, "safe work detail");
});

test("ChatGPT Apps inspector pluralizes blocked memory preview messages", () => {
  const recall: EngramAccessRecallResponse = {
    query: "show preferences",
    namespace: "work",
    context: "blocked first detail\nblocked second detail",
    count: 2,
    memoryIds: ["mem-blocked-1", "mem-blocked-2"],
    results: [
      {
        id: "mem-blocked-1",
        path: "memories/mem-blocked-1.md",
        category: "preference",
        status: "active",
        preview: "blocked first detail",
      },
      {
        id: "mem-blocked-2",
        path: "memories/mem-blocked-2.md",
        category: "preference",
        status: "active",
        preview: "blocked second detail",
      },
    ],
    fallbackUsed: false,
    sourcesUsed: ["memories"],
    disclosure: "chunk",
  };
  const blockedXrayResults = recall.results.map((summary) => ({
    memoryId: summary.id,
    path: summary.path ?? "",
    servedBy: "hybrid" as const,
    scoreDecomposition: { final: 0.9 },
    admittedBy: ["test"],
    provenance: {
      source: "conversation",
      scope: "namespace:private",
      userContextScopes: ["work"],
      retrievalReason: "test",
      confidence: 0.9,
      stale: false,
      corrected: false,
      correctionState: "none" as const,
      safeToUse: false,
      safety: "blocked" as const,
      safetyReasons: ["blocked in current context"],
    },
  }));
  const result = buildChatGptMemoryInspectorResult(
    { query: "show preferences", namespace: "work" },
    recall,
    {
      schemaVersion: "1",
      query: "show preferences",
      snapshotId: "snap-two-blocked",
      capturedAt: 1_779_000_000_000,
      tierExplain: null,
      results: blockedXrayResults,
      filters: [],
      budget: { chars: 4096, used: 100 },
      namespace: "work",
    },
    {
      schemaVersion: 1,
      decision: "ask",
      confidence: 0.5,
      risk: "medium",
      contextReadiness: "partial",
      attentionPolicy: "interruption_budgeting",
      principle: "A good agent should spend the user's attention carefully.",
      reasons: [],
      blockers: [],
      factors: [],
      retrievedMemoryCount: 2,
      usableMemoryCount: 0,
      staleMemoryCount: 0,
      correctedMemoryCount: 0,
      scopeMismatchCount: 2,
      safeToAct: false,
    },
  );

  assert.match(result.safeRecallPreview, /2 retrieved memories are blocked/);
  assert.doesNotMatch(result.safeRecallPreview, /2 retrieved memory are blocked/);
});

test("ChatGPT Apps inspector withholds previews when X-ray provenance is unavailable", () => {
  const recall: EngramAccessRecallResponse = {
    query: "show preferences",
    namespace: "work",
    context: "unverified memory detail",
    count: 1,
    memoryIds: ["mem-unverified"],
    results: [
      {
        id: "mem-unverified",
        path: "memories/mem-unverified.md",
        category: "preference",
        status: "active",
        preview: "unverified memory detail",
      },
    ],
    fallbackUsed: false,
    sourcesUsed: ["memories"],
    disclosure: "chunk",
  };
  const actionRequest = buildChatGptMemoryInspectorActionRequest(
    { query: "show preferences", namespace: "work" },
    recall,
    null,
  );
  const result = buildChatGptMemoryInspectorResult(
    { query: "show preferences", namespace: "work" },
    recall,
    null,
    {
      schemaVersion: 1,
      decision: "ask",
      confidence: 0.2,
      risk: "medium",
      contextReadiness: "partial",
      attentionPolicy: "interruption_budgeting",
      principle: "A good agent should spend the user's attention carefully.",
      reasons: [],
      blockers: ["missing xray provenance"],
      factors: [],
      retrievedMemoryCount: 1,
      usableMemoryCount: 0,
      staleMemoryCount: 0,
      correctedMemoryCount: 0,
      scopeMismatchCount: 0,
      safeToAct: false,
    },
  );

  assert.equal(actionRequest.contextReadiness, "partial");
  assert.equal(actionRequest.retrievedMemories?.length, 1);
  assert.equal(actionRequest.retrievedMemories?.[0]?.safety, "blocked");
  assert.equal(actionRequest.retrievedMemories?.[0]?.safeToUse, false);
  assert.match(
    actionRequest.retrievedMemories?.[0]?.safetyReasons?.[0] ?? "",
    /provenance was unavailable/,
  );
  assert.match(result.safeRecallPreview, /X-ray provenance was unavailable/);
  assert.doesNotMatch(result.safeRecallPreview, /unverified memory detail/);
  assert.match(result.memories[0]?.preview ?? "", /Preview withheld/);
  assert.doesNotMatch(result.memories[0]?.preview ?? "", /unverified memory detail/);
});

test("ChatGPT Apps inspector treats missing per-memory provenance as unsafe", () => {
  const recall: EngramAccessRecallResponse = {
    query: "show preferences",
    namespace: "work",
    context: "unverified memory detail",
    count: 1,
    memoryIds: ["mem-unverified"],
    results: [
      {
        id: "mem-unverified",
        path: "memories/mem-unverified.md",
        category: "preference",
        status: "active",
        preview: "unverified memory detail",
      },
    ],
    fallbackUsed: false,
    sourcesUsed: ["memories"],
    disclosure: "chunk",
  };
  const xray = {
    schemaVersion: "1" as const,
    query: "show preferences",
    snapshotId: "snap-missing-provenance",
    capturedAt: 1_779_000_000_000,
    tierExplain: null,
    results: [
      {
        memoryId: "mem-unverified",
        path: "memories/mem-unverified.md",
        servedBy: "hybrid" as const,
        scoreDecomposition: { final: 0.9 },
        admittedBy: ["test"],
      },
    ],
    filters: [],
    budget: { chars: 4096, used: 100 },
    namespace: "work",
  };
  const actionRequest = buildChatGptMemoryInspectorActionRequest(
    { query: "show preferences", namespace: "work" },
    recall,
    xray,
  );
  const result = buildChatGptMemoryInspectorResult(
    { query: "show preferences", namespace: "work" },
    recall,
    xray,
    {
      schemaVersion: 1,
      decision: "refuse",
      confidence: 0.2,
      risk: "medium",
      contextReadiness: "partial",
      attentionPolicy: "interruption_budgeting",
      principle: "A good agent should spend the user's attention carefully.",
      reasons: [],
      blockers: ["missing xray provenance"],
      factors: [],
      retrievedMemoryCount: 1,
      usableMemoryCount: 0,
      staleMemoryCount: 0,
      correctedMemoryCount: 0,
      scopeMismatchCount: 0,
      safeToAct: false,
    },
  );

  assert.equal(actionRequest.retrievedMemories?.[0]?.safety, "blocked");
  assert.equal(actionRequest.retrievedMemories?.[0]?.safeToUse, false);
  assert.match(
    actionRequest.retrievedMemories?.[0]?.safetyReasons?.[0] ?? "",
    /provenance was missing/,
  );
  assert.match(result.safeRecallPreview, /1 retrieved memory is missing X-ray provenance/);
  assert.doesNotMatch(result.safeRecallPreview, /unverified memory detail/);
  assert.equal(result.memories[0]?.safety, "blocked");
  assert.match(result.memories[0]?.preview ?? "", /Preview withheld/);
  assert.doesNotMatch(result.memories[0]?.preview ?? "", /unverified memory detail/);
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
