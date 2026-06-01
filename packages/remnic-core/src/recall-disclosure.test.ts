/**
 * Tests for the recall disclosure-depth plumbing introduced in PR 1/4 of
 * issue #677.  Covers:
 *
 *  - Type-level constants (`DEFAULT_RECALL_DISCLOSURE`,
 *    `RECALL_DISCLOSURE_LEVELS`).
 *  - The `isRecallDisclosure()` type guard.
 *  - The zod `recallRequestSchema` accept/reject behavior for the new
 *    `disclosure` field.
 *  - The MCP `engram.recall` handler forwards `disclosure` to the service
 *    layer instead of silently dropping it (regression for the
 *    cursor[bot] / codex review feedback on PR #694).
 *
 * Full surface integration tests (HTTP path, CLI flag) ship with their
 * respective surface work in PR 2/4.  Auto-escalation tests ship in
 * PR 4/4.  All fixtures are synthetic — no real user data.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECALL_DISCLOSURE,
  RECALL_DISCLOSURE_LEVELS,
  isRecallDisclosure,
} from "./types.js";
import { lcmSearchRequestSchema, recallRequestSchema, validateRequest } from "./access-schema.js";
import { EngramMcpServer } from "./access-mcp.js";
import type { EngramAccessRecallRequest, EngramAccessService } from "./access-service.js";

test("RECALL_DISCLOSURE_LEVELS is ordered chunk -> section -> raw", () => {
  // Order matters for future escalation policy comparisons (PR 4/4).  The
  // ladder must be stable; freezing here so a refactor that flips order is
  // caught immediately.
  assert.deepStrictEqual(
    [...RECALL_DISCLOSURE_LEVELS],
    ["chunk", "section", "raw"],
  );
});

test("DEFAULT_RECALL_DISCLOSURE is 'chunk' (preserves pre-#677 behavior)", () => {
  assert.strictEqual(DEFAULT_RECALL_DISCLOSURE, "chunk");
});

test("isRecallDisclosure() accepts the three valid levels", () => {
  for (const level of RECALL_DISCLOSURE_LEVELS) {
    assert.strictEqual(isRecallDisclosure(level), true, `level=${level}`);
  }
});

test("isRecallDisclosure() rejects unknown strings, casing variants, and non-strings", () => {
  for (const bad of ["", "Chunk", "CHUNK", "section ", "full", "raw_excerpt", "tier"]) {
    assert.strictEqual(isRecallDisclosure(bad), false, `bad=${JSON.stringify(bad)}`);
  }
  for (const bad of [null, undefined, 0, 1, true, false, {}, []]) {
    assert.strictEqual(isRecallDisclosure(bad as unknown), false);
  }
});

test("recallRequestSchema: omitting disclosure is valid (default applied at service layer)", () => {
  const result = recallRequestSchema.safeParse({ query: "hello" });
  assert.strictEqual(result.success, true);
  if (result.success) {
    assert.strictEqual(result.data.disclosure, undefined);
  }
});

test("recallRequestSchema: each documented disclosure level is accepted", () => {
  for (const level of RECALL_DISCLOSURE_LEVELS) {
    const result = recallRequestSchema.safeParse({ query: "hello", disclosure: level });
    assert.strictEqual(result.success, true, `level=${level}`);
    if (result.success) {
      assert.strictEqual(result.data.disclosure, level);
    }
  }
});

test("recallRequestSchema: invalid disclosure is rejected with field-level error", () => {
  const result = recallRequestSchema.safeParse({ query: "hello", disclosure: "full" });
  assert.strictEqual(result.success, false);
});

test("validateRequest('recall') surfaces disclosure validation errors with structured detail", () => {
  const outcome = validateRequest("recall", { query: "hello", disclosure: "verbose" });
  assert.strictEqual(outcome.success, false);
  if (!outcome.success) {
    assert.strictEqual(outcome.error.code, "validation_error");
    const fields = outcome.error.details.map((d) => d.field);
    assert.ok(fields.includes("disclosure"), `expected disclosure field error, got ${JSON.stringify(fields)}`);
  }
});

test("lcmSearchRequestSchema accepts requests without sessionPrefix", () => {
  const result = lcmSearchRequestSchema.safeParse({
    query: "handoff",
    sessionKey: "agent:main",
    namespace: "default",
    limit: 10,
  });

  assert.strictEqual(result.success, true);
  if (result.success) {
    assert.strictEqual(result.data.sessionPrefix, undefined);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// MCP handler must forward `disclosure` to the service layer.
//
// Regression coverage for the review feedback on PR #694: schema-level
// validation alone is not enough — the handler must actually pass the
// validated field through, otherwise callers see a silent default.
// ──────────────────────────────────────────────────────────────────────────

function makeMcpRecallSpyService(): {
  service: EngramAccessService;
  calls: EngramAccessRecallRequest[];
} {
  const calls: EngramAccessRecallRequest[] = [];
  const service = {
    briefingEnabled: false,
    recall: (req: EngramAccessRecallRequest) => {
      calls.push(req);
      return Promise.resolve({
        query: req.query,
        sessionKey: req.sessionKey,
        namespace: "default",
        context: "",
        count: 0,
        memoryIds: [],
        results: [],
        fallbackUsed: false,
        sourcesUsed: [],
        disclosure: req.disclosure ?? DEFAULT_RECALL_DISCLOSURE,
      });
    },
  } as unknown as EngramAccessService;
  return { service, calls };
}

test("MCP engram.recall handler forwards explicit `disclosure` to the service", async () => {
  const { service, calls } = makeMcpRecallSpyService();
  const server = new EngramMcpServer(service);
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.recall",
      arguments: { query: "hello", disclosure: "raw" },
    },
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0]?.disclosure, "raw");
});

test("MCP engram.recall handler omits `disclosure` when caller does not supply it", async () => {
  // The service layer owns default-application; the handler should pass
  // `undefined` (not `"chunk"`) when the caller did not provide a value
  // so the single source of truth stays in `EngramAccessService.recall()`.
  const { service, calls } = makeMcpRecallSpyService();
  const server = new EngramMcpServer(service);
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "engram.recall", arguments: { query: "hello" } },
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0]?.disclosure, undefined);
});

test("MCP engram.recall rejects non-string disclosure with a structured error", async () => {
  // Codex review on PR #694: a number (e.g. `1`) used to be coerced to
  // `undefined`, masking malformed input and silently applying the
  // chunk default.  The handler now distinguishes "absent" from
  // "present-but-wrong-type" and throws a structured error for the
  // latter.  The MCP transport surfaces tool errors as `isError: true`.
  const { service, calls } = makeMcpRecallSpyService();
  const server = new EngramMcpServer(service);
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "engram.recall",
      arguments: { query: "hello", disclosure: 1 as unknown as string },
    },
  });
  assert.strictEqual(calls.length, 0, "service.recall must not be called for invalid input");
  const result = (response as { result?: { isError?: boolean; content?: Array<{ text?: string }> } } | undefined)?.result;
  assert.strictEqual(result?.isError, true);
  const text = result?.content?.[0]?.text ?? "";
  assert.match(text, /disclosure must be a string/i);
});

test("MCP engram.recall treats explicit `null` disclosure as absent (service applies default)", async () => {
  // JSON-RPC clients sometimes serialize an unset field as `null`.
  // Treat `null` like absence so the service-layer default path runs
  // — matches `EngramAccessService.recall()`'s own null-tolerance.
  const { service, calls } = makeMcpRecallSpyService();
  const server = new EngramMcpServer(service);
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "engram.recall",
      arguments: { query: "hello", disclosure: null as unknown as string },
    },
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0]?.disclosure, undefined);
});

test("MCP engram.recall inputSchema advertises the `disclosure` enum", () => {
  // MCP clients with strict validation reject unknown fields; the
  // tool-list schema must declare `disclosure` so legitimate clients
  // can use it.
  const { service } = makeMcpRecallSpyService();
  const server = new EngramMcpServer(service);
  const tools = (server as unknown as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).tools;
  const recallTool = tools.find((t) => t.name === "engram.recall");
  assert.ok(recallTool, "engram.recall tool should be registered");
  const props = recallTool?.inputSchema?.properties as Record<string, { type?: string; enum?: string[] }> | undefined;
  assert.ok(props && "disclosure" in props, "engram.recall inputSchema must declare 'disclosure'");
  assert.deepStrictEqual(props?.disclosure?.enum, ["chunk", "section", "raw"]);
});
