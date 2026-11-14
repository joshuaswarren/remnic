import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUnusableReplyDiagnostic,
  formatUnusableReplyDiagnostic,
} from "./extraction-reply-diagnostic.js";

const SECRET = "SECRETVALUE-4821";

/**
 * Builds and renders the diagnostic for `reply`, then asserts no sentinel
 * substring appears anywhere in either form; `allowedKeys` lists the key names
 * expected to survive, and any other extracted key fails the assert.
 */
function assertNoContent(reply: string, sentinels: string[], allowedKeys: string[] = []): void {
  const diag = buildUnusableReplyDiagnostic(reply, undefined, 0);
  const rendered = `${JSON.stringify(diag)} ${formatUnusableReplyDiagnostic(diag)}`;
  for (const sentinel of sentinels) assert.equal(rendered.includes(sentinel), false, `leaked ${sentinel}`);
  assert.deepEqual(diag.topLevelKeys.filter((k) => !allowedKeys.includes(k)), []);
}

/** The most common failure mode: prose with no JSON. Pins that the whole reply is exactly one candidate and every rendered field is content-free. */
test("commentary: no braces, nothing parses (the whole reply is the one candidate the extractor tries)", () => {
  const reply = `I read the conversation about ${SECRET} and have no durable facts to report.`;
  assert.deepEqual(buildUnusableReplyDiagnostic(reply, "stop", 0), {
    replyChars: reply.length,
    finishReason: "stop",
    startsWithBrace: false,
    jsonCandidates: 1,
    parsedAnyJson: false,
    unrecognizedPayloads: 0,
    topLevelKeys: [],
    partialFacts: 0,
  });
  assertNoContent(reply, [SECRET, "durable facts", "conversation"]);
});

/** A refusal is textually indistinguishable from commentary; only the client-supplied finish reason lets an operator tell them apart. */
test("refusal: no JSON, finish reason carried", () => {
  const reply = `I'm sorry, I can't help with ${SECRET}.`;
  const diag = buildUnusableReplyDiagnostic(reply, "content_filter", 0);
  assert.equal(diag.finishReason, "content_filter");
  assert.equal(diag.parsedAnyJson, false);
  assert.equal(diag.startsWithBrace, false);
  assertNoContent(reply, [SECRET, "sorry"]);
});

/** Key names may be logged but values must never be: hostile key shapes are filtered and values are never read at all. */
test("valid JSON of the wrong shape: parsed, shape rejected, safe keys kept, hostile keys omitted", () => {
  const long = "k".repeat(33);
  const reply = JSON.stringify({ summary: SECRET, "user@example.com": 1, [long]: 2, "has space": 3, result_set: [SECRET] });
  const diag = buildUnusableReplyDiagnostic(reply, "stop", 0);
  assert.equal(diag.startsWithBrace, true);
  assert.equal(diag.parsedAnyJson, true);
  assert.ok(diag.unrecognizedPayloads >= 1);
  assert.deepEqual(diag.topLevelKeys, ["summary", "result_set"]);
  assertNoContent(reply, [SECRET, "user@example.com", long, "has space"], ["summary", "result_set"]);
});

/** Bounds the worst case so a model echoing many keys cannot bloat the warn line; keys come from the first parse so repeated runs stay stable. */
test("top-level keys are capped at 8 and come from the first parsed candidate", () => {
  const first = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, i]));
  const reply = `${JSON.stringify(first)}\n${JSON.stringify({ other: 1 })}`;
  const diag = buildUnusableReplyDiagnostic(reply, undefined, 0);
  assert.deepEqual(diag.topLevelKeys, ["key0", "key1", "key2", "key3", "key4", "key5", "key6", "key7"]);
});

/** Pins the parser treating a top-level array as keyless: index keys like "0" must not surface as if they were payload names. */
test("a JSON array parses but exposes no keys", () => {
  const diag = buildUnusableReplyDiagnostic(`[{"a":"${SECRET}"}]`, undefined, 0);
  assert.equal(diag.parsedAnyJson, true);
  assert.deepEqual(diag.topLevelKeys, []);
  assert.equal(diag.startsWithBrace, false);
});

/** The cut-off case from the issue: brace at position zero but nothing parseable, with partialFacts echoing what upstream salvage already recovered. */
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

/** Zero state: the HTTP-refusal site builds this from an empty reply, so the line reads "no candidates tried" without implying a malformed one. */
test("empty reply", () => {
  assert.deepEqual(buildUnusableReplyDiagnostic("", undefined, 0), {
    replyChars: 0,
    finishReason: undefined,
    startsWithBrace: false,
    jsonCandidates: 0,
    parsedAnyJson: false,
    unrecognizedPayloads: 0,
    topLevelKeys: [],
    partialFacts: 0,
  });
});

/** Fenced JSON parses through the fence but starts with a backtick, so startsWithBrace stays false — the signature of "JSON arrived, wrapped". */
test("fenced json block of the wrong shape: parsed through the fence, content absent", () => {
  const reply = "```json\n" + JSON.stringify({ note: SECRET }) + "\n```";
  const diag = buildUnusableReplyDiagnostic(reply, "stop", 0);
  assert.equal(diag.startsWithBrace, false);
  assert.equal(diag.parsedAnyJson, true);
  assert.ok(diag.unrecognizedPayloads >= 1);
  assert.deepEqual(diag.topLevelKeys, ["note"]);
  assertNoContent(reply, [SECRET], ["note"]);
});

/** finish_reason is untrusted wire data from the local server; only identifier-shaped values survive validation, everything else is omitted rather than logged. */
test("finish reason that is not identifier-shaped is omitted", () => {
  for (const hostile of ["x y", "a".repeat(33), `${SECRET}!`]) {
    assert.equal(buildUnusableReplyDiagnostic("hello", hostile, 0).finishReason, undefined);
  }
});

/** Pins the exact rendering so log greps and parsers survive refactors of either module. */
test("rendered line has a stable greppable shape", () => {
  const line = formatUnusableReplyDiagnostic(
    buildUnusableReplyDiagnostic('{"answer":"x"}', "stop", 0),
  );
  assert.equal(
    line,
    "extractWithLocalLlm: unusable local reply replyChars=14 finishReason=stop startsWithBrace=true jsonCandidates=1 parsedAnyJson=true unrecognizedPayloads=1 topLevelKeys=answer partialFacts=0",
  );
});
