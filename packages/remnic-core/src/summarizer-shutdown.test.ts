// Shutdown-signal behavioral tests for HourlySummarizer: an aborted
// summarizer must abort its in-flight local LLM call (the abort reaches the
// client stub) and must refuse to start new summary work once aborted.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { initLogger, resetLogger } from "./logger.js";
import { HourlySummarizer } from "./summarizer.js";
import type { LocalLlmChatCompletionOptions } from "./local-llm-helpers.js";
import type { TranscriptEntry } from "./types.js";

function createConfig(memoryDir: string) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    localLlmEnabled: true,
    localLlmModel: "test-local-model",
    localLlmUrl: "http://127.0.0.1:9",
    localLlmTimeoutMs: 600_000,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 30_000,
    hourlySummariesEnabled: true,
    hourlySummariesExtendedEnabled: false,
    debug: false,
  });
}

interface LlmStub {
  calls: { signal: AbortSignal | undefined }[];
}

function stubLocalLlm(summarizer: HourlySummarizer, stub: LlmStub): void {
  // SAFETY: localLlm is a private field, stubbed at the established field
  // seam with the client's real call shape; the stub parks until its caller
  // signal aborts (real transport behavior), mirroring a wedged local LLM.
  (summarizer as any).localLlm = {
    chatCompletion: async (
      messages: Array<{ role: string; content: string }>,
      options: LocalLlmChatCompletionOptions,
    ): Promise<null> => {
      void messages;
      stub.calls.push({ signal: options.signal });
      const { promise, reject } = Promise.withResolvers<null>();
      const onAbort = (): void => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      };
      const signal = options.signal;
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      return await promise;
    },
  };
}

async function withTestDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${label}: test deadline exceeded (${timeoutMs}ms)`)), timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function quietLogger(): void {
  initLogger({ info() {}, warn() {}, error() {}, debug() {} }, false);
}

function entriesFor(): TranscriptEntry[] {
  return [
    {
      role: "user",
      content: "bounded shutdown summarizer test entry",
      timestamp: new Date(Date.now() - 3_600_000).toISOString(),
      sessionKey: "sess-summary-shutdown",
      turnId: "turn-shutdown-1",
    },
  ];
}

test("aborting the shutdown signal aborts an in-flight generateSummary and reaches the LLM stub", async () => {
  quietLogger();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-summary-shutdown-inflight-"));
  const stub: LlmStub = { calls: [] };
  try {
    const controller = new AbortController();
    const summarizer = new HourlySummarizer(
      createConfig(memoryDir),
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    stubLocalLlm(summarizer, stub);

    const hourStart = new Date(Date.now() - 3_600_000);
    hourStart.setMinutes(0, 0, 0);
    const pending = summarizer.generateSummary("sess-summary-shutdown", hourStart, entriesFor());

    await withTestDeadline((async () => {
      while (stub.calls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })(), 5_000, "LLM stub to be entered");
    controller.abort();

    const result = await withTestDeadline(pending, 2_000, "in-flight summarizer abort");
    assert.equal(result, null);
    assert.equal(stub.calls.length, 1, "no second LLM attempt may start after abort");
    assert.equal(stub.calls[0]?.signal?.aborted, true, "the shutdown abort must reach the LLM stub");
  } finally {
    resetLogger();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an already-aborted summarizer refuses to start new work and never contacts the LLM", async () => {
  quietLogger();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-summary-shutdown-refuse-"));
  const stub: LlmStub = { calls: [] };
  try {
    const controller = new AbortController();
    controller.abort();
    const summarizer = new HourlySummarizer(
      createConfig(memoryDir),
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    stubLocalLlm(summarizer, stub);

    const hourStart = new Date(Date.now() - 3_600_000);
    hourStart.setMinutes(0, 0, 0);
    await assert.rejects(
      summarizer.generateSummary("sess-summary-shutdown", hourStart, entriesFor()),
    );
    assert.equal(stub.calls.length, 0, "aborted summarizer must not start new LLM work");
  } finally {
    resetLogger();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
