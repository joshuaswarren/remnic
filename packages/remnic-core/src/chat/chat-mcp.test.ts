/**
 * Chat MCP surface tests (issue #1583 PR 4).
 *
 * Verifies the tools/list parity gate (chat.enabled → memory_chat visible,
 * byte-identical when off — rule 39) and the memory_chat tool dispatch.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EngramMcpServer } from "../access-mcp.js";
import type { EngramAccessService } from "../access-service.js";
import { parseConfig } from "../config.js";
import { DEFAULT_CHAT_CONFIG } from "./chat-config.js";

function makeBaseService(overrides: Record<string, unknown> = {}): EngramAccessService {
  return {
    briefingEnabled: false,
    briefing: () => Promise.resolve({ markdown: "", json: {}, sections: {}, window: {} }),
    recall: () => Promise.resolve({ context: "" }),
    recallExplain: () => Promise.resolve(null),
    store: () => Promise.resolve({ id: "x", stored: true }),
    memoryStore: () => Promise.resolve({ schemaVersion: 1, operation: "memory_store", namespace: "default", dryRun: true, accepted: true, queued: false, status: "validated" }),
    memoryGet: () => Promise.resolve(null),
    memoryTimeline: () => Promise.resolve([]),
    entityGet: () => Promise.resolve(null),
    reviewQueueList: () => Promise.resolve({ items: [] }),
    observe: () => Promise.resolve({ ok: true }),
    ...overrides,
  } as unknown as EngramAccessService;
}

function makeListRequest(): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
}

function makeCallRequest(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } };
}

test("MCP tools/list: memory_chat absent when chatVisible is false (byte-identical, rule 39)", async () => {
  const service = makeBaseService();
  const server = new EngramMcpServer(service, { chatVisible: false });
  const response = await server.handleRequest(makeListRequest());
  const tools = (response as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
  const names = tools.map((t) => t.name);
  assert.ok(!names.includes("engram.memory_chat"), "memory_chat must NOT appear when chat is disabled");
});

test("MCP tools/list: memory_chat present when chatVisible is true", async () => {
  const service = makeBaseService();
  const server = new EngramMcpServer(service, { chatVisible: true });
  const response = await server.handleRequest(makeListRequest());
  const tools = (response as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("engram.memory_chat"), "memory_chat must appear when chat is enabled");
});

test("MCP memory_chat: dispatches to processChatMessage and returns a reply", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "chat-mcp-"));
  const llm = {
    chatCompletion: async () => ({ content: "Your database uses PostgreSQL [id: abc]." }),
  };
  const service = makeBaseService({
    fallbackLlmRef: llm,
    memoryDir,
    configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
  });
  const server = new EngramMcpServer(service, { chatVisible: true, principal: "alice" });

  const response = await server.handleRequest(
    makeCallRequest("engram.memory_chat", { message: "what database?" }),
  );
  const result = (response as { result?: { content?: { text?: string }[]; isError?: boolean } }).result;
  assert.equal(result?.isError, false);
  const text = result?.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text) as { reply?: string; chatSessionId?: string };
  assert.ok(parsed.reply && parsed.reply.length > 0, "reply text must be present");
  assert.ok(parsed.chatSessionId, "chatSessionId must be returned");
  await rm(memoryDir, { recursive: true, force: true });
});

test("MCP memory_chat: rejects empty message with input error", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "chat-mcp-err-"));
  const service = makeBaseService({
    fallbackLlmRef: { chatCompletion: async () => ({ content: "x" }) },
    memoryDir,
    configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
  });
  const server = new EngramMcpServer(service, { chatVisible: true });

  const response = await server.handleRequest(
    makeCallRequest("engram.memory_chat", { message: "" }),
  );
  const result = (response as { result?: { isError?: boolean; content?: { text?: string }[] } }).result;
  assert.equal(result?.isError, true, "empty message must surface an input error");
  await rm(memoryDir, { recursive: true, force: true });
});

test("MCP memory_chat: strips internal error from structuredContent (Thread 17)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "chat-mcp-leak-"));
  // LLM returns null → engine tags the result with error: "no_llm_available".
  const llm = {
    chatCompletion: async () => null,
  };
  const service = makeBaseService({
    fallbackLlmRef: llm,
    memoryDir,
    configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
  });
  const server = new EngramMcpServer(service, { chatVisible: true, principal: "alice" });

  const response = await server.handleRequest(
    makeCallRequest("engram.memory_chat", { message: "what database?" }),
  );
  const result = (response as {
    result?: {
      content?: { text?: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
  }).result;
  assert.equal(result?.isError, false, "should not be a JSON-RPC error");
  // The text content and structuredContent must NOT expose the raw error field.
  const sc = result?.structuredContent ?? {};
  assert.ok(!("error" in sc), "structuredContent must not leak the error field");
  const text = result?.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.ok(!("error" in parsed), "text content must not leak the error field");
  assert.ok(typeof parsed.reply === "string", "reply must be present");
  await rm(memoryDir, { recursive: true, force: true });
});
