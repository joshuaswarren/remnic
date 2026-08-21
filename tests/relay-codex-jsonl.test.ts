import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelayCodexFailureDiagnostic,
  countRecallToolCalls,
  parseRelayRecallReceipts,
  parseThreadId,
} from "../scripts/relay/codex-one-shot.js";
import {
  RELAY_NAMESPACE,
  RELAY_QUERY,
  RELAY_RECALL_DISCLOSURE,
  RELAY_RECALL_MODE,
  RELAY_RECALL_TAGS,
  RELAY_RECALL_TAG_MATCH,
  RELAY_RECALL_TOP_K,
  RELAY_STALE_BUILDER_SESSION_KEY,
} from "../scripts/relay/contracts.js";

test("Codex JSONL proof counts only completed Remnic MCP recalls", () => {
  const jsonl = [
    { type: "thread.started", thread_id: "019f62b9-3200-7df1-99fb-cbb35fc28573" },
    {
      type: "item.completed",
      item: { id: "item-1", type: "mcp_tool_call", server: "relay", tool: "remnic_recall", status: "failed" },
    },
    {
      type: "item.completed",
      item: {
        id: "item-2",
        type: "mcp_tool_call",
        server: "relay",
        tool: "remnic_recall",
        status: "completed",
        arguments: {
          query: RELAY_QUERY,
          namespace: RELAY_NAMESPACE,
          sessionKey: RELAY_STALE_BUILDER_SESSION_KEY,
          mode: RELAY_RECALL_MODE,
          topK: RELAY_RECALL_TOP_K,
          disclosure: RELAY_RECALL_DISCLOSURE,
          tags: RELAY_RECALL_TAGS,
          tagMatch: RELAY_RECALL_TAG_MATCH,
        },
        result: {
          structured_content: {
            query: RELAY_QUERY,
            namespace: RELAY_NAMESPACE,
            sessionKey: RELAY_STALE_BUILDER_SESSION_KEY,
            count: 1,
            plannerMode: RELAY_RECALL_MODE,
            disclosure: RELAY_RECALL_DISCLOSURE,
            memoryIds: ["memory-active"],
            results: [{ id: "memory-active", status: "active", category: "decision" }],
            context: "synthetic",
          },
        },
      },
    },
    {
      type: "item.completed",
      item: { id: "item-3", type: "mcp_tool_call", server: "other", tool: "other.read", status: "completed" },
    },
  ]
    .map((item) => JSON.stringify(item))
    .join("\n");

  assert.equal(parseThreadId(jsonl), "019f62b9-3200-7df1-99fb-cbb35fc28573");
  assert.equal(countRecallToolCalls(jsonl), 1);
  assert.deepEqual(parseRelayRecallReceipts(jsonl, RELAY_STALE_BUILDER_SESSION_KEY), [
    {
      query: RELAY_QUERY,
      namespace: RELAY_NAMESPACE,
      sessionKey: RELAY_STALE_BUILDER_SESSION_KEY,
      mode: RELAY_RECALL_MODE,
      topK: RELAY_RECALL_TOP_K,
      disclosure: RELAY_RECALL_DISCLOSURE,
      tags: RELAY_RECALL_TAGS,
      tagMatch: RELAY_RECALL_TAG_MATCH,
      count: 1,
      plannerMode: RELAY_RECALL_MODE,
      memoryIds: ["memory-active"],
    },
  ]);
});

test("Codex JSONL recall proof rejects missing structured MCP evidence", () => {
  const jsonl = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item-1",
      type: "mcp_tool_call",
      server: "relay",
      tool: "remnic_recall",
      status: "completed",
      arguments: {
        query: RELAY_QUERY,
        namespace: RELAY_NAMESPACE,
        sessionKey: RELAY_STALE_BUILDER_SESSION_KEY,
        mode: RELAY_RECALL_MODE,
        topK: RELAY_RECALL_TOP_K,
        disclosure: RELAY_RECALL_DISCLOSURE,
        tags: RELAY_RECALL_TAGS,
        tagMatch: RELAY_RECALL_TAG_MATCH,
      },
    },
  });
  assert.throws(
    () => parseRelayRecallReceipts(jsonl, RELAY_STALE_BUILDER_SESSION_KEY),
    /omitted structured MCP result evidence/
  );
});

test("Codex JSONL recall proof rejects a missing transcript-free session key before trusting ids", () => {
  const jsonl = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item-1",
      type: "mcp_tool_call",
      server: "relay",
      tool: "remnic_recall",
      status: "completed",
      arguments: {
        query: RELAY_QUERY,
        namespace: RELAY_NAMESPACE,
        mode: RELAY_RECALL_MODE,
        topK: RELAY_RECALL_TOP_K,
        disclosure: RELAY_RECALL_DISCLOSURE,
      },
      result: {
        structured_content: {
          query: RELAY_QUERY,
          namespace: RELAY_NAMESPACE,
          count: 0,
          memoryIds: [],
          results: [],
        },
      },
    },
  });
  assert.throws(() => parseRelayRecallReceipts(jsonl, RELAY_STALE_BUILDER_SESSION_KEY), /fixed argument surface/);
});

test("Codex failure diagnostics retain classifications and hashes without raw output", () => {
  const diagnostic = buildRelayCodexFailureDiagnostic("scout", {
    spawned: true,
    exitCode: 1,
    signal: null,
    durationMs: 42,
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "019f62b9-3200-7df1-99fb-cbb35fc28573" }),
      JSON.stringify({ type: "error", error: { code: "invalid_response_format", message: "invalid output schema" } }),
    ].join("\n"),
    stderr: "error: structured output schema rejected at /home/example/private/schema.json\n",
  });
  assert.equal(diagnostic.threadStarted, true);
  assert.deepEqual(diagnostic.eventCounts, { error: 1, "thread.started": 1 });
  assert.deepEqual(diagnostic.jsonlErrorCodes, ["invalid_response_format"]);
  assert.ok(diagnostic.errorClasses.includes("output-schema"));
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /structured output schema rejected|\/home\/example|invalid output schema/);
  assert.match(diagnostic.stdoutSha256, /^[a-f0-9]{64}$/);
  assert.match(diagnostic.stderrSha256, /^[a-f0-9]{64}$/);
});
