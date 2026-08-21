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
import { test } from "node:test";

import { withTempDir as managedWithTempDir } from "../testing/tmp-dir.js";

import type { EngramAccessService } from "../access-service.js";
import { parseConfig } from "../config.js";
import { handleChatMessage, handleChatEventsSSE } from "./chat-http.js";
import { createChatSession, loadChatSession, appendTranscriptEntry, chatSessionFile } from "./chat-session.js";
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

const withTempDir = <T>(fn: (dir: string) => Promise<T>): Promise<T> =>
  managedWithTempDir(fn, "chat-http-");

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

test("HTTP chat/message: hides unexpected stack traces and internal paths", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      fallbackLlmRef: {
        chatCompletion: async () => {
          throw new Error("secret failure at /srv/remnic/private/token-store.js");
        },
      } as never,
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const m = mockRes();
    await handleChatMessage(mockReq() as never, m as never, { message: "hi" }, {
      service,
      config: service.configRef!.chat,
      memoryDir,
    });
    assert.equal(m.status, 200);
    assert.ok(!m.body.includes("secret failure"));
    assert.ok(!m.body.includes("/srv/remnic"));
    assert.ok(!m.body.includes("stack"));
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


test("HTTP chat/events SSE: pushes new transcript entries live (issue #1687)", async () => {
  await withTempDir(async (memoryDir) => {
    const session = await createChatSession(memoryDir, { principal: "alice" });
    await appendTranscriptEntry(memoryDir, session.id, { role: "user", content: "first" });

    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const m = mockRes();
    const req = mockReq();
    await handleChatEventsSSE(req as never, m as never, session.id, { service, config: service.configRef!.chat, memoryDir }, "alice");
    assert.equal(m.status, 200);
    assert.equal(m.headers["content-type"], "text/event-stream");
    // The stream must advertise a retry directive so reconnects are safe.
    assert.ok(m.body.includes("retry: 5000"), "SSE must emit a retry: directive");

    const initialFrames = m.body.split("\n\n").filter((f) => f.startsWith("data:"));

    // Append a NEW entry AFTER the client connected — it must be pushed live
    // to the open SSE connection via the per-session pub/sub.
    await appendTranscriptEntry(memoryDir, session.id, { role: "assistant", content: "pushed-live" });

    const allFrames = m.body.split("\n\n").filter((f) => f.startsWith("data:"));
    assert.ok(allFrames.length > initialFrames.length, "expected a pushed frame after append");
    assert.ok(m.body.includes("pushed-live"), "the appended entry must reach the live SSE stream");
    // The pushed frame must be well-formed SSE (data: <json>\n\n).
    assert.ok(m.body.includes("data: {"), "frames must be data: <json> framed");
    req.emit("close");
  });
});

test("HTTP chat/message: concurrent identical requests are deduplicated (issue #1687)", async () => {
  await withTempDir(async (memoryDir) => {
    const session = await createChatSession(memoryDir, { principal: "alice" });
    let llmCalls = 0;
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
      fallbackLlmRef: ({
        chatCompletion: async () => {
          llmCalls++;
          // Simulate enough work that the second request lands while the
          // first is still in-flight (the dedup window).
          await new Promise((r) => setTimeout(r, 30));
          return { content: "shared-reply", modelUsed: "test-model" };
        },
      }) as never,
    });
    const opts = { service, config: service.configRef!.chat, memoryDir };
    const m1 = mockRes();
    const m2 = mockRes();
    await Promise.all([
      handleChatMessage(mockReq() as never, m1 as never, { message: "duplicate", chatSessionId: session.id }, opts, "alice"),
      handleChatMessage(mockReq() as never, m2 as never, { message: "duplicate", chatSessionId: session.id }, opts, "alice"),
    ]);
    // Exactly ONE LLM call despite two concurrent identical requests.
    assert.equal(llmCalls, 1, "a concurrent duplicate must not re-process");
    // Both callers receive the (same) reply.
    assert.equal(m1.status, 200);
    assert.equal(m2.status, 200);
    assert.ok(m1.body.includes("shared-reply"));
    assert.ok(m2.body.includes("shared-reply"));
    // The transcript must contain exactly one user "duplicate" line — the
    // duplicate did not double-append.
    const loaded = await loadChatSession(memoryDir, session.id);
    const userDups = loaded!.transcript.filter((e) => e.role === "user" && e.content === "duplicate");
    assert.equal(userDups.length, 1, "duplicate request must not append a second user transcript line");
  });
});

test("HTTP chat/message: distinct messages are NOT deduplicated (issue #1687)", async () => {
  await withTempDir(async (memoryDir) => {
    const session = await createChatSession(memoryDir, { principal: "alice" });
    let llmCalls = 0;
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
      fallbackLlmRef: ({
        chatCompletion: async () => {
          llmCalls++;
          await new Promise((r) => setTimeout(r, 20));
          return { content: "reply", modelUsed: "test-model" };
        },
      }) as never,
    });
    const opts = { service, config: service.configRef!.chat, memoryDir };
    await Promise.all([
      handleChatMessage(mockReq() as never, mockRes() as never, { message: "alpha", chatSessionId: session.id }, opts, "alice"),
      handleChatMessage(mockReq() as never, mockRes() as never, { message: "beta", chatSessionId: session.id }, opts, "alice"),
    ]);
    // Distinct messages both process independently.
    assert.equal(llmCalls, 2, "distinct messages must not be coalesced");
  });
});

test("HTTP chat/events SSE: early disconnect during load bails cleanly — no write to ended response, no leak (issue #1687 review)", async () => {
  await withTempDir(async (memoryDir) => {
    const session = await createChatSession(memoryDir, { principal: "alice" });
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const m = mockRes();
    const req = mockReq();
    // Emit close as a microtask so it fires while the handler is awaiting
    // loadChatSession (before writeHead). The handler must bail out without
    // writing to the ended response and without setting up a heartbeat.
    queueMicrotask(() => req.emit("close"));
    // Resolving without throwing is the core contract.
    await handleChatEventsSSE(req as never, m as never, session.id, { service, config: service.configRef!.chat, memoryDir }, "alice");
    // writeHead was skipped (status stays 0) because the handler returned at
    // the `if (closed) return` guard before any SSE framing.
    assert.equal(m.status, 0, "handler must not writeHead after an early close");
  });
});
