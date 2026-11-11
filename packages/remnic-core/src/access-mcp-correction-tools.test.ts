import assert from "node:assert/strict";
import test from "node:test";

import { correctionMcpTools } from "./access-mcp-correction-tools.js";

test("correctionMcpTools exposes plan and apply with closed schemas", () => {
  assert.equal(correctionMcpTools.length, 2);
  const names = correctionMcpTools.map((tool) => tool.name);
  assert.deepEqual(names, ["engram.memory_correct_plan", "engram.memory_correct_apply"]);

  for (const tool of correctionMcpTools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description && tool.description.length > 20);
  }
});

test("memory_correct_plan requires text and advertises duplicateOf", () => {
  const plan = correctionMcpTools.find((tool) => tool.name === "engram.memory_correct_plan");
  assert.ok(plan);
  assert.deepEqual(plan.inputSchema.required, ["text"]);
  const props = plan.inputSchema.properties as Record<string, { type?: string; items?: { type?: string } }>;
  assert.equal(props.text?.type, "string");
  assert.equal(props.duplicateOf?.type, "string");
  assert.equal(props.targetIds?.type, "array");
  assert.equal(props.targetIds?.items?.type, "string");
  assert.equal(props.sessionKey?.type, "string");
  assert.equal(props.namespace?.type, "string");
  assert.match(plan.description, /duplicateOf/);
  assert.match(plan.description, /memory_correct_apply/);
});

test("memory_correct_apply requires planId and advertises confirm", () => {
  const apply = correctionMcpTools.find((tool) => tool.name === "engram.memory_correct_apply");
  assert.ok(apply);
  assert.deepEqual(apply.inputSchema.required, ["planId"]);
  const props = apply.inputSchema.properties as Record<string, { type?: string }>;
  assert.equal(props.planId?.type, "string");
  assert.equal(props.confirm?.type, "boolean");
  assert.equal(props.sessionKey?.type, "string");
  assert.equal(props.namespace?.type, "string");
  assert.match(apply.description, /confirm:\s*true/i);
});
