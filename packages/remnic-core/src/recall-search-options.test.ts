import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.js";
import { recallRequestSchema, validateRequest, type RecallRequest } from "./access-schema.js";
import { mergeSearchQueryOptions } from "./search/port.js";
import { Orchestrator } from "./orchestrator.js";
import { EngramMcpServer } from "./access-mcp.js";
import type { EngramAccessService } from "./access-service.js";

function makeMcpRecallSpyService(): { service: EngramAccessService } {
  const service = {
    recall: async () => ({
      query: "",
      namespace: "default",
      context: "",
      count: 0,
      memoryIds: [],
      results: [],
      fallbackUsed: false,
      sourcesUsed: [],
      disclosure: "chunk",
    }),
  } as unknown as EngramAccessService;
  return { service };
}

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

test("mergeSearchQueryOptions: rerank false overrides config defaults; true is no-op", () => {
  const merged = mergeSearchQueryOptions({ explain: true, intent: "goal:review" }, { rerank: false });
  assert.deepEqual(merged, { explain: true, intent: "goal:review", rerank: false });
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

test("engram.recall MCP inputSchema declares searchOptions", () => {
  const { service } = makeMcpRecallSpyService();
  const server = new EngramMcpServer(service);
  const tools = (server as unknown as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).tools;
  const recallTool = tools.find((t) => t.name === "engram.recall");
  const props = recallTool?.inputSchema?.properties as Record<string, unknown> | undefined;
  assert.ok(props && props.searchOptions, "searchOptions must be advertised on engram.recall");
});
