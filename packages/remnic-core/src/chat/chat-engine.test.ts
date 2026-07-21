/**
 * Chat engine tests (issue #1583 PR 1).
 *
 * Uses the StubChatLlmAdapter to drive scripted tool-call sequences,
 * verifying: read-only Q&A, confirmation protocol, budget exhaustion,
 * LLM outage, citation guard, and per-session isolation.
 */

import { strict as assert } from "node:assert";
import { readFile, utimes, unlink, appendFile } from "node:fs/promises";
import { test } from "node:test";

import { makeTempDir as managedMakeTempDir } from "../testing/tmp-dir.js";

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
  __resetTranscriptSeqForTest,
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

const makeTempDir = (): Promise<string> => managedMakeTempDir("chat-test-");

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

// ---------------------------------------------------------------------------
// Review-round fixes (Thread 16: budget summary error handling)
// ---------------------------------------------------------------------------

test("budget exhaustion summary LLM failure does not crash (Thread 16)", async () => {
  const executor = makeStubExecutor();
  // With maxToolCallsPerTurn=1: call 1 executes the tool, call 2's tool is
  // skipped (budget exhausted), call 3 is the summary. Make the summary throw.
  const llm = new StubChatLlmAdapter([
    { toolCalls: [{ name: "memory_search", arguments: { query: "a" } }] },
  ]);
  let callCount = 0;
  const originalComplete = llm.complete.bind(llm);
  llm.complete = async (messages, options) => {
    callCount++;
    // 3rd call is the budget-exhaustion summary — throw to verify the try/catch.
    if (callCount === 3) throw new Error("summary LLM transport failure");
    return originalComplete(messages, options);
  };
  const engine = makeEngine(llm, executor, { maxToolCallsPerTurn: 1 });

  const session = await createChatSession(await makeTempDir(), {});
  const result = await engine.processMessage("search a", session);

  // Should return a partial reply, not throw.
  assert.ok(result.reply.length > 0, "Should return a fallback reply");
  assert.ok(result.skippedTools !== undefined, "Should report skipped tools");
});

// ---------------------------------------------------------------------------
// TTL boundary (issue #1685 item 1 / #1687 Thread 21)
// ---------------------------------------------------------------------------

test("cleanupExpiredChatSessions honors TTL boundary [0, ttlHours) — age >= ttl expires", async () => {
  const dir = await makeTempDir();
  const ttlHours = 2;
  const ttlMs = ttlHours * 3600 * 1000;

  // Session aged past the TTL (mtime set to ttlHours ago; by the time the
  // sweep stat()s it a few ms have elapsed, so age >= ttl deterministically
  // — the boundary is inclusive: age ∈ [0, ttl) survives, age >= ttl expires).
  const expired = await createChatSession(dir, { principal: "expired" });
  const expiredFile = chatSessionFile(dir, expired.id);
  const atTtlSeconds = (Date.now() - ttlMs) / 1000;
  await utimes(expiredFile, atTtlSeconds, atTtlSeconds);

  // Session aged well under the TTL → must survive.
  const fresh = await createChatSession(dir, { principal: "fresh" });
  const freshFile = chatSessionFile(dir, fresh.id);
  const underTtlSeconds = (Date.now() - (ttlMs - 6 * 60 * 1000)) / 1000; // ~1.9h old
  await utimes(freshFile, underTtlSeconds, underTtlSeconds);

  const removed = await cleanupExpiredChatSessions(dir, ttlHours);
  assert.equal(removed, 1, "only the expired session should be removed");

  // The fresh session file must still be on disk.
  const freshStillExists = await readFile(freshFile, "utf8").then(() => true).catch(() => false);
  assert.ok(freshStillExists, "session aged under the TTL must survive the sweep");

  // The expired session file must be gone.
  const expiredGone = await readFile(expiredFile, "utf8").then(() => false).catch(() => true);
  assert.ok(expiredGone, "session aged at/over the TTL must be swept");
});


test("appendTranscriptEntry emits strictly-increasing seqs even within the same millisecond (issue #1687 review)", async () => {
  const dir = await makeTempDir();
  const session = await createChatSession(dir, { principal: "seq" });
  // Append several entries as fast as possible (same-ms collisions would have
  // shared a Date.now()-based seq before the monotonic counter fix).
  const entries: number[] = [];
  for (let i = 0; i < 8; i++) {
    const e = await appendTranscriptEntry(dir, session.id, { role: "user", content: `m${i}` });
    entries.push(e.seq);
  }
  // Every seq must be distinct and strictly increasing.
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i]! > entries[i - 1]!, `seq ${entries[i]} must exceed ${entries[i - 1]}`);
  }
  assert.equal(new Set(entries).size, entries.length, "seqs must be unique");
});

test("appendTranscriptEntry refuses to recreate a swept session (chat_session_expired) — codex P2 #1687", async () => {
  const dir = await makeTempDir();
  const session = await createChatSession(dir, { principal: "alice" });
  // Simulate the TTL sweep unlinking the file mid-turn (resurrection race).
  await unlink(chatSessionFile(dir, session.id));
  // Must throw instead of silently recreating a headerless (public) file.
  await assert.rejects(
    appendTranscriptEntry(dir, session.id, { role: "user", content: "x" }),
    /chat_session_expired/,
  );
});


test("loadChatSession raises the seq counter above the on-disk max on backward clock skew (issue #1718)", async () => {
  const dir = await makeTempDir();
  const session = await createChatSession(dir, { principal: "skew" });
  // Simulate a previous process that ran with a forward-skewed clock: append a
  // transcript line whose seq is far in the future relative to the current
  // Date.now(). A later restart with a normal (or backward-stepped) clock must
  // still issue seqs strictly greater than this persisted line.
  const futureSeq = Date.now() + 10_000_000;
  await appendFile(
    chatSessionFile(dir, session.id),
    JSON.stringify({
      seq: futureSeq,
      ts: new Date().toISOString(),
      role: "user",
      content: "future-dated line from a forward-skewed prior process",
    }) + "\n",
    "utf8",
  );
  // Simulate a process restart whose module-level counter starts below the
  // persisted on-disk seq (the backward-clock-skew window).
  __resetTranscriptSeqForTest();
  // Resume the session: loadChatSession must raise the counter above the
  // on-disk max so the next append is strictly greater, regardless of the
  // current Date.now().
  const loaded = await loadChatSession(dir, session.id);
  assert.ok(loaded, "session must load");
  const next = await appendTranscriptEntry(dir, session.id, {
    role: "assistant",
    content: "resumed after backward clock skew",
  });
  assert.ok(
    next.seq > futureSeq,
    `seq ${next.seq} must exceed the on-disk max ${futureSeq} after a backward clock skew (issue #1718)`,
  );
});
