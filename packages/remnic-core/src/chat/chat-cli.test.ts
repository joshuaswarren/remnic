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
