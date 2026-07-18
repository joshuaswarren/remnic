import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelayCodexFailureDiagnostic,
  countRecallToolCalls,
  parseThreadId,
} from "../scripts/relay/codex-one-shot.js";

test("Codex JSONL proof counts only completed Remnic MCP recalls", () => {
  const jsonl = [
    { type: "thread.started", thread_id: "019f62b9-3200-7df1-99fb-cbb35fc28573" },
    {
      type: "item.completed",
      item: { id: "item-1", type: "mcp_tool_call", server: "relay", tool: "remnic.recall", status: "failed" },
    },
    {
      type: "item.completed",
      item: { id: "item-2", type: "mcp_tool_call", server: "relay", tool: "remnic.recall", status: "completed" },
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
