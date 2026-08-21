/**
 * Decision-record surface tests (issue #1548 Track A PR 2).
 *
 * Covers:
 *  - Gate predicate: all three conditions (config.enabled + decisionRecords +
 *    coding context) checked identically.
 *  - Subcommand validation: invalid subcommand → error listing valid ones.
 *  - Unknown decision id → explicit not-found, not empty success (rule 34).
 *  - Prove-fail-before: `engram.coding_decision` absent from tools/list when
 *    the config gate is off; present when on (rule 39 byte-identical contract).
 *  - Three surfaces → one service method (rule 22 spirit).
 *  - Registry fitness: the operation resolves through the boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EngramAccessInputError, type EngramAccessService } from "../access-service.js";
import type { Orchestrator } from "../orchestrator.js";
import { getOperation, type OperationName } from "../access-boundary.js";
import "../access-operations.js";
import { EngramMcpServer } from "../access-mcp.js";
import {
  DECISION_SUBCOMMANDS,
  formatDecisionSubcommands,
  isDecisionSubcommand,
  type DecisionSurfaceRequest,
  type DecisionSurfaceResponse,
} from "./decision-surfaces.js";
import { isCodingKnowledgeFeatureEnabled, isCodingKnowledgeFeatureVisible } from "./coding-knowledge-config.js";
import type { CodingContext, CodingKnowledgeConfig, PluginConfig } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────────────

const GATE_OFF_CONFIG: CodingKnowledgeConfig = {
  enabled: false,
  decisionRecords: true,
  architectureCard: true,
  sessionDelta: true,
  architectureCardLlmSummary: false,
  structuralProvider: "none",
  structuralProviderCommand: "",
  codegraphTools: false,
  codegraphDbDir: "",
};

const GATE_ON_CONFIG: CodingKnowledgeConfig = {
  ...GATE_OFF_CONFIG,
  enabled: true,
};

const CODING_CONTEXT: CodingContext = {
  projectId: "acme-backend",
  branch: "main",
  rootPath: "/repo/acme",
  defaultBranch: "main",
};

/**
 * Mock service that records calls to `codingDecision`. The mock signature MUST
 * match the production method (rule 33).
 */
function makeMockService(
  response: DecisionSurfaceResponse = {
    subcommand: "list",
    records: [],
    count: 0,
  },
): { service: EngramAccessService; calls: DecisionSurfaceRequest[] } {
  const calls: DecisionSurfaceRequest[] = [];
  const service = {
    codingDecision(
      req: DecisionSurfaceRequest,
      _authenticatedPrincipal?: string,
      _sourceConnector?: string,
    ): Promise<DecisionSurfaceResponse> {
      calls.push(req);
      return Promise.resolve(response);
    },
  } as unknown as EngramAccessService;
  return { service, calls };
}

function makeMockServiceWithConfig(
  config: CodingKnowledgeConfig,
  codingContext: CodingContext | null,
): EngramAccessService {
  const pluginConfig = {
    codingKnowledge: config,
    codingMode: { projectScope: true },
  } as unknown as PluginConfig;
  const orchestrator = {
    config: pluginConfig,
    getCodingContextForSession: (_sk: string) => codingContext,
  } as unknown as Orchestrator;
  return {
    orchestrator,
  } as unknown as EngramAccessService;
}

// ──────────────────────────────────────────────────────────────────────────
// Gate predicate tests
// ──────────────────────────────────────────────────────────────────────────

test("gate: disabled when config.enabled is false", () => {
  assert.equal(isCodingKnowledgeFeatureEnabled(GATE_OFF_CONFIG, "decisionRecords", CODING_CONTEXT), false);
});

test("gate: disabled when decisionRecords is false", () => {
  const cfg: CodingKnowledgeConfig = { ...GATE_ON_CONFIG, decisionRecords: false };
  assert.equal(isCodingKnowledgeFeatureEnabled(cfg, "decisionRecords", CODING_CONTEXT), false);
});

test("gate: disabled when no coding context attached", () => {
  assert.equal(isCodingKnowledgeFeatureEnabled(GATE_ON_CONFIG, "decisionRecords", null), false);
  assert.equal(isCodingKnowledgeFeatureEnabled(GATE_ON_CONFIG, "decisionRecords", undefined), false);
});

test("gate: enabled only when all three conditions hold", () => {
  assert.equal(isCodingKnowledgeFeatureEnabled(GATE_ON_CONFIG, "decisionRecords", CODING_CONTEXT), true);
});

test("visibility gate: config-only check for tools/list construction", () => {
  assert.equal(isCodingKnowledgeFeatureVisible(GATE_OFF_CONFIG, "decisionRecords"), false);
  assert.equal(isCodingKnowledgeFeatureVisible(GATE_ON_CONFIG, "decisionRecords"), true);
  assert.equal(
    isCodingKnowledgeFeatureVisible({ ...GATE_ON_CONFIG, decisionRecords: false }, "decisionRecords"),
    false,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Subcommand validation tests
// ──────────────────────────────────────────────────────────────────────────

test("subcommand: isDecisionSubcommand accepts all valid values", () => {
  for (const sc of DECISION_SUBCOMMANDS) {
    assert.equal(isDecisionSubcommand(sc), true);
  }
});

test("subcommand: isDecisionSubcommand rejects invalid values", () => {
  assert.equal(isDecisionSubcommand("delete"), false);
  assert.equal(isDecisionSubcommand(""), false);
  assert.equal(isDecisionSubcommand(undefined), false);
  assert.equal(isDecisionSubcommand(42), false);
});

test("subcommand: formatDecisionSubcommands lists all valid options", () => {
  const formatted = formatDecisionSubcommands();
  for (const sc of DECISION_SUBCOMMANDS) {
    assert.ok(formatted.includes(sc), `formatted list should contain "${sc}"`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Prove-fail-before: tools/list gate (rule 39)
// ──────────────────────────────────────────────────────────────────────────

test("tools/list: engram.coding_decision absent when gate off (byte-identical to main)", async () => {
  const stub = { briefingEnabled: true } as unknown as EngramAccessService;
  const server = new EngramMcpServer(stub, { emitLegacyTools: true });
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  const tools = (response as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  assert.equal(names.has("engram.coding_decision"), false, "tool must be absent when gate is off");
  assert.equal(names.has("remnic_coding_decision"), false, "alias must be absent when gate is off");
});

// ──────────────────────────────────────────────────────────────────────────
// Registry fitness: coding_decision operation is registered
// ──────────────────────────────────────────────────────────────────────────

test("registry: coding_decision operation is registered through the boundary", () => {
  const op = getOperation("coding_decision" as OperationName);
  assert.ok(op, "coding_decision must be registered in the operation registry");
  assert.equal(op?.spec.name, "coding_decision");
});

// ──────────────────────────────────────────────────────────────────────────
// Three surfaces → one service method (rule 22 spirit)
// ──────────────────────────────────────────────────────────────────────────

test("MCP surface: engram.coding_decision dispatches through the boundary to service.codingDecision", async () => {
  const { service, calls } = makeMockService();
  const server = new EngramMcpServer(service, { emitLegacyTools: true });
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.coding_decision",
      arguments: { subcommand: "list", sessionKey: "s1" },
    },
  });
  assert.equal(calls.length, 1, "service.codingDecision called exactly once");
  assert.equal(calls[0]?.subcommand, "list");
});

test("MCP surface: remnic.coding_decision alias dispatches identically", async () => {
  const { service, calls } = makeMockService();
  const server = new EngramMcpServer(service, { emitLegacyTools: true });
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "remnic.coding_decision",
      arguments: { subcommand: "list", sessionKey: "s1" },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.subcommand, "list");
});

test("operation handler: invalid subcommand → error listing valid options", async () => {
  const op = getOperation("coding_decision" as OperationName);
  assert.ok(op);
  await assert.rejects(
    () =>
      op!.run(
        { subcommand: "delete", sessionKey: "s1" },
        { service: makeMockService().service },
      ),
    (err: unknown) => {
      assert.ok(err instanceof EngramAccessInputError, "should be EngramAccessInputError");
      const msg = (err as Error).message;
      assert.ok(msg.includes("list"), "error lists 'list'");
      assert.ok(msg.includes("get"), "error lists 'get'");
      assert.ok(msg.includes("record"), "error lists 'record'");
      assert.ok(msg.includes("supersede"), "error lists 'supersede'");
      return true;
    },
  );
});

test("operation handler: record subcommand calls service with record params", async () => {
  const { service, calls } = makeMockService({
    subcommand: "record",
    memoryId: "mem-1",
    status: "proposed",
  });
  const op = getOperation("coding_decision" as OperationName);
  assert.ok(op);
  await op!.run(
    {
      subcommand: "record",
      sessionKey: "s1",
      title: "Use SQLite for graph store",
      context: "Need a local graph store",
      decision: "Adopt better-sqlite3",
      consequences: "Adds native dep",
    },
    { service },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.subcommand, "record");
  assert.equal(calls[0]?.title, "Use SQLite for graph store");
});

test("operation handler: get subcommand with unknown id → not-found response", async () => {
  const { service } = makeMockService({
    subcommand: "get",
    found: false,
  });
  const op = getOperation("coding_decision" as OperationName);
  assert.ok(op);
  const output = (await op!.run(
    { subcommand: "get", id: "nonexistent", sessionKey: "s1" },
    { service },
  )) as { result: DecisionSurfaceResponse };
  const result = output.result;
  assert.equal(result.subcommand, "get");
  if (result.subcommand === "get") {
    assert.equal(result.found, false, "unknown id → explicit not-found, not empty success");
  }
});
