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
import { tokenCapabilityStore } from "../access-token-capabilities.js";
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

// ──────────────────────────────────────────────────────────────────────────
// Issue #1850 round 6: MCP memory_chat dispatches via processChatMessage,
// bypassing op.run() (the boundary hook every other callTool branch routes
// through). It must still enforce the per-token ops allow-list (op-gate) AND
// the chat-session namespace, matching the HTTP /engram/v1/chat/message route.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Narrow a tools/call JSON-RPC response into just the fields the r6 tests
 * assert on. Reads through `Record<string, unknown>` + `typeof` guards rather
 * than an inline fabricated-shape cast, so a malformed envelope can never read
 * a property the compiler never verified.
 */
function readToolOutcome(response: Record<string, unknown> | null): {
  isError: boolean;
  text: string;
} {
  const result = response?.result;
  if (!(result && typeof result === "object")) return { isError: false, text: "" };
  const r = result as Record<string, unknown>;
  const content = r.content;
  const firstEntry = Array.isArray(content) ? content[0] : undefined;
  const firstText =
    firstEntry && typeof firstEntry === "object" && firstEntry !== null
      ? (firstEntry as Record<string, unknown>).text
      : undefined;
  return {
    isError: r.isError === true,
    text: typeof firstText === "string" ? firstText : "",
  };
}

function makeChatService(memoryDir: string, llm: { chatCompletion: () => Promise<unknown> }): EngramAccessService {
  return makeBaseService({
    fallbackLlmRef: llm,
    memoryDir,
    configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
  });
}

test("MCP memory_chat: deny-all (ops:[]) token is rejected before dispatch (issue #1850 r6)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "chat-mcp-opgate-deny-"));
  let dispatched = false;
  const service = makeChatService(memoryDir, {
    chatCompletion: async () => {
      dispatched = true;
      return { content: "x" };
    },
  });
  const server = new EngramMcpServer(service, { chatVisible: true, principal: "alice" });

  const outcome = await tokenCapabilityStore.run({ version: 1, ops: [] }, async () =>
    readToolOutcome(await server.handleRequest(makeCallRequest("engram.memory_chat", { message: "hi" }))),
  );
  assert.equal(outcome.isError, true, "a deny-all token must be rejected at the op-gate");
  assert.match(outcome.text, /not permitted to call operation/i);
  assert.equal(dispatched, false, "processChatMessage (the LLM) must never be reached");
  await rm(memoryDir, { recursive: true, force: true });
});

test("MCP memory_chat: ops-scoped token without chat_message is rejected (issue #1850 r6)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "chat-mcp-opgate-scope-"));
  let dispatched = false;
  const service = makeChatService(memoryDir, {
    chatCompletion: async () => {
      dispatched = true;
      return { content: "x" };
    },
  });
  const server = new EngramMcpServer(service, { chatVisible: true, principal: "alice" });

  // Token permits recall but NOT chat_message.
  const outcome = await tokenCapabilityStore.run({ version: 1, ops: ["recall"] }, async () =>
    readToolOutcome(await server.handleRequest(makeCallRequest("engram.memory_chat", { message: "hi" }))),
  );
  assert.equal(outcome.isError, true, "an ops-scoped token without chat_message must be rejected");
  assert.match(outcome.text, /not permitted to call operation/i);
  assert.equal(dispatched, false, "processChatMessage (the LLM) must never be reached");
  await rm(memoryDir, { recursive: true, force: true });
});

test("MCP memory_chat: ops-scoped token WITH chat_message is allowed (issue #1850 r6)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "chat-mcp-opgate-allow-"));
  const service = makeChatService(memoryDir, { chatCompletion: async () => ({ content: "sure [id: x]." }) });
  const server = new EngramMcpServer(service, { chatVisible: true, principal: "alice" });

  const outcome = await tokenCapabilityStore.run({ version: 1, ops: ["chat_message"] }, async () =>
    readToolOutcome(await server.handleRequest(makeCallRequest("engram.memory_chat", { message: "hi" }))),
  );
  assert.equal(outcome.isError, false, "a token whose ops include chat_message must pass the gate");
  const parsed = JSON.parse(outcome.text) as Record<string, unknown>;
  assert.ok(typeof parsed.reply === "string" && (parsed.reply as string).length > 0, "a reply must be produced");
  await rm(memoryDir, { recursive: true, force: true });
});

test("MCP memory_chat: unrestricted token is allowed (issue #1850 r6)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "chat-mcp-unrestricted-"));
  const service = makeChatService(memoryDir, { chatCompletion: async () => ({ content: "hello [id: y]." }) });
  const server = new EngramMcpServer(service, { chatVisible: true, principal: "alice" });

  // Explicit-unrestricted record (version present, no axes) ⇒ both gates no-op.
  const outcome = await tokenCapabilityStore.run({ version: 1 }, async () =>
    readToolOutcome(await server.handleRequest(makeCallRequest("engram.memory_chat", { message: "hi" }))),
  );
  assert.equal(outcome.isError, false, "an unrestricted token must pass both gates");
  const parsed = JSON.parse(outcome.text) as Record<string, unknown>;
  assert.ok(typeof parsed.reply === "string", "a reply must be produced");
  await rm(memoryDir, { recursive: true, force: true });
});

test("MCP memory_chat: namespace-scoped token cannot resume a cross-namespace session (issue #1850 r6)", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "chat-mcp-xnamespace-"));
  let dispatchCount = 0;
  const llm = {
    chatCompletion: async () => {
      dispatchCount += 1;
      return { content: "ok [id: z]." };
    },
  };
  const service = makeChatService(memoryDir, llm);
  const server = new EngramMcpServer(service, { chatVisible: true, principal: "alice" });

  // 1. Create a session bound to namespace "team-a" under an unrestricted token.
  const createOutcome = readToolOutcome(
    await server.handleRequest(makeCallRequest("engram.memory_chat", { message: "remember this" }), {
      namespaceOverride: "team-a",
    }),
  );
  assert.equal(createOutcome.isError, false, "session creation under an unrestricted token must succeed");
  const created = JSON.parse(createOutcome.text) as Record<string, unknown>;
  assert.ok(typeof created.chatSessionId === "string", "a chatSessionId must be returned to resume");
  const chatSessionId = created.chatSessionId as string;
  assert.equal(dispatchCount, 1, "the create call dispatched the LLM exactly once");

  // 2. Resume that session under a token scoped to a DIFFERENT namespace. The
  //    resumed session is an id-loaded record whose stored namespace ("team-a")
  //    must be gated against the token's allow-list (["team-b"]) — rejected.
  const resumeOutcome = await tokenCapabilityStore.run({ version: 1, namespaces: ["team-b"] }, async () =>
    readToolOutcome(
      await server.handleRequest(
        makeCallRequest("engram.memory_chat", { message: "follow up", chatSessionId }),
      ),
    ),
  );
  assert.equal(resumeOutcome.isError, true, "a cross-namespace resume must be rejected");
  assert.match(resumeOutcome.text, /not permitted to access namespace/i);
  assert.equal(dispatchCount, 1, "the rejected resume must not have dispatched the LLM a second time");
  await rm(memoryDir, { recursive: true, force: true });
});
