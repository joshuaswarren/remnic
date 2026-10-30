import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { ExtractionEngine } from "./extraction.js";
import type { BufferTurn } from "./types.js";

// Follow-up to #3266: the trigger drain drops a chunk after N failures, but not for an outage. Whether a local-model failure
// is the chunk's fault is decided here, by what the local endpoint did.
const TURNS: BufferTurn[] = [
  { role: "user", content: "I keep my backups on the NAS in the garage.", timestamp: "2026-10-30T01:00:00.000Z" },
  { role: "assistant", content: "Noted.", timestamp: "2026-10-30T01:00:05.000Z" },
];

type LocalMessages = Array<{ role: string; content: string }>;
type LocalStub = (messages: LocalMessages, options: { failureDiag?: { lastError?: Error } }) => Promise<{ content: string } | null>;

async function extractWith(local: LocalStub) {
  const engine = new ExtractionEngine(parseConfig({ localLlmEnabled: true, localLlmModel: "fixture-local", localLlmFallback: false }));
  const modelRegistry = { calculateContextSizes: () => ({ maxInputChars: 8_000, maxOutputTokens: 1_000, description: "fixture" }) };
  assert.equal(Reflect.set(engine, "localLlm", { chatCompletion: local }), true);
  assert.equal(Reflect.set(engine, "modelRegistry", modelRegistry), true);
  return await engine.extract(TURNS);
}

const withStatus = (status: number) => Object.assign(new Error("local LLM http failure"), { status });

test("a local endpoint that answers with something unusable rejects the chunk: parse_empty", async () => {
  const result = await extractWith(async () => ({ content: "I cannot help with that request." }));
  assert.equal(result.extractionFailure, "local_llm_error");
  assert.equal(result.extractionFailureClass, "parse_empty");
});

test("a local endpoint that answers with a client error rejects the chunk: parse_empty", async () => {
  for (const status of [400, 413, 422]) {
    const result = await extractWith(async (_messages, options) => {
      if (options.failureDiag) options.failureDiag.lastError = withStatus(status);
      return null;
    });
    assert.equal(result.extractionFailureClass, "parse_empty", `HTTP ${status}`);
  }
});

test("not the chunk's fault: unreachable, timeout, 5xx, 429, auth and a wrong model or route (404) stay provider_retryable", async () => {
  const outage = await extractWith(async () => null);
  assert.equal(outage.extractionFailure, "local_llm_unavailable");
  assert.equal(outage.extractionFailureClass, "provider_retryable");
  for (const status of [401, 403, 404, 405, 408, 410, 429, 500, 503]) {
    const result = await extractWith(async (_messages, options) => {
      if (options.failureDiag) options.failureDiag.lastError = withStatus(status);
      return null;
    });
    assert.equal(result.extractionFailureClass, "provider_retryable", `HTTP ${status}`);
  }
});
