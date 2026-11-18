import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.js";
import { recallRequestSchema, validateRequest, type RecallRequest } from "./access-schema.js";
import { mergeSearchQueryOptions } from "./search/port.js";
import { Orchestrator } from "./orchestrator.js";

test("recallRequestSchema accepts searchOptions.rerank and rejects unknown nested keys", () => {
  const ok = recallRequestSchema.safeParse({
    query: "cos388",
    searchOptions: { rerank: false },
  });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.searchOptions?.rerank, false);

  const strict = recallRequestSchema.safeParse({
    query: "cos388",
    searchOptions: { rerank: false, extra: true },
  });
  assert.equal(strict.success, false, "nested searchOptions must be strict");
});

test("validateRequest(recall) preserves searchOptions for HTTP", () => {
  const parsed = validateRequest<RecallRequest>("recall", {
    query: "hello",
    searchOptions: { rerank: false, explain: true },
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(parsed.data.searchOptions, { rerank: false, explain: true });
  }
});

test("mergeSearchQueryOptions: rerank false, explain false, rerank true no-op", () => {
  const merged = mergeSearchQueryOptions({ explain: true, intent: "goal:review" }, { rerank: false });
  assert.deepEqual(merged, { explain: true, intent: "goal:review", rerank: false });
  const explainOff = mergeSearchQueryOptions({ explain: true }, { explain: false });
  assert.deepEqual(explainOff, { explain: false });
  const noop = mergeSearchQueryOptions({ explain: true }, { rerank: true });
  assert.deepEqual(noop, { explain: true });
});

test("buildConfiguredQmdSearchOptions threads recall searchOptions override", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir: "/tmp/mem",
    workspaceDir: "/tmp/ws",
    qmdIntentHintsEnabled: false,
    qmdExplainEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);
  const off = orchestrator.buildConfiguredQmdSearchOptions("fleet status", { rerank: false });
  assert.deepEqual(off, { rerank: false });
  const none = orchestrator.buildConfiguredQmdSearchOptions("fleet status");
  assert.equal(none, undefined);
});