
import assert from "node:assert/strict";
import test from "node:test";

import { Orchestrator } from "../orchestrator.js";
import type { CodingContext, CodingModeConfig, PluginConfig } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────

type OrchestratorLike = {
  config: PluginConfig;
  _codingContextBySession: Map<string, CodingContext>;
  setCodingContextForSession: Orchestrator["setCodingContextForSession"];
  getCodingContextForSession: Orchestrator["getCodingContextForSession"];
  applyCodingNamespaceOverlay: Orchestrator["applyCodingNamespaceOverlay"];
  applyCodingRecallOverlay: Orchestrator["applyCodingRecallOverlay"];
  resolveSelfNamespace: Orchestrator["resolveSelfNamespace"];
  resolvePrincipal: Orchestrator["resolvePrincipal"];
};

function makeOrchestrator(codingMode: Partial<CodingModeConfig> = {}): OrchestratorLike {
  const orch = Object.create(Orchestrator.prototype) as OrchestratorLike;
  orch._codingContextBySession = new Map<string, CodingContext>();
  orch.config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    defaultRecallNamespaces: ["self", "shared"],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    codingMode: {
      projectScope: true,
      branchScope: false,
      ...codingMode,
    },
  } as unknown as PluginConfig;
  return orch;
}

function contextFor(projectId: string, branch: string | null = "main"): CodingContext {
  return {
    projectId,
    branch,
    rootPath: `/work/${projectId}`,
    defaultBranch: "main",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("setCodingContextForSession: stores context; getCodingContextForSession returns it", () => {
  const orch = makeOrchestrator();
  const ctx = contextFor("origin:a1");
  orch.setCodingContextForSession("session-A", ctx);
  assert.deepEqual(orch.getCodingContextForSession("session-A"), ctx);
});

test("setCodingContextForSession: null clears the context", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:a1"));
  orch.setCodingContextForSession("session-A", null);
  assert.equal(orch.getCodingContextForSession("session-A"), null);
});

test("getCodingContextForSession: missing session returns null", () => {
  const orch = makeOrchestrator();
  assert.equal(orch.getCodingContextForSession("unknown"), null);
});

test("setCodingContextForSession: empty sessionKey is a no-op (defensive)", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("", contextFor("origin:a1"));
  assert.equal(orch._codingContextBySession.size, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("applyCodingNamespaceOverlay: returns base unchanged when no context attached", () => {
  const orch = makeOrchestrator();
  assert.equal(orch.applyCodingNamespaceOverlay("session-A", "default"), "default");
});

test("applyCodingNamespaceOverlay: combines base + project overlay when context is set and projectScope on", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:abcdef12"));
  assert.equal(
    orch.applyCodingNamespaceOverlay("session-A", "default"),
    "default-project-origin-abcdef12",
  );
  assert.equal(
    orch.applyCodingNamespaceOverlay("session-A", "alice"),
    "alice-project-origin-abcdef12",
  );
});

test("applyCodingNamespaceOverlay: different principals on same repo get isolated namespaces", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("alice-sess", contextFor("origin:deadbeef"));
  orch.setCodingContextForSession("bob-sess", contextFor("origin:deadbeef"));
  const aliceNs = orch.applyCodingNamespaceOverlay("alice-sess", "alice");
  const bobNs = orch.applyCodingNamespaceOverlay("bob-sess", "bob");
  assert.notEqual(
    aliceNs,
    bobNs,
    "distinct principals on the same repo must route to distinct namespaces",
  );
});

test("applyCodingNamespaceOverlay: principal base namespace preserves case", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("A-sess", contextFor("origin:deadbeef"));
  orch.setCodingContextForSession("a-sess", contextFor("origin:deadbeef"));
  const upperNs = orch.applyCodingNamespaceOverlay("A-sess", "Alice");
  const lowerNs = orch.applyCodingNamespaceOverlay("a-sess", "alice");
  assert.notEqual(
    upperNs,
    lowerNs,
    "case-only principal variants must not collapse to the same namespace",
  );
  assert.equal(upperNs, "Alice-project-origin-deadbeef");
  assert.equal(lowerNs, "alice-project-origin-deadbeef");
});

test("applyCodingNamespaceOverlay: projectScope=false returns base unchanged (escape hatch)", () => {
  const orch = makeOrchestrator({ projectScope: false });
  orch.setCodingContextForSession("session-A", contextFor("origin:abcdef12"));
  assert.equal(
    orch.applyCodingNamespaceOverlay("session-A", "default"),
    "default",
    "codingMode.projectScope=false must exactly restore pre-#569 behaviour",
  );
});

test("applyCodingNamespaceOverlay: namespacesEnabled=false returns base unchanged", () => {
  const orch = makeOrchestrator();
  (orch.config as unknown as { namespacesEnabled: boolean }).namespacesEnabled = false;
  orch.setCodingContextForSession("session-A", contextFor("origin:abcdef12"));
  assert.equal(
    orch.applyCodingNamespaceOverlay("session-A", "default"),
    "default",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("applyCodingRecallOverlay: no context → null (caller uses its existing namespaces)", () => {
  const orch = makeOrchestrator();
  assert.equal(orch.applyCodingRecallOverlay("session-A"), null);
});

test("applyCodingRecallOverlay: project context → overlay with empty fallbacks", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:aaaaaaaa"));
  const overlay = orch.applyCodingRecallOverlay("session-A");
  assert.deepEqual(overlay, { namespace: "project-origin-aaaaaaaa", readFallbacks: [] });
});

test("applyCodingRecallOverlay: projectScope=false → null (escape hatch)", () => {
  const orch = makeOrchestrator({ projectScope: false });
  orch.setCodingContextForSession("session-A", contextFor("origin:aaaaaaaa"));
  assert.equal(orch.applyCodingRecallOverlay("session-A"), null);
});

test("applyCodingRecallOverlay: namespacesEnabled=false → null", () => {
  const orch = makeOrchestrator();
  (orch.config as unknown as { namespacesEnabled: boolean }).namespacesEnabled = false;
  orch.setCodingContextForSession("session-A", contextFor("origin:aaaaaaaa"));
  assert.equal(orch.applyCodingRecallOverlay("session-A"), null);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("CLAUDE.md #42: read and write paths resolve the same namespace for the same principal + session", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:deadbeef"));

  const base = "default";
  const writeNs = orch.applyCodingNamespaceOverlay("session-A", base);
  const recallOverlay = orch.applyCodingRecallOverlay("session-A");
  assert.ok(recallOverlay);
  assert.equal(writeNs, `${base}-${recallOverlay!.namespace}`);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("two sessions on different projects resolve to different namespaces (no cross-project leakage)", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:11111111"));
  orch.setCodingContextForSession("session-B", contextFor("origin:22222222"));

  const nsA = orch.applyCodingNamespaceOverlay("session-A", "default");
  const nsB = orch.applyCodingNamespaceOverlay("session-B", "default");
  assert.notEqual(nsA, nsB);
  assert.equal(nsA, "default-project-origin-11111111");
  assert.equal(nsB, "default-project-origin-22222222");
});
