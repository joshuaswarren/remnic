/**
 * Chat HTTP surface tests (issue #1583 PR 3).
 *
 * Contract tests for handleChatMessage (POST /engram/v1/chat/message) and
 * handleChatEventsSSE (GET /engram/v1/chat/events/:id). Auth/isolation,
 * chat-disabled gate, input validation, and the happy path are all covered
 * against in-process mock req/res objects — no port binding.
 */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { EngramAccessService } from "../access-service.js";
import { parseConfig } from "../config.js";
import { handleChatMessage, handleChatEventsSSE } from "./chat-http.js";
import { createChatSession, appendTranscriptEntry, chatSessionFile } from "./chat-session.js";
import { DEFAULT_CHAT_CONFIG } from "./chat-config.js";

// Minimal mock res capturing writes. All tracking fields live on one
// object the methods mutate (no spread copy — primitives would freeze at 0).
interface MockRes {
  emitter: EventEmitter;
  status: number;
  headers: Record<string, string>;
  body: string;
  writeHead: (s: number, h?: Record<string, string>) => void;
  write: (c: string) => void;
  end: (c?: string) => void;
}
function mockRes(): MockRes {
  const m: MockRes = {
    emitter: new EventEmitter(),
    status: 0,
    headers: {},
    body: "",
    writeHead(status: number, headers?: Record<string, string>) { m.status = status; if (headers) m.headers = headers; },
    write(chunk: string) { m.body += chunk; },
    end(chunk?: string) { if (chunk) m.body += chunk; m.emitter.emit("done"); },
  };
  return m;
}

function mockReq(): EventEmitter {
  return new EventEmitter();
}

function makeService(overrides: Partial<EngramAccessService> = {}): EngramAccessService {
  return {
    fallbackLlmRef: { chatCompletion: async () => ({ content: "stub reply" }) },
    configRef: parseConfig({ memoryDir: "/tmp/chat-http-test", chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    memoryDir: "/tmp/chat-http-test",
    memoryGet: () => Promise.resolve(null),
    memoryTimeline: () => Promise.resolve([]),
    memorySearch: () => Promise.resolve({ results: [], count: 0 }),
    recallExplain: () => Promise.resolve(null),
    entityGet: () => Promise.resolve(null),
    memoryProfile: () => Promise.resolve({}),
    memoryEntitiesList: () => Promise.resolve({ items: [] }),
    memoryQuestions: () => Promise.resolve({ items: [] }),
    reviewQueue: () => Promise.resolve({ items: [] }),
    ...overrides,
  } as unknown as EngramAccessService;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "chat-http-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("HTTP chat/message: 404 when chat is disabled", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: false } }),
      memoryDir,
    });
    const m = mockRes();
    await handleChatMessage(mockReq() as never, m as never, { message: "hi" }, { service, config: service.configRef!.chat, memoryDir });
    assert.equal(m.status, 404);
    assert.ok(m.body.includes("chat_disabled"));
  });
});

test("HTTP chat/message: 400 when message is missing", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({ memoryDir, configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }) });
    const m = mockRes();
    await handleChatMessage(mockReq() as never, m as never, {}, { service, config: service.configRef!.chat, memoryDir });
    assert.equal(m.status, 400);
    assert.ok(m.body.includes("required"));
  });
});

test("HTTP chat/message: 503 when no LLM is available", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      fallbackLlmRef: null,
      localLlmRef: null,
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const m = mockRes();
    await handleChatMessage(mockReq() as never, m as never, { message: "hi" }, { service, config: service.configRef!.chat, memoryDir });
    assert.equal(m.status, 503);
    assert.ok(m.body.includes("no_llm"));
  });
});

test("HTTP chat/message: 200 happy path returns reply + chatSessionId", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const m = mockRes();
    await handleChatMessage(mockReq() as never, m as never, { message: "hello" }, { service, config: service.configRef!.chat, memoryDir });
    assert.equal(m.status, 200);
    const parsed = JSON.parse(m.body) as { reply?: string; chatSessionId?: string };
    assert.ok(parsed.reply && parsed.reply.length > 0);
    assert.ok(parsed.chatSessionId);
  });
});

test("HTTP chat/message: 403 when resuming a session owned by another principal", async () => {
  await withTempDir(async (memoryDir) => {
    const session = await createChatSession(memoryDir, { principal: "alice" });
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const m = mockRes();
    await handleChatMessage(
      mockReq() as never, m as never,
      { message: "hi", chatSessionId: session.id },
      { service, config: service.configRef!.chat, memoryDir },
      "bob",
    );
    assert.equal(m.status, 403);
    assert.ok(m.body.includes("access_denied"));
  });
});

test("HTTP chat/message: 404 when resuming a non-existent session", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const m = mockRes();
    await handleChatMessage(
      mockReq() as never, m as never,
      { message: "hi", chatSessionId: "does-not-exist" },
      { service, config: service.configRef!.chat, memoryDir },
    );
    assert.equal(m.status, 404);
    assert.ok(m.body.includes("chat_session_not_found"));
  });
});

test("HTTP chat/events SSE: streams transcript entries", async () => {
  await withTempDir(async (memoryDir) => {
    const session = await createChatSession(memoryDir, { principal: "alice" });
    await appendTranscriptEntry(memoryDir, session.id, { role: "user", content: "hello" });
    await appendTranscriptEntry(memoryDir, session.id, { role: "assistant", content: "world" });

    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const m = mockRes();
    const req = mockReq();
    await handleChatEventsSSE(req as never, m as never, session.id, { service, config: service.configRef!.chat, memoryDir }, "alice");
    assert.equal(m.status, 200);
    assert.equal(m.headers["content-type"], "text/event-stream");
    // The system header + user + assistant = 3 data frames.
    const frames = m.body.split("\n\n").filter((f) => f.startsWith("data:"));
    assert.ok(frames.length >= 3, `expected >=3 SSE frames, got ${frames.length}`);
    // Close the request to stop the heartbeat.
    req.emit("close");
  });
});

test("HTTP chat/events SSE: 403 for a session owned by another principal", async () => {
  await withTempDir(async (memoryDir) => {
    const session = await createChatSession(memoryDir, { principal: "alice" });
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const m = mockRes();
    await handleChatEventsSSE(mockReq() as never, m as never, session.id, { service, config: service.configRef!.chat, memoryDir }, "bob");
    assert.equal(m.status, 403);
  });
});
