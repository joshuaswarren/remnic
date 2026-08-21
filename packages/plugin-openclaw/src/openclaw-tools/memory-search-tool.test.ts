import assert from "node:assert/strict";
import test from "node:test";

import { buildMemorySearchTool } from "./memory-search-tool.js";

function validateOpenClawPluginTool(tool: unknown): string | null {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return "tool must be an object";
  }
  const spec = tool as { name?: unknown; execute?: unknown; parameters?: unknown };
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    return "missing non-empty name";
  }
  if (typeof spec.execute !== "function") {
    return `${spec.name} missing execute function`;
  }
  if (!spec.parameters || typeof spec.parameters !== "object" || Array.isArray(spec.parameters)) {
    return `${spec.name} missing parameters object`;
  }
  return null;
}

test("memory-search tool exposes parameters for OpenClaw plugin validation", () => {
  const tool = buildMemorySearchTool({} as never, {
    recallForActiveMemory: async () => ({ results: [], truncated: false }),
  });

  assert.equal(validateOpenClawPluginTool(tool), null);
  assert.equal(tool.parameters, tool.inputSchema);
});

test("memory-search tool uses ctx session key and returns a structured JSON payload", async () => {
  let received: Record<string, unknown> | null = null;
  const tool = buildMemorySearchTool(
    {} as never,
    {
      snippetMaxChars: 120,
      recallForActiveMemory: async (_orchestrator, params) => {
        received = params as unknown as Record<string, unknown>;
        return {
          results: [
            {
              id: "mem-1",
              score: 0.9,
              text: "preference snippet",
              metadata: { type: "preference" },
            },
          ],
          truncated: false,
        };
      },
    },
  );

  const result = await tool.execute(
    "tc-memory-search",
    { query: "preferences", limit: 3 },
    undefined,
    { sessionKey: "ctx-session" },
  );

  assert.deepEqual(received, {
    query: "preferences",
    limit: 3,
    filters: undefined,
    sessionKey: "ctx-session",
    snippetMaxChars: 120,
  });

  const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
    results: Array<{ id: string }>;
    truncated: boolean;
  };
  assert.equal(payload.results[0]?.id, "mem-1");
  assert.equal(payload.truncated, false);
});

test("memory-search tool ignores explicit sessionKey overrides when runtime context is present", async () => {
  let received: Record<string, unknown> | null = null;
  const tool = buildMemorySearchTool(
    {} as never,
    {
      recallForActiveMemory: async (_orchestrator, params) => {
        received = params as unknown as Record<string, unknown>;
        return {
          results: [],
          truncated: false,
        };
      },
    },
  );

  await tool.execute(
    "tc-memory-search-ctx-wins",
    { query: "preferences", sessionKey: "param-session" },
    undefined,
    { sessionKey: "ctx-session" },
  );

  const ctxReceived = received as unknown as Record<string, unknown> | null;
  assert.equal(ctxReceived?.sessionKey, "ctx-session");

  await tool.execute(
    "tc-memory-search-param-fallback",
    { query: "preferences", sessionKey: "param-session" },
  );

  const paramReceived = received as unknown as Record<string, unknown> | null;
  assert.equal(paramReceived?.sessionKey, "param-session");
});
