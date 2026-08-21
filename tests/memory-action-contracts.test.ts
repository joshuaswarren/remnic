import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryActionEligibilityContextSchema,
  MemoryActionTypeSchema,
  parseMemoryActionEligibilityContext,
  parseMemoryActionType,
} from "../src/schemas.js";

test("MemoryActionTypeSchema supports the full v8.13 action taxonomy", () => {
  const allowed = [
    "store_episode",
    "store_note",
    "update_note",
    "create_artifact",
    "summarize_node",
    "discard",
    "link_graph",
  ] as const;

  for (const action of allowed) {
    const parsed = MemoryActionTypeSchema.safeParse(action);
    assert.equal(parsed.success, true, `expected ${action} to be accepted`);
  }
});

test("parseMemoryActionType falls back to discard for invalid values", () => {
  assert.equal(parseMemoryActionType("invalid_action"), "discard");
  assert.equal(parseMemoryActionType(null), "discard");
});

test("MemoryActionEligibilityContextSchema is strict", () => {
  const parsed = MemoryActionEligibilityContextSchema.safeParse({
    confidence: 0.82,
    lifecycleState: "active",
    importance: 0.67,
    source: "extraction",
    unexpected: true,
  });
  assert.equal(parsed.success, false);
});

test("parseMemoryActionEligibilityContext returns default-safe fallback", () => {
  assert.deepEqual(parseMemoryActionEligibilityContext(undefined), {
    confidence: 0,
    lifecycleState: "candidate",
    importance: 0,
    source: "unknown",
  });
  assert.deepEqual(
    parseMemoryActionEligibilityContext({
      confidence: 2,
      lifecycleState: "active",
      importance: 0.2,
      source: "manual",
    }),
    {
      confidence: 0,
      lifecycleState: "candidate",
      importance: 0,
      source: "unknown",
    },
  );
});

test("parseMemoryActionEligibilityContext keeps valid payload unchanged", () => {
  const input = {
    confidence: 0.72,
    lifecycleState: "validated",
    importance: 0.55,
    source: "consolidation",
  } as const;
  assert.deepEqual(parseMemoryActionEligibilityContext(input), input);
});
