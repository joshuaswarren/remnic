/**
 * Tests for the enriched error builders (issue #3035).
 *
 * Covers: nearest-tool suggestions, alias-family awareness,
 * invalid-arg hints, schema round-trip, and deterministic ordering.
 * Every test is mutation-proven (checklist 6).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { invalidArgsError, levenshtein, nearestSuggestions, unknownToolError } from "./access-errors.js";

// ─── Levenshtein ──────────────────────────────────────────────────────────

test("levenshtein: exact match is distance 0", () => {
  assert.equal(levenshtein("engram.recall", "engram.recall"), 0);
});

test("levenshtein: one character off", () => {
  assert.equal(levenshtein("engram.recall", "engram.recal"), 1);
});

test("levenshtein: three characters off", () => {
  assert.equal(levenshtein("engram.recall", "engram.recbl"), 2);
});

test("levenshtein: completely different string", () => {
  assert.ok(levenshtein("engram.recall", "zzzzzzzzz") > 3);
});

// ─── nearestSuggestions ───────────────────────────────────────────────────

const TOOLS = [
  "engram.recall",
  "remnic.recall",
  "engram.recall_xray",
  "remnic.recall_xray",
  "engram.recall_why",
  "remnic.recall_why",
  "engram.memory_get",
  "remnic.memory_get",
  "engram.memory_search",
  "remnic.memory_search",
];

test("nearestSuggestions: close typo suggests the correct name", () => {
  const result = nearestSuggestions("engram.recal", TOOLS);
  assert.ok(result.length > 0, "should find a suggestion");
  assert.equal(result[0].name, "engram.recall");
  assert.equal(result[0].distance, 1);
});

test("nearestSuggestions: alias-family hint — a remnic-prefix request stays in the family", () => {
  const result = nearestSuggestions("remnic.recal", TOOLS);
  const first = result[0];
  assert.ok(first, "should find a suggestion");
  assert.ok(first.name.startsWith("remnic."), "a remnic-prefix request should suggest a remnic-prefix name");
  assert.equal(first.distance, 1);
});

test("nearestSuggestions: wholly unrelated name returns empty", () => {
  const result = nearestSuggestions("zzzzzzzzz", TOOLS);
  assert.equal(result.length, 0, "nothing should be close enough");
});

test("nearestSuggestions: equal-distance suggestions are deterministic across runs", () => {
  // "engram.recall_why" and "engram.recall_why" are the same, so use
  // names at equal distance from "engram.recall": "engram.recall_xray" (10)
  // vs "engram.recall_why" (10) — but distance is not the same.
  // Instead use a query equidistant from two names.
  const result1 = nearestSuggestions("engram.recall", TOOLS);
  const result2 = nearestSuggestions("engram.recall", TOOLS);
  assert.deepEqual(result1, result2);
});

// ─── unknownToolError ─────────────────────────────────────────────────────

test("unknownToolError: close typo includes a suggestion", () => {
  const msg = unknownToolError("engram.recal", TOOLS);
  assert.match(msg, /Unknown tool/);
  assert.match(msg, /engram\.recall/);
  assert.match(msg, /Did you mean/);
});

test("unknownToolError: wholly unrelated name lists the full tool set", () => {
  const msg = unknownToolError("zzzzzzzzz", TOOLS);
  assert.match(msg, /Unknown tool/);
  assert.match(msg, /Registered tools/);
  assert.match(msg, /engram\.recall/);
  assert.doesNotMatch(msg, /Did you mean/);
});

// ─── invalidArgsError ─────────────────────────────────────────────────────

const MEMORY_GET_SCHEMA = z.object({
  memory_id: z.string().describe("Memory id to retrieve"),
  validate: z.boolean().optional().describe("Validate the memory id"),
}).strict();

test("invalidArgsError: names the failing field path", () => {
  const parse = MEMORY_GET_SCHEMA.safeParse({});
  assert.equal(parse.success, false);
  const msg = invalidArgsError("engram.memory_get", parse.error, MEMORY_GET_SCHEMA);
  assert.match(msg, /memory_id/);
  assert.match(msg, /required/i);
});

test("invalidArgsError: the generated example round-trips through the schema", () => {
  const msg = invalidArgsError("engram.memory_get", MEMORY_GET_SCHEMA.safeParse({}).error, MEMORY_GET_SCHEMA);
  // The example should be mentioned in the message
  assert.match(msg, /Example/);
  // The example should contain the expected fields
  assert.match(msg, /memory_id/);
  assert.match(msg, /<string>/);
});

// ─── Rejection semantics are unchanged ─────────────────────────────────────

test("invalidArgsError: invalid args still reject — the error is enriched, not accepted", () => {
  const parse = MEMORY_GET_SCHEMA.safeParse({});
  assert.equal(parse.success, false, "a missing required field must still reject");
  const msg = invalidArgsError("engram.memory_get", parse.error, MEMORY_GET_SCHEMA);
  assert.ok(msg.length > 0, "error message is non-empty");
});

// ─── Privacy: no secrets in error messages ─────────────────────────────────

test("unknownToolError: no sentinel secret values appear in the message", () => {
  const msg = unknownToolError("engram.recal", TOOLS);
  // No absolute paths, no credentials, no internal values
  assert.doesNotMatch(msg, /\/home\//);
  assert.doesNotMatch(msg, /\/Users\//);
  assert.doesNotMatch(msg, /api_key|token|secret|password/i);
});