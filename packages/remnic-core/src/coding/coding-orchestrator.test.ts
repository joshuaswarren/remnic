/**
 * Integration tests for the orchestrator's coding-namespace overlay surface
 * (issue #569 PR 2).
 *
 * These tests use `Object.create(Orchestrator.prototype)` to exercise the
 * overlay helpers in isolation — no storage, no extraction. The end-to-end
 * contract being verified:
 *
 *   1. A session without a coding context gets the default namespace.
 *   2. A session with a coding context + `codingMode.projectScope: true`
 *      gets a `project-<id>` overlay on both read and write paths.
 *   3. Disabling `codingMode.projectScope: false` exactly restores the
 *      default namespace (CLAUDE.md #30 escape hatch).
 *   4. Rule 42 invariant: read-path overlay and write-path overlay return
 *      the same namespace for the same session + context.
 *   5. Isolation: two sessions on different projects resolve to different
 *      namespaces — cross-project leakage cannot occur at the routing layer.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Orchestrator } from "../orchestrator.js";
import type { CodingContext, CodingModeConfig, PluginConfig } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────
// Minimal orchestrator stub
// ──────────────────────────────────────────────────────────────────────────

type OrchestratorLike = {
  config: PluginConfig;
  // The private map on the real orchestrator — we mirror its name so the
  // methods under test read from the same slot.
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
  // Minimal PluginConfig — only the fields the overlay path reads.
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
// Basic setters / getters
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
// Overlay on write path
// ──────────────────────────────────────────────────────────────────────────

test("applyCodingNamespaceOverlay: returns base unchanged when no context attached", () => {
  const orch = makeOrchestrator();
  assert.equal(orch.applyCodingNamespaceOverlay("session-A", "default"), "default");
});

test("applyCodingNamespaceOverlay: combines base + project overlay when context is set and projectScope on", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:abcdef12"));
  // Rule 42 / principal isolation: overlay is COMBINED with the principal
  // base, not a replacement. Two principals in the same repo thus get
  // distinct namespaces (`alice-project-…` vs `bob-project-…`).
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
  // Regression: sanitizeFragment() was lowercasing the base, so two valid
  // but case-differing principal identifiers (`Alice` vs `alice`) would
  // collapse to the same combined namespace. The router accepts
  // [A-Za-z0-9._-]{1,64}, so case is a legal discriminator and must not
  // be dropped on the write / read paths.
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
  // When namespacesEnabled is off the storage router maps every namespace
  // to the same directory — a `project-*` overlay would create apparent
  // route separation with no actual isolation. In that mode, coding mode
  // degrades to unscoped behavior.
  const orch = makeOrchestrator();
  (orch.config as unknown as { namespacesEnabled: boolean }).namespacesEnabled = false;
  orch.setCodingContextForSession("session-A", contextFor("origin:abcdef12"));
  assert.equal(
    orch.applyCodingNamespaceOverlay("session-A", "default"),
    "default",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Overlay on read path
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
// Rule 42 — read path and write path resolve consistently
// ──────────────────────────────────────────────────────────────────────────

test("CLAUDE.md #42: read and write paths resolve the same namespace for the same principal + session", () => {
  // With the principal-scoped combine, the write-path namespace is
  // `<principal>-project-<id>` and the read-path self namespace is the
  // combine of the same principal base with the overlay. Both must be
  // identical for the same (sessionKey, baseNamespace) pair.
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:deadbeef"));

  const base = "default";
  const writeNs = orch.applyCodingNamespaceOverlay("session-A", base);
  const recallOverlay = orch.applyCodingRecallOverlay("session-A");
  assert.ok(recallOverlay);
  // The read path callers also perform the combine; here we verify the
  // equivalence contract: a raw overlay + base combined on the read path
  // must match the write-path namespace.
  assert.equal(writeNs, `${base}-${recallOverlay!.namespace}`);
});

// ──────────────────────────────────────────────────────────────────────────
// Isolation invariant — two projects, two namespaces
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
