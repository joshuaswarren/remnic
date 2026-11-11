import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUnusableReplyDiagnostic,
  formatUnusableReplyDiagnostic,
} from "./extraction-reply-diagnostic.js";

const SECRET = "SECRETVALUE-4821";

// Every produced field and the rendered line must be free of reply content.
function assertNoContent(reply: string, sentinels: string[], allowedKeys: string[] = []): void {
  const diag = buildUnusableReplyDiagnostic(reply, undefined, 0);
  const rendered = `${JSON.stringify(diag)} ${formatUnusableReplyDiagnostic(diag)}`;
  for (const sentinel of sentinels) assert.equal(rendered.includes(sentinel), false, `leaked ${sentinel}`);
  assert.deepEqual(diag.topLevelKeys.filter((k) => !allowedKeys.includes(k)), []);
}

test("commentary: no braces, nothing parses (the whole reply is the one candidate the extractor tries)", () => {
  const reply = `I read the conversation about ${SECRET} and have no durable facts to report.`;
  assert.deepEqual(buildUnusableReplyDiagnostic(reply, "stop", 0), {
    replyChars: reply.length,
    finishReason: "stop",
    startsWithBrace: false,
    jsonCandidates: 1,
    parsedAnyJson: false,
    payloadShapeRejected: 0,
    topLevelKeys: [],
    partialFacts: 0,
  });
  assertNoContent(reply, [SECRET, "durable facts", "conversation"]);
});

test("refusal: no JSON, finish reason carried", () => {
  const reply = `I'm sorry, I can't help with ${SECRET}.`;
  const diag = buildUnusableReplyDiagnostic(reply, "content_filter", 0);
  assert.equal(diag.finishReason, "content_filter");
  assert.equal(diag.parsedAnyJson, false);
  assert.equal(diag.startsWithBrace, false);
  assertNoContent(reply, [SECRET, "sorry"]);
});

test("valid JSON of the wrong shape: parsed, shape rejected, safe keys kept, hostile keys omitted", () => {
  const long = "k".repeat(33);
  const reply = JSON.stringify({ summary: SECRET, "user@example.com": 1, [long]: 2, "has space": 3, result_set: [SECRET] });
  const diag = buildUnusableReplyDiagnostic(reply, "stop", 0);
  assert.equal(diag.startsWithBrace, true);
  assert.equal(diag.parsedAnyJson, true);
  assert.ok(diag.payloadShapeRejected >= 1);
  assert.deepEqual(diag.topLevelKeys, ["summary", "result_set"]);
  assertNoContent(reply, [SECRET, "user@example.com", long, "has space"], ["summary", "result_set"]);
});

test("top-level keys are capped at 8 and come from the first parsed candidate", () => {
  const first = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, i]));
  const reply = `${JSON.stringify(first)}\n${JSON.stringify({ other: 1 })}`;
  const diag = buildUnusableReplyDiagnostic(reply, undefined, 0);
  assert.deepEqual(diag.topLevelKeys, ["key0", "key1", "key2", "key3", "key4", "key5", "key6", "key7"]);
});

test("a JSON array parses but exposes no keys", () => {
  const diag = buildUnusableReplyDiagnostic(`[{"a":"${SECRET}"}]`, undefined, 0);
  assert.equal(diag.parsedAnyJson, true);
  assert.deepEqual(diag.topLevelKeys, []);
  assert.equal(diag.startsWithBrace, false);
});

test("truncated JSON: starts with a brace, never parses", () => {
  const reply = `{"facts":[{"content":"${SECRET} is the`;
  const diag = buildUnusableReplyDiagnostic(reply, "length", 2);
  assert.equal(diag.startsWithBrace, true);
  assert.equal(diag.parsedAnyJson, false);
  assert.equal(diag.finishReason, "length");
  assert.equal(diag.partialFacts, 2);
  assert.deepEqual(diag.topLevelKeys, []);
  assertNoContent(reply, [SECRET, "is the"]);
});

test("empty reply", () => {
  assert.deepEqual(buildUnusableReplyDiagnostic("", undefined, 0), {
    replyChars: 0,
    finishReason: undefined,
    startsWithBrace: false,
    jsonCandidates: 0,
    parsedAnyJson: false,
    payloadShapeRejected: 0,
    topLevelKeys: [],
    partialFacts: 0,
  });
});

test("fenced json block of the wrong shape: parsed through the fence, content absent", () => {
  const reply = "```json\n" + JSON.stringify({ note: SECRET }) + "\n```";
  const diag = buildUnusableReplyDiagnostic(reply, "stop", 0);
  assert.equal(diag.startsWithBrace, false);
  assert.equal(diag.parsedAnyJson, true);
  assert.ok(diag.payloadShapeRejected >= 1);
  assert.deepEqual(diag.topLevelKeys, ["note"]);
  assertNoContent(reply, [SECRET], ["note"]);
});

test("finish reason that is not identifier-shaped is omitted", () => {
  for (const hostile of ["x y", "a".repeat(33), `${SECRET}!`, 42, null, {}]) {
    assert.equal(buildUnusableReplyDiagnostic("hello", hostile, 0).finishReason, undefined);
  }
});

test("rendered line has a stable greppable shape", () => {
  const line = formatUnusableReplyDiagnostic(
    buildUnusableReplyDiagnostic('{"answer":"x"}', "stop", 0),
  );
  assert.equal(
    line,
    "extractWithLocalLlm: unusable local reply replyChars=14 finishReason=stop startsWithBrace=true jsonCandidates=1 parsedAnyJson=true payloadShapeRejected=1 topLevelKeys=answer partialFacts=0",
  );
});
