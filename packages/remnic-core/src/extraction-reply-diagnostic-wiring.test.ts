import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { LocalLlmRejectedError } from "./extraction-error-classification.js";
import { ExtractionEngine } from "./extraction.js";
import { initLogger, resetLogger } from "./logger.js";
import type { BufferTurn } from "./types.js";

const SECRET = "SECRETVALUE-4821";
const TURNS: BufferTurn[] = [
  { role: "user", content: "I keep my backups on the NAS in the garage.", timestamp: "2026-10-30T01:00:00.000Z" },
  { role: "assistant", content: "Noted.", timestamp: "2026-10-30T01:00:05.000Z" },
];
const MARKER = "unusable local reply";

type Diag = { lastError?: Error; finishReason?: string };
type Stub = (messages: unknown, options: { failureDiag?: Diag }) => Promise<{ content: string } | null>;

function makeEngine(local: Stub): ExtractionEngine {
  const engine = new ExtractionEngine(parseConfig({ localLlmEnabled: true, localLlmModel: "fixture-local", localLlmFallback: false }));
  const modelRegistry = { calculateContextSizes: () => ({ maxInputChars: 8_000, maxOutputTokens: 1_000, description: "fixture" }) };
  assert.equal(Reflect.set(engine, "localLlm", { chatCompletion: local }), true);
  assert.equal(Reflect.set(engine, "modelRegistry", modelRegistry), true);
  return engine;
}

function captureWarns<T>(run: () => Promise<T>): Promise<{ value: T; warns: string[] }> {
  const warns: string[] = [];
  initLogger({
    info() {},
    warn: (msg, ...args) => warns.push([msg, ...args.map(String)].join(" ")),
    error() {},
  });
  return run().then((value) => ({ value, warns })).finally(resetLogger);
}

test("an unusable reply logs one content-free diagnostic and still classifies parse_empty", async () => {
  const reply = `Here is my analysis of ${SECRET}: nothing durable was said.`;
  const engine = makeEngine(async (_m, options) => {
    if (options.failureDiag) options.failureDiag.finishReason = "length";
    return { content: reply };
  });
  const { value: result, warns } = await captureWarns(() => engine.extract(TURNS));
  assert.equal(result.extractionFailure, "local_llm_error");
  assert.equal(result.extractionFailureClass, "parse_empty");
  const lines = warns.filter((w) => w.includes(MARKER));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`replyChars=${reply.length} finishReason=length startsWithBrace=false jsonCandidates=0 parsedAnyJson=false payloadShapeRejected=0 topLevelKeys= partialFacts=0`));
  for (const warn of warns) {
    assert.equal(warn.includes(SECRET), false);
    assert.equal(warn.includes("nothing durable"), false);
  }
});

test("wrong-shape JSON: the thrown error is the unchanged LocalLlmRejectedError and keys are reported", async () => {
  const reply = JSON.stringify({ summary: SECRET, "user@example.com": 1 });
  const engine = makeEngine(async () => ({ content: reply }));
  const extractWithLocalLlm = Reflect.get(engine, "extractWithLocalLlm") as (c: string) => Promise<unknown>;
  const { value: thrown, warns } = await captureWarns(async () => {
    try {
      await extractWithLocalLlm.call(engine, "User: hello");
      return undefined;
    } catch (err) {
      return err;
    }
  });
  assert.ok(thrown instanceof LocalLlmRejectedError);
  assert.equal(thrown.httpStatus, undefined);
  assert.equal(thrown.message, "local LLM answered with unusable content");
  const lines = warns.filter((w) => w.includes(MARKER));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /parsedAnyJson=true payloadShapeRejected=1 topLevelKeys=summary partialFacts=0/);
  for (const warn of warns) {
    assert.equal(warn.includes(SECRET), false);
    assert.equal(warn.includes("user@example.com"), false);
  }
});

test("a rejected request (HTTP 400, no reply) logs the same diagnostic once and keeps its status", async () => {
  const engine = makeEngine(async (_m, options) => {
    if (options.failureDiag) options.failureDiag.lastError = Object.assign(new Error("local LLM http failure"), { status: 400 });
    return null;
  });
  const extractWithLocalLlm = Reflect.get(engine, "extractWithLocalLlm") as (c: string) => Promise<unknown>;
  const { value: thrown, warns } = await captureWarns(async () => {
    try {
      await extractWithLocalLlm.call(engine, "User: hello");
      return undefined;
    } catch (err) {
      return err;
    }
  });
  assert.ok(thrown instanceof LocalLlmRejectedError);
  assert.equal(thrown.httpStatus, 400);
  const lines = warns.filter((w) => w.includes(MARKER));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /replyChars=0 /);
});
