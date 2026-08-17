/**
 * Chat CLI surface tests (issue #1583 PR 2).
 *
 * Tests the non-TTY `--once` scripting mode and the no-LLM error path.
 * Interactive readline mode is exercised via the golden-transcript pattern
 * in chat-engine.test.ts (the engine loop is identical); here we cover the
 * CLI's own input/output contract.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { withTempDir as managedWithTempDir } from "../testing/tmp-dir.js";

import type { EngramAccessService } from "../access-service.js";
import { parseConfig } from "../config.js";
import { runChatCli } from "./chat-cli.js";
import { processChatMessage } from "./chat-factory.js";
import {
  createChatSession,
  loadChatSession,
  markPendingPlan,
} from "./chat-session.js";
import { DEFAULT_CHAT_CONFIG } from "./chat-config.js";

/** Capture stdout.write for the duration of `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

function makeService(overrides: Partial<EngramAccessService> = {}): EngramAccessService {
  return {
    fallbackLlmRef: {
      chatCompletion: async () => ({ content: "Based on memory_search, your database uses PostgreSQL [id: abc]." }),
    },
    configRef: parseConfig({ memoryDir: "/tmp/chat-cli-test", chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    memoryDir: "/tmp/chat-cli-test",
    memoryGet: () => Promise.resolve(null),
    memoryTimeline: () => Promise.resolve([]),
    memorySearch: () => Promise.resolve({ results: [{ path: "mem/abc.md", score: 0.9, snippet: "PostgreSQL" }], count: 1 }),
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
  managedWithTempDir(fn, "chat-cli-");

test("CLI --once mode: prints the assistant reply and session id", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const out = await captureStdout(() =>
      runChatCli({
        service,
        config: service.configRef!.chat,
        memoryDir,
        once: true,
        input: "what database do I use?",
      }),
    );
    assert.ok(out.includes("PostgreSQL"), `expected reply in stdout, got: ${out}`);
    assert.ok(out.includes("[session:"), "session id should be printed for --once mode");
  });
});

test("CLI --once mode: no input → tagged error", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const out = await captureStdout(() =>
      runChatCli({
        service,
        config: service.configRef!.chat,
        memoryDir,
        once: true,
        input: "   ",
      }),
    );
    assert.ok(out.includes("[error]"), `expected error tag, got: ${out}`);
  });
});

test("CLI: no LLM available → tagged error reply", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      fallbackLlmRef: null,
      localLlmRef: null,
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    const out = await captureStdout(() =>
      runChatCli({
        service,
        config: service.configRef!.chat,
        memoryDir,
        once: true,
        input: "hi",
      }),
    );
    assert.ok(out.includes("[error]"), `expected error tag, got: ${out}`);
    assert.ok(out.toLowerCase().includes("llm") || out.toLowerCase().includes("model"), "should mention model availability");
  });
});

test("CLI: resumes an existing session by id", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });
    // First message creates a session.
    const first = await captureStdout(() =>
      runChatCli({ service, config: service.configRef!.chat, memoryDir, once: true, input: "hello" }),
    );
    const sessionMatch = /\[session: ([^\]]+)\]/.exec(first);
    assert.ok(sessionMatch, "first run should print a session id");
    const sessionId = sessionMatch[1]!;
    // Second message resumes it.
    const second = await captureStdout(() =>
      runChatCli({ service, config: service.configRef!.chat, memoryDir, once: true, input: "again", sessionId }),
    );
    assert.ok(second.includes("[session:"), "resumed run should also print a session id");
  });
});

test("CLI --once: pending plan is visible on reload the same way as HTTP (issue #2479)", async () => {
  await withTempDir(async (memoryDir) => {
    const service = makeService({
      memoryDir,
      configRef: parseConfig({ memoryDir, chat: { ...DEFAULT_CHAT_CONFIG, enabled: true } }),
    });

    // CLI side: first turn mints the session.
    const first = await captureStdout(() =>
      runChatCli({ service, config: service.configRef!.chat, memoryDir, once: true, input: "hello" }),
    );
    const sessionId = /\[session: ([^\]]+)\]/.exec(first)![1]!;
    // Pending plan minted by an earlier correction-preview turn.
    await markPendingPlan(memoryDir, sessionId, "plan-cli-2479");
    await captureStdout(() =>
      runChatCli({ service, config: service.configRef!.chat, memoryDir, once: true, input: "anything else?", sessionId }),
    );
    const viaCli = await loadChatSession(memoryDir, sessionId);
    // HTTP side: identical scenario through the shared processor.
    const httpSession = await createChatSession(memoryDir, {});
    await processChatMessage({
      service,
      config: service.configRef!.chat,
      memoryDir,
      message: "hello",
      chatSessionId: httpSession.id,
    });
    await markPendingPlan(memoryDir, httpSession.id, "plan-http-2479");
    await processChatMessage({
      service,
      config: service.configRef!.chat,
      memoryDir,
      message: "anything else?",
      chatSessionId: httpSession.id,
    });
    const viaHttp = await loadChatSession(memoryDir, httpSession.id);

    assert.equal(viaCli?.pendingPlanId, "plan-cli-2479", "CLI turn must leave the pending plan visible on reload");
    assert.equal(viaHttp?.pendingPlanId, "plan-http-2479", "HTTP turn must leave the pending plan visible on reload");
    // Transcript shape parity: both surfaces append the same role sequence.
    assert.deepEqual(
      viaCli!.transcript.map((e) => e.role),
      viaHttp!.transcript.map((e) => e.role),
    );
  });
});
