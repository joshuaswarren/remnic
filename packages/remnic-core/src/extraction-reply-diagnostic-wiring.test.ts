import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import type { LocalFailureDiag } from "./extraction-error-classification.js";
import { ExtractionEngine } from "./extraction.js";
import { initLogger, resetLogger } from "./logger.js";
import type { BufferTurn } from "./types.js";

const SECRET = "SECRETVALUE-4821";
const TURNS: BufferTurn[] = [
  { role: "user", content: "I keep my backups on the NAS in the garage.", timestamp: "2026-10-30T01:00:00.000Z" },
  { role: "assistant", content: "Noted.", timestamp: "2026-10-30T01:00:05.000Z" },
];
const MARKER = "unusable local reply";

type LocalMessages = Array<{ role: string; content: string }>;
type LocalStub = (messages: LocalMessages, options: { failureDiag?: LocalFailureDiag }) => Promise<{ content: string } | null>;

async function extractCapturingWarns(local: LocalStub) {
  const engine = new ExtractionEngine(parseConfig({ localLlmEnabled: true, localLlmModel: "fixture-local", localLlmFallback: false }));
  const modelRegistry = { calculateContextSizes: () => ({ maxInputChars: 8_000, maxOutputTokens: 1_000, description: "fixture" }) };
  assert.equal(Reflect.set(engine, "localLlm", { chatCompletion: local }), true);
  assert.equal(Reflect.set(engine, "modelRegistry", modelRegistry), true);
  const warns: string[] = [];
  initLogger({
    info() {},
    warn: (msg, ...args) => warns.push([msg, ...args.map(String)].join(" ")),
    error() {},
  });
  try {
    return { result: await engine.extract(TURNS), warns };
  } finally {
    resetLogger();
  }
}

test("an unusable reply logs one content-free diagnostic; the rejection and parse_empty class are unchanged", async () => {
  const reply = `Here is my analysis of ${SECRET}: nothing durable was said.`;
  const { result, warns } = await extractCapturingWarns(async (_messages, options) => {
    if (options.failureDiag) options.failureDiag.finishReason = "length";
    return { content: reply };
  });
  assert.equal(result.extractionFailure, "local_llm_error");
  assert.equal(result.extractionFailureClass, "parse_empty");
  const lines = warns.filter((w) => w.includes(MARKER));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`replyChars=${reply.length} finishReason=length startsWithBrace=false jsonCandidates=1 parsedAnyJson=false unrecognizedPayloads=0 topLevelKeys= partialFacts=0`));
  assert.ok(warns.some((w) => w.includes("LocalLlmRejectedError: local LLM answered with unusable content")));
  for (const warn of warns) {
    assert.equal(warn.includes(SECRET), false);
    assert.equal(warn.includes("nothing durable"), false);
  }
});

test("wrong-shape JSON: key names are reported, values and unsafe keys are not", async () => {
  const reply = JSON.stringify({ summary: SECRET, "user@example.com": 1 });
  const { result, warns } = await extractCapturingWarns(async () => ({ content: reply }));
  assert.equal(result.extractionFailureClass, "parse_empty");
  const lines = warns.filter((w) => w.includes(MARKER));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /startsWithBrace=true jsonCandidates=1 parsedAnyJson=true unrecognizedPayloads=1 topLevelKeys=summary partialFacts=0/);
  for (const warn of warns) {
    assert.equal(warn.includes(SECRET), false);
    assert.equal(warn.includes("user@example.com"), false);
  }
});

test("a rejected request (HTTP 400, no reply) logs the same diagnostic once and keeps its status", async () => {
  const { result, warns } = await extractCapturingWarns(async (_messages, options) => {
    if (options.failureDiag) options.failureDiag.lastError = Object.assign(new Error("local LLM http failure"), { status: 400 });
    return null;
  });
  assert.equal(result.extractionFailureClass, "parse_empty");
  const lines = warns.filter((w) => w.includes(MARKER));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /replyChars=0 /);
  assert.ok(warns.some((w) => w.includes("LocalLlmRejectedError: local LLM rejected the input (HTTP 400)")));
});
