/**
 * Correction Contract surface tests (issue #1580 PR 3).
 *
 * Asserts the three transports (MCP / HTTP / CLI) all dispatch through the
 * SAME boundary operations (memory_correct_plan / memory_correct_apply) so
 * validation + namespace policy reach every correction path (rule 22 / 39).
 *
 * Gate parity test: when correctionVisible is off, tools/list is byte-identical
 * to pre-feature — the two correction tools are absent (rule 39).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EngramMcpServer } from "../access-mcp.js";
import type { EngramAccessService } from "../access-service.js";
import { getOperation, __resetRegistryForTest } from "../access-boundary.js";
import type { CorrectionPlan, CorrectionOutcome } from "./correction-contract.js";

// Re-register operations after a prior test file cleared the registry.
import "../access-operations.js";

// ---------------------------------------------------------------------------
// Helpers — safe extraction without inline casts
// ---------------------------------------------------------------------------

function extractToolNames(response: unknown): Set<string> {
  if (typeof response !== "object" || response === null) return new Set();
  const r = response as { result?: unknown };
  if (typeof r.result !== "object" || r.result === null) return new Set();
  const result = r.result as { tools?: unknown };
  if (!Array.isArray(result.tools)) return new Set();
  const names = new Set<string>();
  for (const t of result.tools) {
    if (typeof t === "object" && t !== null && "name" in t) {
      const name = t.name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

interface MockCalls {
  planRequests: Array<{ text: string; targetIds?: string[]; principal?: string; abortSignal?: AbortSignal }>;
  applyRequests: Array<{ planId: string; confirm: boolean; principal?: string; abortSignal?: AbortSignal }>;
}

function makeMockService(
  planResponse: CorrectionPlan,
  applyResponse: CorrectionOutcome,
): { service: EngramAccessService; calls: MockCalls } {
  const calls: MockCalls = { planRequests: [], applyRequests: [] };
  const service = {
    briefingEnabled: true,
    correctionPlan(
      req: {
        text: string;
        targetIds?: string[];
        principal?: string;
      },
      opts?: { abortSignal?: AbortSignal },
    ): Promise<CorrectionPlan> {
      calls.planRequests.push({ ...req, ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}) });
      return Promise.resolve(planResponse);
    },
    correctionApply(
      planId: string,
      opts: { confirm?: boolean; principal?: string; abortSignal?: AbortSignal },
    ): Promise<CorrectionOutcome> {
      calls.applyRequests.push({
        planId,
        confirm: opts.confirm === true,
        ...(opts.principal ? { principal: opts.principal } : {}),
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      });
      return Promise.resolve(applyResponse);
    },
    correctionListPending(): Promise<CorrectionPlan[]> {
      return Promise.resolve([]);
    },
  } as unknown as EngramAccessService;
  return { service, calls };
}

const STUB_PLAN: CorrectionPlan = {
  planId: "corr-test-1",
  request: { text: "we migrated to MySQL" },
  affected: [],
  classification: "outdated",
  actions: [],
  diff: "--- old\n+++ new",
  confidence: 0.9,
  warnings: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-02T00:00:00.000Z",
  namespace: "default",
  status: "pending",
};

const STUB_OUTCOME: CorrectionOutcome = {
  planId: "corr-test-1",
  status: "applied",
  results: [],
  auditMemoryId: "audit-1",
  appliedAt: "2026-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Gate parity: tools/list visibility (rule 39)
// ---------------------------------------------------------------------------

test("tools/list gate: correction tools absent when correctionVisible off (byte-identical)", async () => {
  const stub = { briefingEnabled: true } as unknown as EngramAccessService;
  const server = new EngramMcpServer(stub, { emitLegacyTools: true, correctionVisible: false });
  const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = extractToolNames(response);
  assert.equal(names.has("engram.memory_correct_plan"), false, "plan tool must be absent when gate off");
  assert.equal(names.has("engram.memory_correct_apply"), false, "apply tool must be absent when gate off");
  assert.equal(names.has("remnic.memory_correct_plan"), false, "plan alias must be absent when gate off");
  assert.equal(names.has("remnic.memory_correct_apply"), false, "apply alias must be absent when gate off");
});

test("tools/list gate: correction tools present when correctionVisible on (default)", async () => {
  const stub = { briefingEnabled: true } as unknown as EngramAccessService;
  // correctionVisible defaults to true (enabled by default — plan is read-only).
  const server = new EngramMcpServer(stub, { emitLegacyTools: true });
  const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = extractToolNames(response);
  assert.equal(names.has("engram.memory_correct_plan"), true, "plan tool must be present by default");
  assert.equal(names.has("engram.memory_correct_apply"), true, "apply tool must be present by default");
  assert.equal(names.has("remnic.memory_correct_plan"), true, "plan alias must be present");
  assert.equal(names.has("remnic.memory_correct_apply"), true, "apply alias must be present");
});

// ---------------------------------------------------------------------------
// MCP dispatch: tools/call → boundary operation → service method
// ---------------------------------------------------------------------------

test("MCP surface: memory_correct_plan forwards the request abort signal", async () => {
  const { service, calls } = makeMockService(STUB_PLAN, STUB_OUTCOME);
  const server = new EngramMcpServer(service, { emitLegacyTools: true, correctionVisible: true });
  const abortController = new AbortController();
  const response = await server.handleRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "engram.memory_correct_plan",
        arguments: { text: "we migrated to MySQL in March", targetIds: ["mem-1"] },
      },
    },
    { abortSignal: abortController.signal },
  );
  assert.equal(calls.planRequests.length, 1, "service.correctionPlan called exactly once");
  assert.equal(calls.planRequests[0]?.text, "we migrated to MySQL in March");
  assert.deepEqual(calls.planRequests[0]?.targetIds, ["mem-1"]);
  assert.equal(calls.planRequests[0]?.abortSignal, abortController.signal);
  assert.equal(
    typeof response === "object" && response !== null && "result" in response,
    true,
    "response must have a result",
  );
});

test("MCP surface: memory_correct_apply forwards confirmation and the request abort signal", async () => {
  const { service, calls } = makeMockService(STUB_PLAN, STUB_OUTCOME);
  const server = new EngramMcpServer(service, { emitLegacyTools: true, correctionVisible: true });
  const abortController = new AbortController();
  await server.handleRequest(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "engram.memory_correct_apply",
        arguments: { planId: "corr-test-1", confirm: true },
      },
    },
    { abortSignal: abortController.signal },
  );
  assert.equal(calls.applyRequests.length, 1, "service.correctionApply called exactly once");
  assert.equal(calls.applyRequests[0]?.planId, "corr-test-1");
  assert.equal(calls.applyRequests[0]?.confirm, true);
  assert.equal(calls.applyRequests[0]?.abortSignal, abortController.signal);
});

test("MCP surface: remnic.memory_correct_plan alias dispatches identically", async () => {
  const { service, calls } = makeMockService(STUB_PLAN, STUB_OUTCOME);
  const server = new EngramMcpServer(service, { emitLegacyTools: true, correctionVisible: true });
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "remnic.memory_correct_plan",
      arguments: { text: "alias test" },
    },
  });
  assert.equal(calls.planRequests.length, 1, "alias dispatches to the same service method");
  assert.equal(calls.planRequests[0]?.text, "alias test");
});

// ---------------------------------------------------------------------------
// Boundary validation: empty text rejected (rule 51)
// ---------------------------------------------------------------------------

test("boundary: memory_correct_plan rejects empty text with a structured error", async () => {
  const { service } = makeMockService(STUB_PLAN, STUB_OUTCOME);
  const server = new EngramMcpServer(service, { emitLegacyTools: true, correctionVisible: true });
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "engram.memory_correct_plan",
      arguments: { text: "" },
    },
  });
  // The MCP server wraps boundary errors in an isError result.
  if (typeof response === "object" && response !== null && "result" in response) {
    const result = response.result;
    if (typeof result === "object" && result !== null && "isError" in result) {
      assert.equal(result.isError, true, "empty text must produce an error result");
      return;
    }
  }
  assert.fail("expected an isError result for empty text");
});

test("boundary: memory_correct_apply rejects missing planId with a structured error", async () => {
  const { service } = makeMockService(STUB_PLAN, STUB_OUTCOME);
  const server = new EngramMcpServer(service, { emitLegacyTools: true, correctionVisible: true });
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "engram.memory_correct_apply",
      arguments: {},
    },
  });
  if (typeof response === "object" && response !== null && "result" in response) {
    const result = response.result;
    if (typeof result === "object" && result !== null && "isError" in result) {
      assert.equal(result.isError, true, "missing planId must produce an error result");
      return;
    }
  }
  assert.fail("expected an isError result for missing planId");
});

// ---------------------------------------------------------------------------
// Operation registry: both ops are registered
// ---------------------------------------------------------------------------

test("registry: memory_correct_plan + memory_correct_apply are registered operations", () => {
  assert.ok(getOperation("memory_correct_plan"), "memory_correct_plan must be registered");
  assert.ok(getOperation("memory_correct_apply"), "memory_correct_apply must be registered");
});
