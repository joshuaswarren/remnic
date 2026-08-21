import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";

type SummarizeFn = (text: string, targetTokens: number, aggressive: boolean) => Promise<string | null>;

interface LcmEngineTestSurface {
  summarizeFn: SummarizeFn;
}

interface ChatStub {
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}

/**
 * Minimal OpenAI-compatible chat stub that records how often it served a
 * completion. Both lanes get one so the test can observe which client the
 * LCM summarize closure actually uses.
 */
async function startChatStub(label: string): Promise<ChatStub> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url?.endsWith("/chat/completions")) {
        hits += 1;
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
