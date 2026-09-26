/**
 * parseClassifyResponse regression tests (issue #3134).
 *
 * Proves the correction planner's single LLM-response parse chokepoint:
 *  - fenced JSON responses (```json … ```) parse into real actions instead of
 *    degrading to the deterministic fallback (#3134, same class as #1514);
 *  - genuinely non-JSON responses still return the byte-identical
 *    deterministic fallback (rule 13);
 *  - bare JSON keeps parsing through the same candidate chain.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseClassifyResponse } from "./correction-access-wiring.js";
import type { PlannerCandidate } from "./correction-planner.js";

const CANDIDATES: PlannerCandidate[] = [
  { memoryId: "m1", path: "facts/m1.md", content: "m1 content", excerpt: "m1 excerpt", score: 1 },
];

const CLASSIFY_JSON = JSON.stringify({
  classification: "wrong",
  confidence: 0.9,
  actions: [{ kind: "edit", memoryId: "m1", patch: "m1 corrected content" }],
  relevance: [{ memoryId: "m1", why: "names the corrected fact" }],
});

test("#3134 fenced json classify response parses into actions instead of fallback", () => {
  const result = parseClassifyResponse(["```json", CLASSIFY_JSON, "```"].join("\n"), CANDIDATES);
  assert.equal(result.fallback, undefined, "a fenced response must not degrade to the fallback");
  assert.equal(result.classification, "wrong");
  assert.equal(result.confidence, 0.9);
  assert.deepEqual(result.actions, [{ kind: "edit", memoryId: "m1", patch: "m1 corrected content" }]);
  assert.deepEqual(result.relevance, [{ memoryId: "m1", why: "names the corrected fact" }]);
  assert.deepEqual(result.warnings, []);
});

test("#3134 fenced response without a language tag parses", () => {
  const result = parseClassifyResponse(["```", CLASSIFY_JSON, "```"].join("\n"), CANDIDATES);
  assert.equal(result.fallback, undefined);
  assert.equal(result.actions.length, 1);
});

test("#3134 prose-wrapped fenced response with trailing prose parses", () => {
  const result = parseClassifyResponse(
    ["Here is the classification:", "```json", CLASSIFY_JSON, "```", "Done."].join("\n"),
    CANDIDATES
  );
  assert.equal(result.fallback, undefined);
  assert.equal(result.actions.length, 1);
});

test("#3134 bare JSON with an inner markdown code block keeps its patch content verbatim", () => {
  const patch = "```\nconst fixed = true;\n```";
  const result = parseClassifyResponse(
    JSON.stringify({
      classification: "wrong",
      confidence: 0.8,
      actions: [{ kind: "edit", memoryId: "m1", patch }],
    }),
    CANDIDATES
  );
  assert.equal(result.fallback, undefined, "valid bare JSON must not degrade to the fallback");
  assert.deepEqual(result.actions, [{ kind: "edit", memoryId: "m1", patch }], "inner code-block delimiters must survive verbatim");
});

test("#3134 outer-fenced JSON with an inner code block parses with the patch verbatim", () => {
  const patch = "```py\nprint(\"fixed\")\n```";
  const inner = JSON.stringify({
    classification: "wrong",
    confidence: 0.8,
    actions: [{ kind: "edit", memoryId: "m1", patch }],
  });
  const result = parseClassifyResponse(["```json", inner, "```"].join("\n"), CANDIDATES);
  assert.equal(result.fallback, undefined, "an outer fence plus an inner code block must not degrade to the fallback");
  assert.deepEqual(result.actions, [{ kind: "edit", memoryId: "m1", patch }], "inner code-block delimiters must survive verbatim");
});

test("#3134 genuinely non-JSON response still returns the deterministic fallback", () => {
  const result = parseClassifyResponse("I'm sorry, I cannot classify that request.", CANDIDATES);
  assert.deepEqual(result, {
    classification: "outdated",
    confidence: 0,
    actions: [],
    relevance: [{ memoryId: "m1", why: "located for review" }],
    warnings: ["LLM returned non-JSON response"],
    fallback: true,
  });
});

test("#3134 empty response still returns the deterministic fallback", () => {
  const result = parseClassifyResponse("", CANDIDATES);
  assert.equal(result.fallback, true);
  assert.deepEqual(result.warnings, ["LLM returned non-JSON response"]);
});

test("#3134 bare JSON keeps parsing through the same candidate chain", () => {
  const result = parseClassifyResponse(CLASSIFY_JSON, CANDIDATES);
  assert.equal(result.fallback, undefined);
  assert.equal(result.classification, "wrong");
  assert.equal(result.confidence, 0.9);
  assert.equal(result.actions.length, 1);
});

test("#3134 bare JSON object with no actions still parses without fallback", () => {
  const result = parseClassifyResponse(
    JSON.stringify({ classification: "incomplete", confidence: 0.4, actions: [] }),
    CANDIDATES
  );
  assert.equal(result.fallback, undefined);
  assert.equal(result.classification, "incomplete");
  assert.equal(result.actions.length, 0);
});

test("#3145 skips unrelated JSON objects before the correction response", () => {
  const result = parseClassifyResponse("Example: {}\nAnswer: " + CLASSIFY_JSON, CANDIDATES);
  assert.equal(result.fallback, undefined);
  assert.equal(result.classification, "wrong");
  assert.equal(result.actions.length, 1);
});

test("#3145 rejects ambiguous valid correction drafts instead of choosing an example", () => {
  const other = JSON.stringify({ classification: "outdated", confidence: 0.99,
    actions: [{ kind: "edit", memoryId: "m1", patch: "wrong example" }] });
  const result = parseClassifyResponse(other + "\nActual answer: " + CLASSIFY_JSON, CANDIDATES);
  assert.equal(result.fallback, true);
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.actions, []);
});

test("#3145 skips malformed correction actions before a valid response", () => {
  const malformed = JSON.stringify({ classification: "wrong", confidence: 0.9,
    actions: [{ kind: "invented-action" }] });
  const result = parseClassifyResponse(malformed + "\n" + CLASSIFY_JSON, CANDIDATES);
  assert.equal(result.fallback, undefined);
  assert.deepEqual(result.actions, [{ kind: "edit", memoryId: "m1", patch: "m1 corrected content" }]);
});

test("#3145 an unrelated standalone object never becomes a plausible correction", () => {
  const result = parseClassifyResponse("{}", CANDIDATES);
  assert.equal(result.fallback, true);
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.actions, []);
});
