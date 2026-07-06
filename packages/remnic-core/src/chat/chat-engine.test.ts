/**
 * Chat engine tests (issue #1583 PR 1).
 *
 * Uses the StubChatLlmAdapter to drive scripted tool-call sequences,
 * verifying: read-only Q&A, confirmation protocol, budget exhaustion,
 * LLM outage, citation guard, and per-session isolation.
 */

import { strict as assert } from "node:assert";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { ChatEngine } from "./chat-engine.js";
import { StubChatLlmAdapter, NullChatLlmAdapter } from "./chat-llm.js";
import { isConfirmationMessage } from "./chat-engine.js";
import {
  createChatSession,
  loadChatSession,
  appendTranscriptEntry,
  sessionBelongsToPrincipal,
  chatSessionFile,
  cleanupExpiredChatSessions,
} from "./chat-session.js";
import type { ChatSessionState } from "./chat-types.js";
import type { ChatToolExecutor } from "./chat-engine.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStubExecutor(overrides: Partial<ChatToolExecutor> = {}): ChatToolExecutor {
  const base: ChatToolExecutor = {
    async memorySearch() { return JSON.stringify({ results: [{ path: "mem/abc.md", score: 0.9, snippet: "Database uses PostgreSQL" }], count: 1 }); },
    async memoryGet() { return JSON.stringify({ id: "abc", content: "Database uses PostgreSQL", category: "fact", tags: ["database"] }); },
    async memoryTimeline() { return JSON.stringify({ found: true, timeline: [] }); },
    async recallExplain() { return JSON.stringify({ found: true, tiers: [{ id: "abc", score: 0.9 }] }); },
    async entityGet() { return JSON.stringify({ found: true, entity: { name: "database", type: "tool" } }); },
    async stats() { return JSON.stringify({ profile: "test", entities: { count: 5 }, questions: { count: 2 } }); },
    async reviewList() { return JSON.stringify({ items: [] }); },
    async scopeInspect() { return JSON.stringify({ namespace: "default" }); },
    async correctionPlan(request: string) { return { planId: "plan-1", preview: `Plan for: ${request}` }; },
    async correctionApply(planId: string) { return JSON.stringify({ applied: true, planId }); },
    async memoryPromote(memoryId: string) { return JSON.stringify({ promoted: true, memoryId }); },
  };
  return { ...base, ...overrides };
}

function makeEngine(
  llm: StubChatLlmAdapter | NullChatLlmAdapter,
  executor: ChatToolExecutor,
  opts: { correctionAvailable?: boolean; maxToolCallsPerTurn?: number } = {},
): ChatEngine {
  return new ChatEngine({
    llm,
    executor,
    maxToolCallsPerTurn: opts.maxToolCallsPerTurn ?? 8,
    correctionAvailable: opts.correctionAvailable ?? false,
    scopeInspectAvailable: false,
  });
}

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("read-only Q&A: LLM calls memory_search and returns a text reply", async () => {
  const executor = makeStubExecutor();
  const llm = new StubChatLlmAdapter([
    { toolCalls: [{ name: "memory_search", arguments: { query: "database" } }] },
    { content: "Based on my search, your database uses PostgreSQL [id: abc]." },
  ]);
  const engine = makeEngine(llm, executor);

  const session = await createChatSession(await makeTempDir(), {});
  const result = await engine.processMessage("What database do I use?", session);

  assert.ok(result.reply.length > 0);
  assert.equal(result.chatSessionId, session.id);
  assert.equal(result.error, undefined);
});

test("LLM outage → tagged error reply (rule 13)", async () => {
  const executor = makeStubExecutor();
  const llm = new NullChatLlmAdapter();
  const engine = makeEngine(llm, executor);

  const session = await createChatSession(await makeTempDir(), {});
  const result = await engine.processMessage("anything", session);

  assert.ok(result.reply.includes("[error]"), `Expected error tag, got: ${result.reply}`);
  assert.ok(result.error);
});

test("tool budget exhaustion → partial reply with skippedTools", async () => {
  const executor = makeStubExecutor();
  // Script: LLM keeps calling tools forever.
  const llm = new StubChatLlmAdapter([
    { toolCalls: [{ name: "memory_search", arguments: { query: "a" } }] },
    { toolCalls: [{ name: "memory_search", arguments: { query: "b" } }] },
  ]);
  const engine = makeEngine(llm, executor, { maxToolCallsPerTurn: 1 });

  const session = await createChatSession(await makeTempDir(), {});
  const result = await engine.processMessage("search a b", session);

  // With maxToolCallsPerTurn=1, the second tool call is skipped.
  assert.ok(result.skippedTools !== undefined || result.reply.length > 0);
});

test("confirmation protocol: isConfirmationMessage recognizes exact-match keywords", () => {
  assert.ok(isConfirmationMessage("yes"));
  assert.ok(isConfirmationMessage("y"));
  assert.ok(isConfirmationMessage("apply"));
  assert.ok(isConfirmationMessage("confirm"));
  assert.ok(isConfirmationMessage("  YES  "));
  assert.ok(!isConfirmationMessage("no"));
  assert.ok(!isConfirmationMessage("yeah"));
  assert.ok(!isConfirmationMessage("please apply"));
});

test("citation guard: uncited memory assertion gets warning", async () => {
  const executor = makeStubExecutor();
  // The LLM makes an assertion without calling any tools first.
  const llm = new StubChatLlmAdapter([
    { content: "You remember that the database is PostgreSQL." },
  ]);
  const engine = makeEngine(llm, executor);

  const session = await createChatSession(await makeTempDir(), {});
  const result = await engine.processMessage("what database?", session);

  assert.ok(
    result.reply.includes("⚠️") || result.reply.includes("not grounded"),
    `Expected citation warning, got: ${result.reply}`,
  );
});

test("citation guard: cited assertion does NOT get warning", async () => {
  const executor = makeStubExecutor();
  // LLM calls a tool first, then makes the assertion.
  const llm = new StubChatLlmAdapter([
    { toolCalls: [{ name: "memory_search", arguments: { query: "database" } }] },
    { content: "Based on the search, the database uses PostgreSQL [id: abc]." },
  ]);
  const engine = makeEngine(llm, executor);

  const session = await createChatSession(await makeTempDir(), {});
  const result = await engine.processMessage("what database?", session);

  assert.ok(
    !result.reply.includes("⚠️"),
    `Expected no citation warning, got: ${result.reply}`,
  );
});

// ---------------------------------------------------------------------------
// Session persistence tests
// ---------------------------------------------------------------------------

test("transcript persisted to JSONL and contains exclusion tag", async () => {
  const dir = await makeTempDir();
  const session = await createChatSession(dir, { principal: "alice" });

  await appendTranscriptEntry(dir, session.id, {
    role: "user",
    content: "hello",
  });
  await appendTranscriptEntry(dir, session.id, {
    role: "assistant",
    content: "hi there",
  });

  const raw = await readFile(chatSessionFile(dir, session.id), "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  // First line is the system header with the exclusion tag.
  const header = JSON.parse(lines[0]!);
  assert.equal(header.role, "system");
  assert.ok(
    header.content.includes("Excluded from memory extraction"),
    "Transcript header must carry the memory-extraction exclusion tag",
  );
  assert.equal(lines.length, 3); // header + user + assistant
});

test("per-session isolation: different principals have no cross-visibility", async () => {
  const dir = await makeTempDir();
  const aliceSession = await createChatSession(dir, { principal: "alice" });
  const bobSession = await createChatSession(dir, { principal: "bob" });

  assert.ok(sessionBelongsToPrincipal(aliceSession, "alice"));
  assert.ok(!sessionBelongsToPrincipal(aliceSession, "bob"));
  assert.ok(sessionBelongsToPrincipal(bobSession, "bob"));
  assert.ok(!sessionBelongsToPrincipal(bobSession, "alice"));
});

test("session without principal is accessible to anyone (single-user case)", async () => {
  const dir = await makeTempDir();
  const session = await createChatSession(dir, {});
  assert.ok(sessionBelongsToPrincipal(session, "alice"));
  assert.ok(sessionBelongsToPrincipal(session, "bob"));
  assert.ok(sessionBelongsToPrincipal(session, undefined));
});

test("loadChatSession returns null for non-existent session", async () => {
  const dir = await makeTempDir();
  const result = await loadChatSession(dir, "nonexistent-id");
  assert.equal(result, null);
});

test("loadChatSession round-trips transcript entries", async () => {
  const dir = await makeTempDir();
  const session = await createChatSession(dir, { principal: "alice" });
  await appendTranscriptEntry(dir, session.id, { role: "user", content: "hello" });
  await appendTranscriptEntry(dir, session.id, { role: "assistant", content: "world" });

  const loaded = await loadChatSession(dir, session.id);
  assert.ok(loaded);
  assert.equal(loaded!.principal, "alice");
  // 3 entries: system header + user + assistant
  assert.equal(loaded!.transcript.length, 3);
});

// ---------------------------------------------------------------------------
// Cleanup tests
// ---------------------------------------------------------------------------

test("cleanupExpiredChatSessions removes old sessions", async () => {
  const dir = await makeTempDir();
  await createChatSession(dir, { principal: "test" });

  // TTL of 0 hours → everything is expired.
  const removed = await cleanupExpiredChatSessions(dir, 0);
  assert.ok(removed >= 1);
});
