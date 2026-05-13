/**
 * Regression tests for PR #396 reviewer findings on the MCP dispatcher.
 * All fixtures are synthetic — no real user data.
 *
 * Finding 2: Invalid `format` values must be rejected with a structured error,
 * not silently mapped to `undefined`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EngramMcpServer } from "./access-mcp.js";
import type { EngramAccessService } from "./access-service.js";

// ──────────────────────────────────────────────────────────────────────────
// Stub service — only implements the members EngramMcpServer actually touches.
// ──────────────────────────────────────────────────────────────────────────

function makeMockService(briefingFn?: () => Promise<unknown>): EngramAccessService {
  return {
    briefingEnabled: true,
    briefing: briefingFn ?? (() => Promise.resolve({ markdown: "", json: {}, sections: {}, window: {} })),
    recall: () => Promise.resolve({ context: "" }),
    recallExplain: () => Promise.resolve(null),
    store: () => Promise.resolve({ id: "synthetic-id", stored: true }),
    suggest: () => Promise.resolve({ id: "synthetic-id" }),
    daySum: () => Promise.resolve({ summary: "" }),
    memoryGet: () => Promise.resolve(null),
    memoryTimeline: () => Promise.resolve([]),
    entityGet: () => Promise.resolve(null),
    reviewQueueList: () => Promise.resolve({ items: [] }),
    observe: () => Promise.resolve({ ok: true }),
    lcmSearch: () => Promise.resolve({ results: [] }),
    lcmCompactionFlush: () => Promise.resolve({ enabled: true, flushed: true }),
    lcmCompactionRecord: () => Promise.resolve({ enabled: true, recorded: true }),
    memoryGovernanceRun: () => Promise.resolve({ ok: true }),
    identityAnchorGet: () => Promise.resolve(null),
    identityAnchorUpdate: () => Promise.resolve({ ok: true }),
    memoryIdentity: () => Promise.resolve(null),
    continuityAuditGenerate: () => Promise.resolve({ report: "" }),
    continuityIncidentOpen: () => Promise.resolve({ id: "synthetic-incident" }),
    continuityIncidentClose: () => Promise.resolve({ ok: true }),
    continuityIncidentList: () => Promise.resolve({ items: [] }),
    continuityLoopAddOrUpdate: () => Promise.resolve({ ok: true }),
    continuityLoopReview: () => Promise.resolve({ ok: true }),
    workTask: () => Promise.resolve({ ok: true }),
    workProject: () => Promise.resolve({ ok: true }),
    memorySummarizeHourly: () => Promise.resolve({ ok: true }),
    conversationIndexUpdate: () => Promise.resolve({ ok: true }),
    profilingReport: () => Promise.resolve({
      enabled: true,
      format: "json",
      traces: [],
      stats: {},
      bottleneck: null,
    }),
  } as unknown as EngramAccessService;
}

function makeRequest(format: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.briefing",
      arguments: { format },
    },
  };
}

function makeToolRequest(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Finding 2 (#396 new): invalid MCP briefing format values must be rejected
// ──────────────────────────────────────────────────────────────────────────

test("MCP briefing: valid format 'markdown' passes through to service", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "# Briefing\n", json: {}, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest("markdown"));
  assert.ok(called, "service.briefing should have been called for format=markdown");
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP briefing: valid format 'json' passes through to service", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "", json: { synthetic: true }, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest("json"));
  assert.ok(called, "service.briefing should have been called for format=json");
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP briefing: omitting format (undefined) passes through without error", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "# Briefing\n", json: {}, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest(undefined));
  assert.ok(called, "service.briefing should be called when format is absent");
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP briefing: invalid format 'xml' is rejected with isError=true", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "", json: {}, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest("xml"));
  assert.equal(called, false, "service.briefing must NOT be called for invalid format");
  const result = (response as Record<string, unknown> & { result?: { isError?: boolean; content?: { text: string }[] } }).result;
  assert.equal(result?.isError, true, "response must carry isError=true for format=xml");
  const text = result?.content?.[0]?.text ?? "";
  assert.match(text, /xml/i, "error message should reference the rejected value 'xml'");
});

test("MCP briefing: invalid format 'text' is rejected with isError=true", async () => {
  let called = false;
  const service = makeMockService(async () => {
    called = true;
    return { markdown: "", json: {}, sections: {}, window: {} };
  });
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest(makeRequest("text"));
  assert.equal(called, false, "service.briefing must NOT be called for invalid format");
  const result = (response as Record<string, unknown> & { result?: { isError?: boolean } }).result;
  assert.equal(result?.isError, true, "response must carry isError=true for format=text");
});

test("MCP briefing: arbitrary invalid format strings are rejected", async () => {
  const server = new EngramMcpServer(makeMockService());
  for (const bad of ["html", "plain", "csv", "XML"]) {
    const response = await server.handleRequest(makeRequest(bad));
    const result = (response as Record<string, unknown> & { result?: { isError?: boolean } }).result;
    assert.equal(result?.isError, true, `format="${bad}" should produce isError=true`);
  }
});

test("MCP maintenance: hourly summarization dispatches to the access service", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    memorySummarizeHourly: async () => {
      called = true;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(makeToolRequest("engram.memory_summarize_hourly"));

  assert.equal(called, true, "memorySummarizeHourly should be dispatched");
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP maintenance: conversation index update sanitizes optional args", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    conversationIndexUpdate: async (args: Record<string, unknown>) => {
      received = args;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.conversation_index_update", {
      sessionKey: "session-1",
      hours: 12,
      embed: true,
    }),
  );

  assert.deepEqual(received, {
    sessionKey: "session-1",
    hours: 12,
    embed: true,
  });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP maintenance: conversation index update preserves omitted embed default", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    conversationIndexUpdate: async (args: Record<string, unknown>) => {
      received = args;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  await server.handleRequest(
    makeToolRequest("engram.conversation_index_update", {
      sessionKey: "session-1",
    }),
  );

  assert.deepEqual(received, {
    sessionKey: "session-1",
    hours: undefined,
    embed: undefined,
  });
});

test("MCP maintenance: conversation index update rejects non-string sessionKey", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    conversationIndexUpdate: async () => {
      called = true;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.conversation_index_update", {
      sessionKey: 123,
    }),
  );

  assert.equal(called, false);
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, true);
});

test("MCP observe rejects malformed message parts before dispatch", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    observe: async () => {
      called = true;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.observe", {
      sessionKey: "session-1",
      messages: [
        {
          role: "assistant",
          content: "Edited src/auth.ts.",
          parts: [{}],
        },
      ],
    }),
  );

  assert.equal(called, false);
  const result = (response as Record<string, unknown> & { result?: { isError?: boolean; content?: { text: string }[] } }).result;
  assert.equal(result?.isError, true);
  assert.match(result?.content?.[0]?.text ?? "", /kind/i);
});

test("MCP observe accepts nullable optional message-part fields", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    observe: async (request: Record<string, unknown>) => {
      received = request;
      return { ok: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.observe", {
      sessionKey: "session-1",
      messages: [
        {
          role: "assistant",
          content: "Edited src/auth.ts.",
          parts: [
            {
              ordinal: null,
              kind: "file_write",
              payload: { path: "src/auth.ts" },
              toolName: null,
              filePath: "src/auth.ts",
              createdAt: null,
            },
          ],
        },
      ],
    }),
  );

  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
  const messages = received?.messages as Array<Record<string, unknown>> | undefined;
  const parts = messages?.[0]?.parts as Array<Record<string, unknown>> | undefined;
  assert.equal(parts?.[0]?.ordinal, null);
  assert.equal(parts?.[0]?.kind, "file_write");
});

test("MCP profiling report dispatches sanitized args to the access service", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    profilingReport: async (args: Record<string, unknown>) => {
      received = args;
      return { enabled: true, format: "json", traces: [], stats: {}, bottleneck: null };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("remnic.profiling_report", {
      format: "json",
      limit: 3,
    }),
  );

  assert.deepEqual(received, { format: "json", limit: 3 });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP LCM compaction flush dispatches sanitized args to the access service", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    ...makeMockService(),
    lcmCompactionFlush: async (args: Record<string, unknown>) => {
      received = args;
      return { enabled: true, flushed: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("remnic.lcm_compaction_flush", {
      sessionKey: "pi:session",
      namespace: "work",
    }),
  );

  assert.deepEqual(received, {
    sessionKey: "pi:session",
    namespace: "work",
    authenticatedPrincipal: undefined,
  });
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, false);
});

test("MCP tools/list exposes LCM compaction tools under remnic aliases", async () => {
  const server = new EngramMcpServer(makeMockService());

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const listed = ((response as Record<string, unknown>).result as { tools: Array<{ name: string }> }).tools.map(
    (tool) => tool.name,
  );

  assert.ok(listed.includes("remnic.lcm_compaction_flush"));
  assert.ok(listed.includes("engram.lcm_compaction_flush"));
  assert.ok(listed.includes("remnic.lcm_compaction_record"));
  assert.ok(listed.includes("engram.lcm_compaction_record"));
});

test("MCP LCM compaction record rejects invalid token counts before dispatch", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    lcmCompactionRecord: async () => {
      called = true;
      return { enabled: true, recorded: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest(
    makeToolRequest("engram.lcm_compaction_record", {
      sessionKey: "pi:session",
      tokensBefore: -1,
      tokensAfter: 800,
    }),
  );

  assert.equal(called, false);
  assert.equal((response as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, true);
});

test("MCP profiling report rejects invalid argument types before dispatch", async () => {
  let called = false;
  const service = {
    ...makeMockService(),
    profilingReport: async () => {
      called = true;
      return { enabled: true };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const badFormat = await server.handleRequest(
    makeToolRequest("engram.profiling_report", {
      format: false,
    }),
  );
  const badLimit = await server.handleRequest(
    makeToolRequest("engram.profiling_report", {
      limit: "5",
    }),
  );

  assert.equal(called, false);
  assert.equal((badFormat as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, true);
  assert.equal((badLimit as Record<string, unknown> & { result?: { isError?: boolean } }).result?.isError, true);
});
