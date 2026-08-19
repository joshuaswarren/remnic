import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_MCP_PREFIX,
  toCanonicalToolName,
  toLegacyToolName,
  withToolAliases,
} from "./access-mcp-tool-names.js";

const ANTHROPIC_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

test("toCanonicalToolName maps remnic_ / remnic. / engram. to remnic_suffix", () => {
  assert.equal(toCanonicalToolName("remnic_recall"), "remnic_recall");
  assert.equal(toCanonicalToolName("remnic.recall"), "remnic_recall");
  assert.equal(toCanonicalToolName("engram.recall"), "remnic_recall");
  assert.equal(toCanonicalToolName("unknown"), "unknown");
});

test("toLegacyToolName maps remnic_ / remnic. / engram. to engram.suffix", () => {
  assert.equal(toLegacyToolName("remnic_recall"), "engram.recall");
  assert.equal(toLegacyToolName("remnic.recall"), "engram.recall");
  assert.equal(toLegacyToolName("engram.recall"), "engram.recall");
});

test("withToolAliases advertises remnic_<suffix> and optional engram.*", () => {
  const tool = { name: "engram.recall" };
  const both = withToolAliases(tool, true);
  assert.deepEqual(
    both.map((entry) => entry.name),
    ["remnic_recall", "engram.recall"],
  );
  const canonicalOnly = withToolAliases(tool, false);
  assert.deepEqual(
    canonicalOnly.map((entry) => entry.name),
    ["remnic_recall"],
  );
  assert.ok(canonicalOnly.every((entry) => ANTHROPIC_TOOL_NAME.test(entry.name)));
  assert.equal(CANONICAL_MCP_PREFIX, "remnic_");
});

test("withToolAliases emits the engram.* alias for canonical-named tools too", () => {
  const tool = { name: "remnic_recall" };
  assert.deepEqual(
    withToolAliases(tool, true).map((entry) => entry.name),
    ["remnic_recall", "engram.recall"],
  );
  assert.deepEqual(
    withToolAliases(tool, false).map((entry) => entry.name),
    ["remnic_recall"],
  );
  assert.deepEqual(
    withToolAliases({ name: "remnic.recall" }, true).map((entry) => entry.name),
    ["remnic_recall", "engram.recall"],
  );
});
