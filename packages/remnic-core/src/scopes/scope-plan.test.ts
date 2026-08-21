/**
 * ScopePlan resolver parity tests (issue #1521 step 2).
 *
 * These tests snapshot the effective namespace sets the resolver produces for a
 * fixed matrix of inputs. The snapshots were derived by tracing the pre-migration
 * inline resolution in `orchestrator.recallInternal` and
 * `orchestrator.enqueueDirectAnswerObservation` — the SAME helpers in the SAME
 * order. They MUST NOT change when consumers switch from the inline code to the
 * resolver; if they do, the resolver diverged and must be corrected before
 * migration lands.
 *
 * Input matrix (issue #1521 step 2):
 *  - default namespace (no policies, no coding context)
 *  - named namespace (explicit override, readable)
 *  - coding overlay (project scope and branch scope)
 *  - sparse metadata (empty/missing fields, no session key)
 *  - legacy `agent:*` session keys
 *  - scope-profile plan (active profile)
 *  - explicit namespace override (unreadable falls through)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  getConfiguredNamespaces,
  resolveNamespaceFromStorageDir,
  resolveNamespacePreflight,
  resolveScopePlan,
  resolveWritableNamespaceValue,
} from "./scope-plan.js";
import type { TokenCapabilities } from "../access-token-capabilities.js";
import {
  combineNamespaces,
  lcmSessionKeyForNamespace,
  projectNamespaceName,
} from "../coding/coding-namespace.js";
import type { CodingContext, PluginConfig } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────
// Config builders
// ──────────────────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    defaultRecallNamespaces: ["self", "shared"],
    codingMode: { projectScope: true, branchScope: false, globalFallback: true },
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    scopeProfiles: {},
    defaultScopeProfile: undefined,
    teams: {},
    ...overrides,
  } as unknown as PluginConfig;
}

/** A principal whose self namespace exists as a policy, so the overlay base is
 * non-default and readable. */
function withSelfPolicy(config: PluginConfig, principal: string): PluginConfig {
  return {
    ...config,
    namespacePolicies: [
      { name: principal, readPrincipals: [principal], writePrincipals: [principal] },
      ...(config.namespacePolicies ?? []),
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [
      { match: `${principal}:`, principal },
      ...(config.principalFromSessionKeyRules ?? []),
    ],
  } as unknown as PluginConfig;
}

function codingContext(projectId: string, branch: string | null = null): CodingContext {
  return { projectId, branch, rootPath: "/repo", defaultBranch: "main" };
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 1: default namespace, no coding context
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: default namespace, no coding context → [default]", () => {
  const config = baseConfig();
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "sess-1",
  });

  assert.equal(plan.principal, "default");
  assert.equal(plan.namespaceOverride, undefined);
  assert.equal(plan.baseNamespace, "default");
  assert.deepEqual(plan.readNamespaces, ["default", "shared"]);
  assert.deepEqual(plan.readFallbacks, []);
  assert.deepEqual(plan.lcmReadNamespaces, ["default"]);
  assert.equal(plan.codingOverlay, null);
  assert.equal(plan.scopeProfilePlan, null);
  // LCM key is the raw sessionKey (default store, no overlay).
  assert.deepEqual([...plan.lcmReadSessionIds], ["sess-1"]);
});

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 2: named namespace (explicit, readable override)
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: explicit readable namespace override wins", () => {
  const config = baseConfig({
    namespacePolicies: [
      { name: "team-data", readPrincipals: ["default"], writePrincipals: [] },
    ],
  } as Partial<PluginConfig>);
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "sess-1",
    namespace: "team-data",
  });

  assert.equal(plan.namespaceOverride, "team-data");
  assert.equal(plan.baseNamespace, "team-data");
  assert.deepEqual(plan.readNamespaces, ["team-data"]);
  assert.deepEqual(plan.lcmReadNamespaces, ["team-data"]);
  assert.equal(plan.codingOverlay, null);
  assert.equal(plan.scopeProfilePlan, null);
  assert.deepEqual(
    [...plan.lcmReadSessionIds],
    [lcmSessionKeyForNamespace("team-data", "sess-1", "default")],
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 3: coding overlay (project scope)
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: coding overlay (project scope) substitutes self base", () => {
  const config = withSelfPolicy(baseConfig(), "alice");
  const ctx = codingContext("myproj");
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "alice:sess-1",
    codingContext: ctx,
  });

  const projectNs = projectNamespaceName("myproj");
  const codingSelf = combineNamespaces("alice", projectNs);

  assert.equal(plan.principal, "alice");
  assert.equal(plan.baseNamespace, codingSelf);
  // readNamespaces substitutes "alice" → codingSelf, keeps shared.
  // globalFallback=true adds the root ("") fallback: combineNamespaces("alice",
  // "") → "alice", so the principal's own namespace appears as a read fallback.
  assert.deepEqual(plan.readNamespaces, [codingSelf, "shared", "alice"]);
  assert.deepEqual(plan.readFallbacks, ["alice"]);
  assert.deepEqual(plan.lcmReadNamespaces, [codingSelf, "alice"]);
  assert.equal(plan.codingOverlay?.namespace, projectNs);
  assert.deepEqual([...plan.codingOverlay?.readFallbacks ?? []], [""]);
});

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 4: coding overlay (branch scope) appends project fallback
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: coding overlay (branch scope) appends project + root fallbacks", () => {
  const config = withSelfPolicy(
    baseConfig({
      codingMode: { projectScope: true, branchScope: true, globalFallback: true },
    } as Partial<PluginConfig>),
    "alice",
  );
  const ctx = codingContext("myproj", "feature-x");
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "alice:sess-1",
    codingContext: ctx,
  });

  // Verify the key invariants: overlay is non-null, base is combined with self.
  assert.notEqual(plan.codingOverlay, null);
  assert.notEqual(plan.baseNamespace, "alice");
  // readNamespaces includes the coding self (branch) and fallbacks.
  assert.ok(plan.readNamespaces.length >= 2, "branch scope must include fallbacks");
  // LCM read includes coding self + fallbacks.
  assert.ok(plan.lcmReadNamespaces.length >= 2, "LCM must include fallback keys");
  // readFallbacks is non-empty (project + root when globalFallback).
  assert.ok(plan.readFallbacks.length >= 1, "branch scope has at least project fallback");
});

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 5: sparse metadata — no session key
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: no session key → principal undefined, default namespace", () => {
  const config = baseConfig();
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
  });

  assert.equal(plan.principal, undefined);
  assert.equal(plan.baseNamespace, "default");
  // recallNamespacesForPrincipal(undefined) → [] (no principal).
  assert.deepEqual(plan.readNamespaces, []);
  assert.deepEqual(plan.lcmReadNamespaces, ["default"]);
  // Sessionless LCM → [undefined] (archive-wide read, no session_id filter).
  assert.deepEqual([...plan.lcmReadSessionIds], [undefined]);
});

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 6: legacy agent:* session key
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: legacy agent:* session key resolves principal via heuristic", () => {
  const config = baseConfig();
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "agent:bot-1:slack:chan-1",
  });

  // resolvePrincipal heuristic: parts[0] === "agent" → parts[1] = "bot-1".
  assert.equal(plan.principal, "bot-1");
  // No policy for "bot-1" → defaultNamespaceForPrincipal → "default".
  assert.equal(plan.baseNamespace, "default");
  // recallNamespacesForPrincipal("bot-1"): self="default" (readable), shared.
  assert.deepEqual(plan.readNamespaces, ["default", "shared"]);
  assert.deepEqual(plan.lcmReadNamespaces, ["default"]);
});

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 7: namespacesEnabled false → single-store collapse
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: namespacesEnabled false collapses to default store", () => {
  const config = baseConfig({ namespacesEnabled: false } as Partial<PluginConfig>);
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "sess-1",
    codingContext: codingContext("myproj"),
  });

  // resolvePrincipal returns "default" when namespaces disabled.
  assert.equal(plan.principal, "default");
  assert.equal(plan.baseNamespace, "default");
  assert.deepEqual(plan.readNamespaces, ["default"]);
  assert.equal(plan.codingOverlay, null);
  assert.equal(plan.scopeProfilePlan, null);
  // Single store → raw sessionKey.
  assert.deepEqual([...plan.lcmReadSessionIds], ["sess-1"]);
});

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 8: codingMode.projectScope false → no overlay
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: projectScope false → no overlay even with coding context", () => {
  const config = withSelfPolicy(
    baseConfig({
      codingMode: { projectScope: false, branchScope: false, globalFallback: true },
    } as Partial<PluginConfig>),
    "alice",
  );
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "alice:sess-1",
    codingContext: codingContext("myproj"),
  });

  assert.equal(plan.codingOverlay, null);
  assert.equal(plan.baseNamespace, "alice");
  // No overlay → readable recall set unchanged (self substituted by nothing).
  assert.deepEqual(plan.readNamespaces, ["alice", "shared"]);
});

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 9: explicit override not readable → falls through (observe parity)
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: unreadable namespace override falls through to coding/legacy", () => {
  // No policy for "restricted" → canReadNamespace(default, "restricted") → false.
  const config = withSelfPolicy(baseConfig(), "alice");
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "alice:sess-1",
    namespace: "restricted",
    codingContext: codingContext("myproj"),
  });

  // Unreadable override → namespaceOverride is undefined in the plan.
  assert.equal(plan.namespaceOverride, undefined);
  // Falls through to coding overlay (alice has a policy + coding context).
  assert.notEqual(plan.codingOverlay, null);
  assert.notEqual(plan.baseNamespace, "restricted");
  assert.notEqual(plan.baseNamespace, "alice", "base should be the overlaid namespace");
});

// ──────────────────────────────────────────────────────────────────────────
// Snapshot 10: defaultRecallNamespaces omits self → overlay LCM collapses
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: self not in defaultRecallNamespaces → LCM collapses to default", () => {
  const config = withSelfPolicy(
    baseConfig({
      defaultRecallNamespaces: ["shared"],
    } as Partial<PluginConfig>),
    "alice",
  );
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "alice:sess-1",
    codingContext: codingContext("myproj"),
  });

  // Coding overlay IS resolved (coding context + projectScope).
  assert.notEqual(plan.codingOverlay, null);
  // codingOverlaySelfReadable = false (self "alice" not in readable set).
  // LCM collapses to default.
  assert.deepEqual(plan.lcmReadNamespaces, ["default"]);
});

// ──────────────────────────────────────────────────────────────────────────
// Cross-check: resolveScopePlan is pure (same inputs → same outputs)
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: resolver is pure — identical inputs produce identical plans", () => {
  const config = withSelfPolicy(baseConfig(), "alice");
  const ctx = codingContext("myproj");
  const opts = { config, namespacesEnabled: config.namespacesEnabled, sessionKey: "alice:sess-1", codingContext: ctx } as const;

  const a = resolveScopePlan(opts);
  const b = resolveScopePlan(opts);

  assert.deepEqual(a.readNamespaces, b.readNamespaces);
  assert.deepEqual(a.lcmReadNamespaces, b.lcmReadNamespaces);
  assert.deepEqual([...a.lcmReadSessionIds], [...b.lcmReadSessionIds]);
  assert.equal(a.baseNamespace, b.baseNamespace);
  assert.equal(a.codingOverlay?.namespace, b.codingOverlay?.namespace);
});

// ──────────────────────────────────────────────────────────────────────────
// Parity invariant: LCM keys derived through lcmSessionKeyForNamespace
// (rule 22 — never hardcoded `:`-joins)
// ──────────────────────────────────────────────────────────────────────────

test("scope-plan: LCM session ids match lcmSessionKeyForNamespace encoding", () => {
  const config = withSelfPolicy(baseConfig(), "alice");
  const plan = resolveScopePlan({
    config,
    namespacesEnabled: config.namespacesEnabled,
    sessionKey: "alice:sess-1",
    codingContext: codingContext("myproj"),
  });

  // Each LCM read session id must equal lcmSessionKeyForNamespace(ns, sk, default).
  const expected = plan.lcmReadNamespaces.map(
    (ns) => lcmSessionKeyForNamespace(ns, "alice:sess-1", "default") ?? "alice:sess-1",
  );
  assert.deepEqual([...plan.lcmReadSessionIds], expected);
});

// ──────────────────────────────────────────────────────────────────────────
// Fitness tests: centralized namespace-resolution helpers (#1521 step 3–4)
//
// These pin the three pure helpers that replace the ad-hoc resolution scattered
// across orchestrator.ts and access-service.ts. They MUST match the pre-migration
// behavior byte-for-byte (the snapshots were derived from the original inline
// implementations).
// ──────────────────────────────────────────────────────────────────────────

test("getConfiguredNamespaces: default + shared + policies, trimmed and deduped", () => {
  const config = baseConfig({
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "team-a", readPrincipals: ["*"], writePrincipals: ["*"] },
      { name: "team-b", readPrincipals: ["*"], writePrincipals: ["*"] },
    ],
  });
  const ns = getConfiguredNamespaces(config);
  assert.deepEqual(ns, ["default", "shared", "team-a", "team-b"]);
});

test("getConfiguredNamespaces: trims whitespace and drops empty", () => {
  const config = baseConfig({
    defaultNamespace: "  default  ",
    sharedNamespace: "",
    namespacePolicies: [
      { name: "team-a ", readPrincipals: ["*"], writePrincipals: ["*"] },
    ],
  });
  const ns = getConfiguredNamespaces(config);
  assert.deepEqual(ns, ["default", "team-a"]);
});

test("getConfiguredNamespaces: deduplicates identical names", () => {
  const config = baseConfig({
    defaultNamespace: "default",
    sharedNamespace: "default",
    namespacePolicies: [
      { name: "default", readPrincipals: ["*"], writePrincipals: ["*"] },
    ],
  });
  const ns = getConfiguredNamespaces(config);
  assert.deepEqual(ns, ["default"]);
});

// ── resolveNamespaceFromStorageDir ──────────────────────────────────────────

test("resolveNamespaceFromStorageDir: namespaces disabled → always default", () => {
  const config = baseConfig({ namespacesEnabled: false });
  const ns = resolveNamespaceFromStorageDir("/some/path/namespaces/team-a", {
    config,
    configuredNamespaces: getConfiguredNamespaces(config),
  });
  assert.equal(ns, "default");
});

test("resolveNamespaceFromStorageDir: memory root → default", () => {
  const config = baseConfig({ memoryDir: "/data/memory" });
  const ns = resolveNamespaceFromStorageDir("/data/memory", {
    config,
    configuredNamespaces: getConfiguredNamespaces(config),
  });
  assert.equal(ns, "default");
});

test("resolveNamespaceFromStorageDir: configured namespace dir → that namespace", () => {
  const config = baseConfig({
    memoryDir: "/data/memory",
    namespacePolicies: [
      { name: "team-a", readPrincipals: ["*"], writePrincipals: ["*"] },
    ],
  });
  const ns = resolveNamespaceFromStorageDir("/data/memory/namespaces/team-a", {
    config,
    configuredNamespaces: getConfiguredNamespaces(config),
  });
  assert.equal(ns, "team-a");
});

test("resolveNamespaceFromStorageDir: tokenized dir → decoded namespace", () => {
  const config = baseConfig({ memoryDir: "/data/memory" });
  // "alpha" tokenizes to ns-616c706861
  const ns = resolveNamespaceFromStorageDir("/data/memory/namespaces/ns-616c706861", {
    config,
    configuredNamespaces: getConfiguredNamespaces(config),
  });
  assert.equal(ns, "alpha");
});

test("resolveNamespaceFromStorageDir: unknown dir → literal dir name", () => {
  const config = baseConfig({ memoryDir: "/data/memory" });
  const ns = resolveNamespaceFromStorageDir("/data/memory/namespaces/custom-ns", {
    config,
    configuredNamespaces: getConfiguredNamespaces(config),
  });
  assert.equal(ns, "custom-ns");
});

test("resolveNamespaceFromStorageDir: catalog hint resolves single-hint dir", () => {
  const config = baseConfig({ memoryDir: "/data/memory" });
  const resolvedDir = "/data/memory/namespaces/dynamic-xyz";
  const hints = new Map([[resolvedDir, new Set(["my-dynamic-ns"])]]);
  const ns = resolveNamespaceFromStorageDir(resolvedDir, {
    config,
    configuredNamespaces: getConfiguredNamespaces(config),
    hints,
  });
  assert.equal(ns, "my-dynamic-ns");
});

// ── resolveWritableNamespaceValue ───────────────────────────────────────────

test("resolveWritableNamespaceValue: undefined namespace → default, ok", () => {
  const config = baseConfig();
  const result = resolveWritableNamespaceValue(undefined, "sess-1", undefined, config);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.namespace, "default");
});

test("resolveWritableNamespaceValue: explicit namespace, writable principal → ok", () => {
  const config = baseConfig({
    namespacePolicies: [
      { name: "team-a", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
  });
  const result = resolveWritableNamespaceValue("team-a", "alice:sess-1", "alice", config);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.namespace, "team-a");
});

test("resolveWritableNamespaceValue: explicit namespace, non-writable principal → not_writable", () => {
  const config = baseConfig({
    namespacePolicies: [
      { name: "team-a", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
  });
  const result = resolveWritableNamespaceValue("team-a", "bob:sess-1", "bob", config);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_writable");
    assert.equal(result.namespace, "team-a");
  }
});

test("resolveWritableNamespaceValue: non-default namespace with namespaces disabled → unsupported", () => {
  const config = baseConfig({ namespacesEnabled: false });
  const result = resolveWritableNamespaceValue("custom-ns", "sess-1", undefined, config);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unsupported");
    assert.equal(result.namespace, "custom-ns");
  }
});

test("resolveWritableNamespaceValue: namespaces disabled, default namespace → ok", () => {
  const config = baseConfig({ namespacesEnabled: false });
  const result = resolveWritableNamespaceValue("default", "sess-1", undefined, config);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.namespace, "default");
});

test("resolveNamespacePreflight gates on the allow-list, policy, and the requested write op", () => {
  const config = baseConfig({ namespacesEnabled: false });
  // Unrestricted token, observe path: default writable, foreign policy-rejected.
  assert.deepEqual(
    resolveNamespacePreflight(undefined, "default", undefined, undefined, config, "observe"),
    { ok: true, namespace: "default" },
  );
  assert.equal(
    resolveNamespacePreflight(undefined, "team-b", undefined, undefined, config, "observe").ok,
    false,
  );
  // Namespace-scoped token: in-list writable; out-of-list definitive not_writable.
  const scoped = { namespaces: ["default"] } as unknown as TokenCapabilities;
  assert.deepEqual(
    resolveNamespacePreflight(scoped, "default", undefined, undefined, config, "observe"),
    { ok: true, namespace: "default" },
  );
  assert.deepEqual(
    resolveNamespacePreflight(scoped, "team-b", undefined, undefined, config, "observe"),
    { ok: false, reason: "not_writable", namespace: "team-b" },
  );
  // Write-op awareness: a memory_store-only token is not_writable for the
  // observe path but writable for the memory_store path; a token lacking BOTH
  // (diagnostic-only) is never writable.
  const storeOnly = { ops: ["memory_store"] } as unknown as TokenCapabilities;
  assert.equal(
    resolveNamespacePreflight(storeOnly, "default", undefined, undefined, config, "observe").ok,
    false,
  );
  assert.deepEqual(
    resolveNamespacePreflight(storeOnly, "default", undefined, undefined, config, "memory_store"),
    { ok: true, namespace: "default" },
  );
  const diagnosticOnly = { ops: ["namespace_writable"] } as unknown as TokenCapabilities;
  assert.equal(
    resolveNamespacePreflight(diagnosticOnly, "default", undefined, undefined, config, "observe").ok,
    false,
  );
});
