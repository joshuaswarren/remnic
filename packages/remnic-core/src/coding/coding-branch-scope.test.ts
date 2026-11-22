
import assert from "node:assert/strict";
import test from "node:test";

import { Orchestrator } from "../orchestrator.js";
import { describeCodingScope } from "./coding-namespace.js";
import type { CodingContext, CodingModeConfig, PluginConfig } from "../types.js";

type OrchestratorLike = {
  config: PluginConfig;
  _codingContextBySession: Map<string, CodingContext>;
  setCodingContextForSession: Orchestrator["setCodingContextForSession"];
  applyCodingNamespaceOverlay: Orchestrator["applyCodingNamespaceOverlay"];
  applyCodingRecallOverlay: Orchestrator["applyCodingRecallOverlay"];
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
      branchScope: true,
      globalFallback: true,
      ...codingMode,
    },
  } as unknown as PluginConfig;
  return orch;
}

function contextFor(projectId: string, branch: string): CodingContext {
  return {
    projectId,
    branch,
    rootPath: `/work/${projectId}`,
    defaultBranch: "main",
  };
}

// ──────────────────────────────────────────────────────────────────────────

test("codingMode.branchScope=false → no branch layering even when a branch is present", () => {
  const orch = makeOrchestrator({ branchScope: false });
  orch.setCodingContextForSession("session-A", contextFor("origin:aaaa", "feat/x"));
  const overlay = orch.applyCodingRecallOverlay("session-A");
  assert.ok(overlay);
  assert.equal(overlay!.namespace, "project-origin-aaaa");
  assert.deepEqual(overlay!.readFallbacks, [""], "global fallback present when branchScope is off");
});

test("codingMode.branchScope=true → namespace gains a branch segment and a project + root readFallback", () => {
  const orch = makeOrchestrator({ branchScope: true });
  orch.setCodingContextForSession("session-A", contextFor("origin:aaaa", "feat/x"));
  const overlay = orch.applyCodingRecallOverlay("session-A");
  assert.ok(overlay);
  assert.match(overlay!.namespace, /^project-origin-aaaa-branch-feat-x-[0-9a-f]{8}$/);
  assert.deepEqual(overlay!.readFallbacks, ["project-origin-aaaa", ""]);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("branchScope=true + detached HEAD (branch=null) → collapses to project scope with global fallback", () => {
  const orch = makeOrchestrator({ branchScope: true });
  const ctx: CodingContext = {
    projectId: "origin:bbbb",
    branch: null,
    rootPath: "/work/detached",
    defaultBranch: "main",
  };
  orch.setCodingContextForSession("session-A", ctx);
  const overlay = orch.applyCodingRecallOverlay("session-A");
  assert.ok(overlay);
  assert.equal(overlay!.namespace, "project-origin-bbbb");
  assert.deepEqual(overlay!.readFallbacks, [""]);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("branchScope=true: writes on branch A route to a namespace distinct from branch B", () => {
  const orch = makeOrchestrator({ branchScope: true });
  orch.setCodingContextForSession("sess-A", contextFor("origin:cccc", "feat/a"));
  orch.setCodingContextForSession("sess-B", contextFor("origin:cccc", "feat/b"));

  const writeA = orch.applyCodingNamespaceOverlay("sess-A", "default");
  const writeB = orch.applyCodingNamespaceOverlay("sess-B", "default");
  assert.notEqual(writeA, writeB, "same project + different branch must isolate writes");
  assert.match(writeA, /^default-project-origin-cccc-branch-feat-a-[0-9a-f]{8}$/);
  assert.match(writeB, /^default-project-origin-cccc-branch-feat-b-[0-9a-f]{8}$/);
});

test("branchScope=true: recall on branch A includes its own namespace and the project fallback (NOT branch B)", () => {
  const orch = makeOrchestrator({ branchScope: true });
  orch.setCodingContextForSession("sess-A", contextFor("origin:cccc", "feat/a"));

  const overlay = orch.applyCodingRecallOverlay("sess-A");
  assert.ok(overlay);
  const readSet = [overlay!.namespace, ...overlay!.readFallbacks];
  assert.ok(
    readSet.some((ns) => /^project-origin-cccc-branch-feat-a-[0-9a-f]{8}$/.test(ns)),
    "branch A namespace must appear",
  );
  assert.ok(readSet.includes("project-origin-cccc"));
  assert.ok(
    !readSet.some((ns) => /^project-origin-cccc-branch-feat-b(-|$)/.test(ns)),
    "cross-branch recall leakage detected",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("branchScope=true: writes go to branch scope only; project-level writes require explicit override", () => {
  const orch = makeOrchestrator({ branchScope: true });
  orch.setCodingContextForSession("sess-A", contextFor("origin:dddd", "feat/x"));

  const writeNs = orch.applyCodingNamespaceOverlay("sess-A", "default");
  assert.match(writeNs, /^default-project-origin-dddd-branch-feat-x-[0-9a-f]{8}$/);
  assert.ok(
    !/project-origin-dddd$/.test(writeNs),
    "branch-scope writes must not silently go to project scope",
  );
});

test("branchScope=true: project-level memories remain visible via readFallbacks", () => {
  const orch = makeOrchestrator({ branchScope: true });
  orch.setCodingContextForSession("sess-A", contextFor("origin:eeee", "feat/y"));

  const overlay = orch.applyCodingRecallOverlay("sess-A");
  assert.ok(overlay);
  assert.ok(
    overlay!.readFallbacks.includes("project-origin-eeee"),
    "project-level memories must remain visible from any branch",
  );
  assert.ok(
    overlay!.readFallbacks.includes(""),
    "global/root memories must remain visible from any branch (empty sentinel for combineNamespaces)",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("branchScope=true: read primary namespace and write namespace are identical (rule 42)", () => {
  const orch = makeOrchestrator({ branchScope: true });
  orch.setCodingContextForSession("sess-A", contextFor("origin:ffff", "feat/z"));

  const base = "default";
  const writeNs = orch.applyCodingNamespaceOverlay("sess-A", base);
  const overlay = orch.applyCodingRecallOverlay("sess-A");
  assert.ok(overlay);
  assert.equal(writeNs, `${base}-${overlay!.namespace}`);
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("projectScope=false defeats branchScope=true (master gate — CLAUDE.md #30)", () => {
  const orch = makeOrchestrator({ projectScope: false, branchScope: true });
  orch.setCodingContextForSession("sess-A", contextFor("origin:gggg", "feat/k"));

  const writeNs = orch.applyCodingNamespaceOverlay("sess-A", "default");
  const overlay = orch.applyCodingRecallOverlay("sess-A");
  assert.equal(writeNs, "default", "projectScope=false must restore default on write");
  assert.equal(overlay, null, "projectScope=false must restore default on recall");
});

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

test("describeCodingScope: no context → scope=none, reason=no-context", () => {
  const desc = describeCodingScope(null, { projectScope: true, branchScope: false, globalFallback: true });
  assert.equal(desc.scope, "none");
  assert.equal(desc.disabledReason, "no-context");
  assert.equal(desc.effectiveNamespace, null);
});

test("describeCodingScope: projectScope=false → scope=none, reason=disabled", () => {
  const ctx = contextFor("origin:hhhh", "main");
  const desc = describeCodingScope(ctx, { projectScope: false, branchScope: false, globalFallback: true });
  assert.equal(desc.scope, "none");
  assert.equal(desc.disabledReason, "disabled");
  // Raw context fields are still surfaced so operators can see what would
  // have applied if the gate were flipped.
  assert.equal(desc.projectId, "origin:hhhh");
  assert.equal(desc.branch, "main");
});

test("describeCodingScope: project scope active → scope=project, namespace populated, global fallback included", () => {
  const ctx = contextFor("origin:iiii", "main");
  const desc = describeCodingScope(ctx, { projectScope: true, branchScope: false, globalFallback: true }, "default");
  assert.equal(desc.scope, "project");
  assert.equal(desc.effectiveNamespace, "project-origin-iiii");
  assert.deepEqual(desc.readFallbacks, [""]);
  assert.equal(desc.disabledReason, null);
});

test("describeCodingScope: project scope active, globalFallback=false → no root in fallbacks", () => {
  const ctx = contextFor("origin:iiii", "main");
  const desc = describeCodingScope(ctx, { projectScope: true, branchScope: false, globalFallback: false }, "default");
  assert.equal(desc.scope, "project");
  assert.equal(desc.effectiveNamespace, "project-origin-iiii");
  assert.deepEqual(desc.readFallbacks, []);
  assert.equal(desc.disabledReason, null);
});

test("describeCodingScope: branch scope active → scope=branch, fallbacks include project and root", () => {
  const ctx = contextFor("origin:jjjj", "feat/x");
  const desc = describeCodingScope(ctx, { projectScope: true, branchScope: true, globalFallback: true }, "default");
  assert.equal(desc.scope, "branch");
  assert.match(
    desc.effectiveNamespace ?? "",
    /^project-origin-jjjj-branch-feat-x-[0-9a-f]{8}$/,
  );
  assert.deepEqual(desc.readFallbacks, ["project-origin-jjjj", ""]);
});

test("describeCodingScope: empty projectId → scope=none, reason=empty-project", () => {
  const ctx: CodingContext = {
    projectId: "   ",
    branch: "main",
    rootPath: "/work/proj",
    defaultBranch: "main",
  };
  const desc = describeCodingScope(ctx, { projectScope: true, branchScope: false, globalFallback: true });
  assert.equal(desc.scope, "none");
  assert.equal(desc.disabledReason, "empty-project");
});
