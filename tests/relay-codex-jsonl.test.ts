import assert from "node:assert/strict";
import test from "node:test";

import { countRecallToolCalls, parseThreadId } from "../scripts/relay/codex-one-shot.js";

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
