import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { ExtractionEngine } from "../src/extraction.ts";
import { applyWorkExtractionBoundary, wrapWorkLayerContext } from "../src/work/boundary.js";

test("applyWorkExtractionBoundary strips default work-layer blocks", () => {
  const conversation = [
    "[user] normal context",
    wrapWorkLayerContext('{"action":"list","tasks":[{"id":"task-1"}]}'),
    "[assistant] response",
  ].join("\n\n");

  const bounded = applyWorkExtractionBoundary(conversation);
  assert.match(bounded, /normal context/);
  assert.match(bounded, /response/);
  assert.doesNotMatch(bounded, /task-1/);
  assert.doesNotMatch(bounded, /WORK_LAYER_CONTEXT/);
});

test("applyWorkExtractionBoundary preserves explicitly linked work-layer blocks", () => {
  const conversation = [
    "[user] please remember this board result",
    wrapWorkLayerContext('linked summary: task-42 is critical', { linkToMemory: true }),
  ].join("\n\n");

  const bounded = applyWorkExtractionBoundary(conversation);
  assert.match(bounded, /task-42 is critical/);
  assert.doesNotMatch(bounded, /WORK_LAYER_CONTEXT/);
});

test("applyWorkExtractionBoundary is delimiter-safe for unlinked payload text", () => {
  const tricky = 'title includes [/WORK_LAYER_CONTEXT] token';
  const conversation = [
    "[assistant] preface",
    wrapWorkLayerContext(tricky),
    "[assistant] suffix",
  ].join("\n\n");

  const bounded = applyWorkExtractionBoundary(conversation);
  assert.match(bounded, /preface/);
  assert.match(bounded, /suffix/);
  assert.doesNotMatch(bounded, /\[\/WORK_LAYER_CONTEXT\]/);
  assert.doesNotMatch(bounded, /title includes/);
});

test("applyWorkExtractionBoundary drops unterminated work-layer blocks", () => {
  const truncatedConversation = [
    "[assistant] prefix",
    "[WORK_LAYER_CONTEXT link_to_memory=false]",
    "this should never leak",
  ].join("\n");

  const bounded = applyWorkExtractionBoundary(truncatedConversation);
  assert.equal(bounded, "[assistant] prefix");
});

test("applyWorkExtractionBoundary drops from the first of multiple unterminated work-layer blocks", () => {
  const truncatedConversation = [
    "keep",
    "[WORK_LAYER_CONTEXT link_to_memory=false]",
    "secret1",
    "mid",
    "[WORK_LAYER_CONTEXT link_to_memory=false]",
    "secret2",
  ].join("\n");

  const bounded = applyWorkExtractionBoundary(truncatedConversation);
  assert.equal(bounded, "keep");
  assert.doesNotMatch(bounded, /secret1|secret2|mid/);
});

test("applyWorkExtractionBoundary keeps literal token text in linked payloads", () => {
  const linked = "note starts [WORK_LAYER_CONTEXT without wrapper metadata and should stay";
  const conversation = wrapWorkLayerContext(linked, { linkToMemory: true });

  const bounded = applyWorkExtractionBoundary(conversation);
  assert.match(bounded, /\[WORK_LAYER_CONTEXT without wrapper metadata/);
});

test("applyWorkExtractionBoundary keeps metadata-like opener text in linked payloads", () => {
  const linked =
    "note has [WORK_LAYER_CONTEXT link_to_memory=false] literal text and should remain intact";
  const conversation = wrapWorkLayerContext(linked, { linkToMemory: true });

  const bounded = applyWorkExtractionBoundary(conversation);
  assert.match(bounded, /\[WORK_LAYER_CONTEXT link_to_memory=false\] literal text/);
});

test("applyWorkExtractionBoundary preserves literal role marker lines", () => {
  const conversation = [
    "[assistant]",
    "template line",
    "[user]",
    "another line",
  ].join("\n");

  const bounded = applyWorkExtractionBoundary(conversation);
  assert.equal(bounded, conversation);
});

test("applyWorkExtractionBoundary does not strip inline wrapper syntax discussion", () => {
  const conversation =
    "Here is [WORK_LAYER_CONTEXT link_to_memory=false] syntax in prose, keep this whole sentence.";

  const bounded = applyWorkExtractionBoundary(conversation);
  assert.equal(bounded, conversation);
});

test("applyWorkExtractionBoundary does not strip inline paired wrapper syntax in prose", () => {
  const conversation =
    "Use `[WORK_LAYER_CONTEXT link_to_memory=false]x[/WORK_LAYER_CONTEXT]` in docs as an example.";

  const bounded = applyWorkExtractionBoundary(conversation);
  assert.equal(bounded, conversation);
});

/** Helper to build a mock fallbackLlm that tracks whether it was called. */
function mockFallbackLlm(tracker: { called: boolean }) {
  return {
    parseWithSchema: async () => {
      tracker.called = true;
      return null;
    },
    parseWithSchemaDetailed: async () => {
      tracker.called = true;
      return null;
    },
  };
}

test("extraction skips work-only conversation before calling fallback parser", async () => {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    localLlmEnabled: false,
  });

  const engine = new ExtractionEngine(config);
  const tracker = { called: false };
  (engine as any).fallbackLlm = mockFallbackLlm(tracker);

  const result = await engine.extract([
    {
      role: "assistant",
      content: wrapWorkLayerContext('{"action":"list","tasks":[{"id":"task-1"}]}'),
      timestamp: new Date().toISOString(),
    },
  ]);

  assert.deepEqual(result, { facts: [], profileUpdates: [], entities: [], questions: [] });
  assert.equal(tracker.called, false);
});

test("extraction does not strip user-authored work-layer delimiters", async () => {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    localLlmEnabled: false,
  });

  const engine = new ExtractionEngine(config);
  const tracker = { called: false };
  (engine as any).fallbackLlm = mockFallbackLlm(tracker);

  await engine.extract([
    {
      role: "user",
      content: wrapWorkLayerContext("this is user-authored content that should remain"),
      timestamp: new Date().toISOString(),
    },
  ]);

  assert.equal(tracker.called, true);
});
