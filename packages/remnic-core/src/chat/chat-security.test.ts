/**
 * Chat security + correctness regression tests (issue #1583 review round).
 *
 * Covers the genuine HIGH-severity threads:
 *  - P1 path traversal: session id validation (chat-session.ts)
 *  - P1 stack-trace / raw-error exposure: replies never echo err.message
 *  - P2 confirmation bypass: memory_promote requires an affirmative confirm
 *  - HIGH intercepted apply fetches wrong plan: pending plan binds the REQUESTED id
 *  - HIGH pending-plan cleared wrongly: a normal turn must not clear an active plan
 *  - P1 tool-role normalization: production adapter converts role:"tool" → user
 *  - P2 deduplicate fenced tool-call candidates
 *  - P2 forward MCP scope: processChatMessage binds namespace/sessionKey
 *  - Medium recall_explain forwards query
 */

import { strict as assert } from "node:assert";
import { rm, readFile } from "node:fs/promises";
import { test } from "node:test";

import { makeTempDir as managedMakeTempDir } from "../testing/tmp-dir.js";

import { ChatEngine } from "./chat-engine.js";
import { StubChatLlmAdapter } from "./chat-llm.js";
import { createProductionChatLlmAdapter, parseToolCalls } from "./chat-llm.js";
import {
  createChatSession,
  loadChatSession,
  appendTranscriptEntry,
  markPendingPlan,
  chatSessionFile,
  isSafeChatSessionId,
} from "./chat-session.js";
import { processChatMessage } from "./chat-factory.js";
import type { ChatToolExecutor } from "./chat-engine.js";
import type { EngramAccessService } from "../access-service.js";
import { createChatExecutor } from "./chat-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubExecutor(overrides: Partial<ChatToolExecutor> = {}): ChatToolExecutor {
  const base: ChatToolExecutor = {
    async memorySearch() { return JSON.stringify({ results: [], count: 0 }); },
    async memoryGet() { return JSON.stringify({ id: "abc" }); },
    async memoryTimeline() { return JSON.stringify({ found: true, timeline: [] }); },
    async recallExplain() { return JSON.stringify({ found: true }); },
    async entityGet() { return JSON.stringify({ found: true }); },
    async stats() { return JSON.stringify({ profile: "t" }); },
    async reviewList() { return JSON.stringify({ items: [] }); },
    async scopeInspect() { return JSON.stringify({ namespace: "default" }); },
    async correctionPlan(request: string) { return { planId: `minted-${Date.now()}`, preview: `Plan for: ${request}` }; },
    async correctionApply(planId: string) { return JSON.stringify({ applied: true, planId }); },
    async memoryPromote(memoryId: string) { return JSON.stringify({ promoted: true, memoryId }); },
  };
  return { ...base, ...overrides };
}

function makeEngine(
  llm: StubChatLlmAdapter,
  executor: ChatToolExecutor,
  opts: { correctionAvailable?: boolean } = {},
): ChatEngine {
  return new ChatEngine({
    llm,
    executor,
    maxToolCallsPerTurn: 8,
    correctionAvailable: opts.correctionAvailable ?? false,
    scopeInspectAvailable: false,
  });
}

const makeTempDir = (): Promise<string> => managedMakeTempDir("chat-sec-");

// ---------------------------------------------------------------------------
// P1 — Path traversal (chat-session.ts)
// ---------------------------------------------------------------------------

test("path traversal: isSafeChatSessionId rejects traversal payloads", () => {
  const malicious = [
    "../../../../tmp/target",
    "..\\..\\windows",
    "../state/chat/neighbor",
    "a/b/c",
    "deep/../../escape",
    "foo.bar",
  ];
  for (const id of malicious) {
    assert.equal(isSafeChatSessionId(id), false, `must reject: ${id}`);
  }
});

test("path traversal: isSafeChatSessionId accepts UUID-like ids", () => {
  assert.ok(isSafeChatSessionId("a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
  assert.ok(isSafeChatSessionId("0123456789abcdef"));
});

test("path traversal: chatSessionFile throws on malicious id", () => {
  assert.throws(() => chatSessionFile("/tmp/mem", "../../../../tmp/target"), /Invalid chat session id/);
});

test("path traversal: loadChatSession returns null for malicious id (no read outside chat dir)", async () => {
  const dir = await makeTempDir();
  try {
    // chatSessionFile throws on the malicious id; loadChatSession catches that
    // and returns null. The security property: NO file outside the chat dir is
    // ever read — the caller sees "not found".
    const result = await loadChatSession(dir, "../../../../tmp/target");
    assert.equal(result, null, "malicious id must not read a file outside the chat dir");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("path traversal: appendTranscriptEntry rejects malicious id (no write outside chat dir)", async () => {
  const dir = await makeTempDir();
  try {
    await assert.rejects(() =>
      appendTranscriptEntry(dir, "../../../../tmp/target2", { role: "user", content: "x" }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1 — Stack-trace / raw-error exposure (chat-engine.ts)
// ---------------------------------------------------------------------------

test("error sanitization: LLM failure reply does not echo raw err.message", async () => {
  const executor = makeStubExecutor();
  // Adapter that always throws — simulates an LLM transport error whose
  // message might contain a stack/internal path.
  const llm = {
    async complete() { throw new Error("ECONNREFUSED 127.0.0.1:11434 / internal stack at foo.ts:42"); },
  } as unknown as StubChatLlmAdapter;
  const engine = makeEngine(llm, executor);
  const session = await createChatSession(await makeTempDir(), {});
  const result = await engine.processMessage("hi", session);

  assert.ok(result.reply.includes("[error]"), "reply must be tagged as error");
  assert.ok(
    !result.reply.includes("ECONNREFUSED"),
    `raw internal message must NOT leak into reply: ${result.reply}`,
  );
  assert.ok(
    !result.reply.includes("internal stack"),
    `stack-adjacent text must NOT leak into reply: ${result.reply}`,
  );
});

test("error sanitization: correction-apply failure reply is generic", async () => {
  const executor = makeStubExecutor({
    async correctionApply() { throw new Error("secret internal: write failed at storage.ts:99"); },
  });
  // Step 1: confirm the plan (fast path) → triggers correctionApply → throws.
  const llm = new StubChatLlmAdapter([{ content: "unused" }]);
  const engine = makeEngine(llm, executor, { correctionAvailable: true });
  const dir = await makeTempDir();
  const session = await createChatSession(dir, {});
  // Seed a pending plan so the confirmation fast-path runs correctionApply.
  session.pendingPlanId = "plan-xyz";
  const result = await engine.processMessage("apply", session);

  assert.ok(result.reply.includes("[error]"), "reply must be tagged as error");
  assert.ok(
    !result.reply.includes("secret internal"),
    `internal error detail must NOT leak: ${result.reply}`,
  );
});

// ---------------------------------------------------------------------------
// P2 — Confirmation bypass: memory_promote requires confirmation (Thread 9)
// ---------------------------------------------------------------------------

test("confirmation: memory_promote is intercepted and requires an affirmative confirm", async () => {
  const promoteCalls: string[] = [];
  const executor = makeStubExecutor({
    async memoryPromote(memoryId: string) { promoteCalls.push(memoryId); return JSON.stringify({ promoted: true, memoryId }); },
  });
  // Step 1: LLM emits a memory_promote tool call.
  const llm = new StubChatLlmAdapter([
    { toolCalls: [{ name: "memory_promote", arguments: { memoryId: "mem-1" } }] },
    { content: "done" },
  ]);
  const engine = makeEngine(llm, executor, { correctionAvailable: true });
  const session = await createChatSession(await makeTempDir(), {});

  const result = await engine.processMessage("promote mem-1", session);

  // The promotion must NOT have executed yet (no confirmation received).
  assert.equal(promoteCalls.length, 0, "memory_promote must not execute without confirmation");
  assert.equal(session.pendingPromotionId, "mem-1", "pendingPromotionId must be recorded");
  assert.ok(/apply/i.test(result.reply), "reply must ask the user to confirm");

  // Now confirm → fast-path executes the promotion.
  const result2 = await engine.processMessage("apply", session);
  assert.equal(promoteCalls.length, 1, "memory_promote executes after confirmation");
  assert.equal(promoteCalls[0], "mem-1");
  assert.ok(/promoted/i.test(result2.reply), `reply should confirm promotion: ${result2.reply}`);
});

// ---------------------------------------------------------------------------
// HIGH — Intercepted apply fetches wrong plan (Thread 11)
// ---------------------------------------------------------------------------

test("confirmation: pending plan binds the REQUESTED planId, not an executor re-minted id", async () => {
  // The executor always returns a DIFFERENT planId than requested.
  const executor = makeStubExecutor({
    async correctionPlan() { return { planId: "MINTED-DIFFERENT", preview: "preview text" }; },
  });
  // Step 1: LLM emits correction_apply for planId "REQ-123" (unconfirmed).
  const llm = new StubChatLlmAdapter([
    { toolCalls: [{ name: "correction_apply", arguments: { planId: "REQ-123" } }] },
    { content: "applied" },
  ]);
  const engine = makeEngine(llm, executor, { correctionAvailable: true });
  const session = await createChatSession(await makeTempDir(), {});

  const result = await engine.processMessage("apply this", session);

  assert.equal(session.pendingPlanId, "REQ-123", "must bind the REQUESTED planId");
  assert.equal(result.pendingPlan?.planId, "REQ-123", "result pendingPlan must be the requested id");
  assert.notEqual(session.pendingPlanId, "MINTED-DIFFERENT", "must NOT use the executor re-minted id");
});

// ---------------------------------------------------------------------------
// HIGH — Pending plan cleared wrongly (Thread 15)
// ---------------------------------------------------------------------------

test("pending-plan lifecycle: a normal turn does not clear an active pending plan", async () => {
  const dir = await makeTempDir();
  try {
    const session0 = await createChatSession(dir, { principal: "alice" });
    // Simulate a pending plan from an earlier correction-preview turn.
    await markPendingPlan(dir, session0.id, "plan-active");

    const fakeLlm = { chatCompletion: async () => ({ content: "just a normal answer" }) };
    const service = {
      fallbackLlmRef: fakeLlm,
      localLlmRef: null,
      memoryDir: dir,
      configRef: {
        chat: { enabled: true, model: "", maxToolCallsPerTurn: 8, sessionTtlHours: 72 },
      },
    } as unknown as EngramAccessService;

    await processChatMessage({
      service,
      config: service.configRef!.chat,
      memoryDir: dir,
      message: "what is 2+2?",
      chatSessionId: session0.id,
      principal: "alice",
    });

    // Reload and verify the pending plan survived the normal turn.
    const reloaded = await loadChatSession(dir, session0.id);
    assert.equal(reloaded?.pendingPlanId, "plan-active", "normal turn must NOT clear the pending plan");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1 — Tool-role normalization (chat-llm.ts, Thread 13)
// ---------------------------------------------------------------------------

test("tool-role normalization: production adapter converts role:tool to role:user", async () => {
  const captured: Array<{ role: string; content: string }> = [];
  const client = {
    async chatCompletion(messages: Array<{ role: string; content: string }>) {
      captured.push(...messages);
      return { content: "final answer" };
    },
  };
  const adapter = createProductionChatLlmAdapter(client);
  await adapter.complete(
    [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", content: "thinking" },
      { role: "tool", content: '{"result":"ok"}', toolCallId: "call_1" },
    ],
    { tools: [] },
  );

  const roles = captured.map((m) => m.role);
  assert.ok(!roles.includes("tool"), "no bare role:tool may reach the provider client");
  const toolDerived = captured.find((m) => m.role === "user" && m.content.includes('{"result":"ok"}'));
  assert.ok(toolDerived, "tool result must be surfaced as a user message");
  assert.ok(toolDerived!.content.includes("call_1"), "toolCallId must be preserved in the content");
});

// ---------------------------------------------------------------------------
// P2 — Deduplicate fenced tool-call candidates (chat-llm.ts, Thread 18)
// ---------------------------------------------------------------------------

test("parseToolCalls: a fenced block is not duplicated by the bare-line scan", () => {
  const content = [
    "Let me search.",
    "```json",
    '{"tool": "memory_search", "arguments": {"query": "db"}}',
    "```",
  ].join("\n");
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 1, `expected exactly one tool call, got ${calls.length}`);
  assert.equal(calls[0].name, "memory_search");
});

test("parseToolCalls: distinct tool calls are all kept", () => {
  const content = [
    '{"tool": "memory_search", "arguments": {"query": "a"}}',
    '{"tool": "memory_get", "arguments": {"memoryId": "x"}}',
  ].join("\n");
  const calls = parseToolCalls(content);
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// P2 — Forward MCP scope into new chat sessions (Thread 17)
// ---------------------------------------------------------------------------

test("scope forwarding: processChatMessage binds namespace/sessionKey into a new session", async () => {
  const dir = await makeTempDir();
  try {
    const fakeLlm = { chatCompletion: async () => ({ content: "scoped reply" }) };
    const service = {
      fallbackLlmRef: fakeLlm,
      localLlmRef: null,
      memoryDir: dir,
      configRef: {
        chat: { enabled: true, model: "", maxToolCallsPerTurn: 8, sessionTtlHours: 72 },
      },
    } as unknown as EngramAccessService;

    const result = await processChatMessage({
      service,
      config: service.configRef!.chat,
      memoryDir: dir,
      message: "hello",
      principal: "alice",
      namespace: "team-proj",
      sessionKey: "sess-42",
    });

    const reloaded = await loadChatSession(dir, result.chatSessionId);
    assert.equal(reloaded?.namespace, "team-proj", "new session must bind the forwarded namespace");
    assert.equal(reloaded?.sessionKey, "sess-42", "new session must bind the forwarded sessionKey");

    // Verify the system header carries the structured binding.
    const raw = await readFile(chatSessionFile(dir, result.chatSessionId), "utf8");
    const header = JSON.parse(raw.split("\n")[0]);
    assert.equal(header.namespace, "team-proj");
    assert.equal(header.sessionKey, "sess-42");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Medium — recall_explain forwards query (Thread 1)
// ---------------------------------------------------------------------------

test("recall_explain: forwards the query argument to the executor", async () => {
  let capturedQuery = "<not called>";
  const executor = makeStubExecutor({
    async recallExplain(query: string) { capturedQuery = query; return JSON.stringify({ found: true }); },
  });
  const llm = new StubChatLlmAdapter([
    { toolCalls: [{ name: "recall_explain", arguments: { query: "why postgres" } }] },
    { content: "because [id: abc]" },
  ]);
  const engine = makeEngine(llm, executor);
  const session = await createChatSession(await makeTempDir(), {});
  await engine.processMessage("why did you recall that?", session);
  assert.equal(capturedQuery, "why postgres", "recall_explain must forward the query to the executor");
});

// ---------------------------------------------------------------------------
// P2 — Executor forwards maxResults=0 (Thread 14, kilo review)
// ---------------------------------------------------------------------------

test("executor: maxResults=0 is forwarded, not dropped by falsy check (Thread 14)", async () => {
  let capturedArgs: Record<string, unknown> = {};
  const mockService = {
    briefingEnabled: false,
    memorySearch: async (args: Record<string, unknown>) => {
      capturedArgs = args;
      return { results: [], count: 0 };
    },
  } as unknown as EngramAccessService;
  const executor = createChatExecutor({
    service: mockService,
    principal: "test",
  });
  await executor.memorySearch("query", 0);
  assert.equal(capturedArgs.maxResults, 0, "maxResults=0 must be forwarded, not dropped");
});

// ---------------------------------------------------------------------------
// HIGH — Promote bypass via repeated tool call (cursor OkuNd)
// ---------------------------------------------------------------------------

test("promote: a second tool call for the same memoryId does NOT bypass confirmation", async () => {
  let promoteCalled = false;
  const executor = makeStubExecutor({
    async memoryPromote() { promoteCalled = true; return JSON.stringify({ promoted: true }); },
  });
  // correctionAvailable=true so memory_promote is in the schema and requires confirmation.
  const llm = new StubChatLlmAdapter([
    { toolCalls: [{ name: "memory_promote", arguments: { memoryId: "mem-1" } }] },
  ]);
  const engine = makeEngine(llm, executor, { correctionAvailable: true });
  const session = await createChatSession(await makeTempDir(), {});

  // Turn 1: LLM calls memory_promote — should be intercepted.
  const result1 = await engine.processMessage("promote mem-1", session);
  assert.ok(result1.reply.includes("apply"), "Turn 1 should ask for confirmation");
  assert.equal(session.pendingPromotionId, "mem-1");
  assert.equal(promoteCalled, false, "memory_promote must NOT execute in the tool loop");

  // Turn 2: user types something that is NOT a confirmation keyword.
  // The LLM calls memory_promote again. The engine must intercept again,
  // NOT execute it (cursor HIGH: no bypass via repeated calls).
  const llm2 = new StubChatLlmAdapter([
    { toolCalls: [{ name: "memory_promote", arguments: { memoryId: "mem-1" } }] },
  ]);
  const engine2 = makeEngine(llm2, executor, { correctionAvailable: true });
  const result2 = await engine2.processMessage("please promote it now", session);
  assert.ok(result2.reply.includes("apply"), "Turn 2 should still ask for confirmation");
  assert.equal(promoteCalled, false, "memory_promote must NOT execute without an exact confirm keyword");
});

// ---------------------------------------------------------------------------
// HIGH — Disabled mutating tools still execute (cursor OkuNk)
// ---------------------------------------------------------------------------

test("tool gate: memory_promote is rejected when correctionAvailable is false", async () => {
  let promoteCalled = false;
  const executor = makeStubExecutor({
    async memoryPromote() { promoteCalled = true; return JSON.stringify({ promoted: true }); },
  });
  // correctionAvailable=false so memory_promote is NOT in the tool schema.
  // The LLM hallucinates a memory_promote call anyway.
  const llm = new StubChatLlmAdapter([
    { toolCalls: [{ name: "memory_promote", arguments: { memoryId: "mem-1" } }] },
    { content: "Done." },
  ]);
  const engine = makeEngine(llm, executor, { correctionAvailable: false });
  const session = await createChatSession(await makeTempDir(), {});
  await engine.processMessage("promote something", session);
  assert.equal(promoteCalled, false, "memory_promote must NOT execute when not in the active schema set");
});

// ---------------------------------------------------------------------------
// HIGH — Failed apply restores pending state (cursor OlACo/OlACg)
// ---------------------------------------------------------------------------

test("failed correction apply restores pendingPlanId for retry (OlACo)", async () => {
  const executor = makeStubExecutor({
    async correctionApply() { throw new Error("disk full"); },
  });
  const llm = new StubChatLlmAdapter([]);
  const engine = makeEngine(llm, executor, { correctionAvailable: true });
  const session = await createChatSession(await makeTempDir(), {});
  session.pendingPlanId = "plan-xyz";

  const result = await engine.processMessage("apply", session);

  assert.ok(result.reply.includes("[error]"), "Should return an error reply");
  assert.equal(session.pendingPlanId, "plan-xyz", "pendingPlanId must be restored after failure");
  assert.ok(!session.confirmedPlanIds.has("plan-xyz"), "confirmedPlanIds must not retain the failed planId");
});

test("failed promotion apply restores pendingPromotionId for retry (OlACo)", async () => {
  const executor = makeStubExecutor({
    async memoryPromote() { throw new Error("network error"); },
  });
  const llm = new StubChatLlmAdapter([]);
  const engine = makeEngine(llm, executor, { correctionAvailable: true });
  const session = await createChatSession(await makeTempDir(), {});
  session.pendingPromotionId = "mem-abc";

  const result = await engine.processMessage("apply", session);

  assert.ok(result.reply.includes("[error]"), "Should return an error reply");
  assert.equal(session.pendingPromotionId, "mem-abc", "pendingPromotionId must be restored after failure");
});
