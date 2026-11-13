import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { estimateTokenCount } from "./token-estimate.js";

type SummarizeFn = (text: string, targetTokens: number, aggressive: boolean) => Promise<string | null>;

interface LcmEngineTestSurface {
  summarizeFn: SummarizeFn;
}

interface ChatStub {
  url: string;
  hits: () => number;
  /** Raw chat-completion request bodies, in arrival order. */
  requests: () => string[];
  close: () => Promise<void>;
}

/**
 * Minimal OpenAI-compatible chat stub that records how often it served a
 * completion. Both lanes get one so the test can observe which client the
 * LCM summarize closure actually uses.
 */
async function startChatStub(label: string): Promise<ChatStub> {
  let hits = 0;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url?.endsWith("/chat/completions")) {
        hits += 1;
        requests.push(body);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `summary from ${label}` }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          }),
        );
        return;
      }
      // Model detection / health probes: report a single model per lane.
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: `${label}-model` }], object: "list" }));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  try {
    await listening.promise;
  } catch (err) {
    server.close();
    throw err;
  }
  const address = server.address();
  if (address === null || typeof address !== "object") {
    server.close();
    throw new Error("stub did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    hits: () => hits,
    requests: () => requests,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

test("LCM summarize uses the fast local-LLM lane when configured (latency contract)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lcm-lane-"));
  let mainStub: ChatStub | null = null;
  let fastStub: ChatStub | null = null;
  try {
    mainStub = await startChatStub("main");
    fastStub = await startChatStub("fast");
    const config = parseConfig({
      memoryDir,
      qmdEnabled: false,
      lcmEnabled: true,
      localLlmEnabled: true,
      localLlmUrl: mainStub.url,
      localLlmModel: "main-model",
      localLlmFastEnabled: true,
      localLlmFastUrl: fastStub.url,
      localLlmFastModel: "fast-model",
    });
    const orchestrator = new Orchestrator(config);
    assert.ok(orchestrator.lcmEngine, "LCM engine must exist with lcmEnabled");
    const summarizeFn = (orchestrator.lcmEngine as unknown as LcmEngineTestSurface).summarizeFn;

    const result = await summarizeFn("A conversation segment worth compressing.", 64, false);

    assert.equal(result, "summary from fast", "the summary must come from the fast lane");
    assert.equal(fastStub.hits(), 1, "fast lane serves the LCM summarize call");
    assert.equal(mainStub.hits(), 0, "the heavy main extraction lane must not serve lcm-summarize");
  } finally {
    await mainStub?.close();
    await fastStub?.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("LCM summarize falls back to the main client when the fast lane is disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lcm-lane-fallback-"));
  let mainStub: ChatStub | null = null;
  try {
    mainStub = await startChatStub("main");
    const config = parseConfig({
      memoryDir,
      qmdEnabled: false,
      lcmEnabled: true,
      localLlmEnabled: true,
      localLlmUrl: mainStub.url,
      localLlmModel: "main-model",
      localLlmFastEnabled: false,
    });
    const orchestrator = new Orchestrator(config);
    assert.ok(orchestrator.lcmEngine, "LCM engine must exist with lcmEnabled");
    const summarizeFn = (orchestrator.lcmEngine as unknown as LcmEngineTestSurface).summarizeFn;

    const result = await summarizeFn("A conversation segment worth compressing.", 64, false);

    assert.equal(result, "summary from main", "with no fast lane the main client serves the call");
    assert.equal(mainStub.hits(), 1);
  } finally {
    await mainStub?.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

/** The chat-completion request fields the budget test asserts on. */
const ChatRequestSchema = z.object({
  max_tokens: z.number().int(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

test("LCM summarize sizes the completion budget by the text it sends, not the whole batch", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lcm-budget-"));
  let mainStub: ChatStub | null = null;
  try {
    mainStub = await startChatStub("main");
    const config = parseConfig({
      memoryDir,
      qmdEnabled: false,
      lcmEnabled: true,
      localLlmEnabled: true,
      localLlmUrl: mainStub.url,
      localLlmModel: "main-model",
      localLlmFastEnabled: false,
    });
    const engine = new Orchestrator(config).lcmEngine;
    assert.ok(engine, "LCM engine must exist with lcmEnabled");
    const summarizeFn = engine["summarizeFn"];

    // A long leaf batch: LcmSummarizer targets 25% of the whole batch, but the
    // call sends only a prefix. Batch sizing would request well over 16,384.
    const batch = "[user] the deploy failed at step three; retry it with the cached artifact.\n\n".repeat(3_000);
    const batchTarget = Math.max(64, Math.ceil(estimateTokenCount(batch) * 0.25));
    assert.ok(batchTarget * 2 > 16_384, "fixture must exceed a common provider output cap under batch sizing");

    const result = await summarizeFn(batch, batchTarget, false);

    assert.equal(result, "summary from main");
    const [rawRequest] = mainStub.requests();
    const request = ChatRequestSchema.parse(JSON.parse(rawRequest));
    const [system, user] = request.messages;
    const sentTokens = estimateTokenCount(user.content);
    assert.ok(user.content.length < batch.length, "only a prefix of the batch is sent");
    assert.ok(
      request.max_tokens <= 2 * (Math.ceil(sentTokens * 0.25) + 1),
      `max_tokens ${request.max_tokens} must track the ${sentTokens} tokens sent`,
    );
    assert.ok(system.content.includes(`maximum ${request.max_tokens / 2} tokens`));
  } finally {
    await mainStub?.close();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
