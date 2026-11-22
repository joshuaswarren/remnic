import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../config.js";
import { ExtractionEngine } from "../extraction.js";
import { ModelRegistry } from "../model-registry.js";
import { Orchestrator } from "../orchestrator.js";
import { ProfilingCollector } from "../profiling.js";
import { cleanupDir, makeLifecycleConfig, mkTempMemoryDir } from "../testing/orchestrator-lite.js";
import type { BufferTurn } from "../types.js";
import { createDrainExtractionEngine } from "./drain-extraction.js";

const TURNS: BufferTurn[] = [
  { role: "user", content: "I keep my backups on the NAS in the garage.", timestamp: "2026-10-30T01:00:00.000Z" },
  { role: "assistant", content: "Noted.", timestamp: "2026-10-30T01:00:05.000Z" },
];

function createConfig(timeoutMs: number) {
  return parseConfig({
    localLlmEnabled: true,
    localLlmModel: "fixture-local",
    localLlmUrl: "http://127.0.0.1:1234",
    localLlmFallback: false,
    localLlmTimeoutMs: timeoutMs,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 1,
    slowLogEnabled: false,
  });
}

const modelsBody = JSON.stringify({ data: [{ id: "fixture-local" }] });
interface ModelStub {
  chatCalls(): number;
  restore(): void;
}

function stubModel(onChat: (init?: RequestInit) => Promise<Response>): ModelStub {
  const original = globalThis.fetch;
  let chat = 0;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/chat/completions")) {
      chat += 1;
      return onChat(init);
    }
    return Promise.resolve(new Response(modelsBody, { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { chatCalls: () => chat, restore: () => { globalThis.fetch = original; } };
}

function neverAnswers(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

function drainEngine(config: ReturnType<typeof createConfig>): ExtractionEngine {
  const profiler = new ProfilingCollector({ enabled: false, storageDir: "/tmp/engram-profiler-disabled", maxTraces: 0 });
  const unusedFast = async () => null;
  return createDrainExtractionEngine(config, profiler, new ModelRegistry(config.memoryDir), new AbortController().signal, unusedFast);
}

test("a timed-out attempt is retried by the live engine but not by the drain engine", async () => {
  const config = createConfig(30);
  const stub = stubModel(neverAnswers);
  try {
    await new ExtractionEngine(config).extract(TURNS);
    assert.equal(stub.chatCalls(), 2, "live engine: one retry after the abort");
    const before = stub.chatCalls();
    const result = await drainEngine(config).extract(TURNS);
    assert.equal(stub.chatCalls() - before, 1, "drain engine: one attempt");
    assert.equal(result.extractionFailureClass, "provider_retryable", "the failure still reaches the breaker as a provider failure");
  } finally {
    stub.restore();
  }
});

test("the orchestrator's claim-drain coordinator extracts with one attempt", async () => {
  const memoryDir = await mkTempMemoryDir("drain-extraction-wiring");
  // Real 30 ms attempt timer: the abort under test is the client's own wall-clock timeout.
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, {
      localLlmEnabled: true,
      localLlmModel: "fixture-local",
      localLlmUrl: "http://127.0.0.1:1234",
      localLlmFallback: false,
      localLlmTimeoutMs: 30,
      localLlmRetry5xxCount: 1,
      localLlmRetryBackoffMs: 1,
      slowLogEnabled: false,
    }),
  );
  const stub = stubModel(neverAnswers);
  try {
    const coordinator = orchestrator.extractionRunCoordinatorForBuffer(orchestrator.buffer);
    await coordinator.runExtraction(TURNS, {
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      clearBufferAfterExtraction: false,
      bufferKey: "drain-wiring",
    });
    assert.equal(stub.chatCalls(), 1, "a drain extraction is one attempt, not the live client's retry");
  } finally {
    stub.restore();
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});

function liveEngineOf(orchestrator: Orchestrator): ExtractionEngine {
  const live: unknown = Object.getOwnPropertyDescriptor(orchestrator, "extraction")?.value;
  assert.ok(live instanceof ExtractionEngine, "the orchestrator's live extraction engine");
  return live;
}

const emptyExtractionResponse = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ facts: [], entities: [], questions: [], profileUpdates: [] }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

test("a drain extraction starts while a live extraction holds the shared client", async () => {
  const memoryDir = await mkTempMemoryDir("drain-extraction-lane");
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(memoryDir, {
      localLlmEnabled: true,
      localLlmModel: "fixture-local",
      localLlmUrl: "http://127.0.0.1:1234",
      localLlmFallback: false,
      localLlmTimeoutMs: 5_000,
      localLlmRetry5xxCount: 0,
      slowLogEnabled: false,
    }),
  );
  const liveStarted = Promise.withResolvers<void>();
  let liveSettled = false;
  let liveSettledWhenDrainStarted: boolean | undefined;
  const original = globalThis.fetch;
  let chat = 0;
  // SAFETY: the client only calls fetch(url, init); the stub keeps that call shape and returns a Response.
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith("/chat/completions")) {
      return Promise.resolve(new Response(modelsBody, { status: 200, headers: { "content-type": "application/json" } }));
    }
    chat += 1;
    if (chat === 1) {
      liveStarted.resolve();
      return neverAnswers(init).catch((err: Error) => {
        liveSettled = true;
        throw err;
      });
    }
    liveSettledWhenDrainStarted ??= liveSettled;
    return Promise.resolve(emptyExtractionResponse());
  }) as typeof fetch;
  try {
    const live = liveEngineOf(orchestrator).extract(TURNS);
    await liveStarted.promise;
    await orchestrator.extractionRunCoordinatorForBuffer(orchestrator.buffer).runExtraction(TURNS, {
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      clearBufferAfterExtraction: false,
      bufferKey: "drain-lane",
    });
    assert.equal(liveSettledWhenDrainStarted, false, "the drain's model call started while the live request was still held");
    await orchestrator.destroy();
    await live;
  } finally {
    globalThis.fetch = original;
    await orchestrator.destroy().catch(() => undefined);
    await cleanupDir(memoryDir);
  }
});
