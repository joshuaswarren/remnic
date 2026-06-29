/**
 * #1495: `observe` must resolve EVERY memory-producing side effect through ONE
 * effective scope plan, so observed turns and extracted memories land in the
 * SAME namespace that same-session project-scoped recall searches.
 *
 * Before this change, `observe`:
 *  - applied the coding overlay to the objective-state snapshot target, but
 *  - keyed LCM archival (`lcmSessionKey`) and extraction replay turns off the
 *    EARLIER base namespace (`resolveWritableNamespace(undefined, …)` ==
 *    `config.defaultNamespace`), and
 *  - returned the base namespace in the response.
 *
 * The fix introduces an internal `MemoryScopePlan` resolver. `observe` consumes
 * it so the LCM key, the extraction write target, the objective-state target,
 * and the response `effectiveNamespace` all agree.
 *
 * Invariants verified here (rule 39 / 42 / 47 / 48 / 51):
 *  - Agreement: LCM key, extraction writeNamespaceOverride, objective-state
 *    target, and response.effectiveNamespace ALL == scope.writeNamespace, and
 *    that equals what a same-session project-scoped resolve produces.
 *  - Explicit namespace wins and is NOT silently overridden by project context.
 *  - No sessionKey ⇒ no overlay (observe requires a sessionKey, so this is the
 *    explicit-namespace / namespaces-disabled equivalents).
 *  - `codingMode.projectScope: false` ⇒ no overlay.
 *  - `namespacesEnabled: false` ⇒ single-store behavior preserved.
 *  - Unauthorized explicit namespace throws BEFORE any session-context mutation.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { EngramAccessObserveRequest } from "./access-service.js";
import {
  combineNamespaces,
  projectNamespaceName,
  projectTagProjectId,
} from "./coding/coding-namespace.js";
import { resolveGitContext } from "./coding/git-context.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface ObserveProbe {
  orch: Orchestrator;
  contexts: Map<string, CodingContext>;
  lcmCalls: Array<{ sessionKey: string }>;
  extractionCalls: Array<{
    sessionKeys: string[];
    writeNamespaceOverride?: string;
  }>;
  objectiveStateNamespaces: string[];
}

/**
 * Build an orchestrator stub wired to record every namespace-bearing side
 * effect `observe` produces: LCM enqueue, extraction replay, and the storage
 * router lookup that the objective-state snapshot writer goes through.
 */
function makeObserveProbe(overrides: Partial<PluginConfig> = {}): ObserveProbe {
  const contexts = new Map<string, CodingContext>();
  const lcmCalls: ObserveProbe["lcmCalls"] = [];
  const extractionCalls: ObserveProbe["extractionCalls"] = [];
  const objectiveStateNamespaces: string[] = [];

  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    codingMode: { projectScope: true },
    memoryDir: "/synthetic/remnic-observe-scope",
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
    ...overrides,
  } as unknown as PluginConfig;

  const orch = {
    config,
    getCodingContextForSession: (sk: string | undefined) =>
      (sk ? contexts.get(sk) : null) ?? null,
    setCodingContextForSession: (sk: string, ctx: CodingContext | null) => {
      if (ctx === null) contexts.delete(sk);
      else contexts.set(sk, ctx);
    },
    applyCodingNamespaceOverlay: (sk: string | undefined, base: string) =>
      Orchestrator.prototype.applyCodingNamespaceOverlay.call(orch, sk, base),
    // The objective-state snapshot writer goes through getStorage(namespace).
    // Capturing the namespace it resolves lets us assert the objective-state
    // target without touching the filesystem.
    getStorage: async (ns: string) => {
      objectiveStateNamespaces.push(ns);
      return { dir: `/synthetic/storage/${ns}` };
    },
    lcmEngine: {
      enabled: true,
      enqueueObserveMessages: (sessionKey: string) => {
        lcmCalls.push({ sessionKey });
      },
    },
    ingestReplayBatch: async (
      turns: Array<{ sessionKey: string }>,
      options: { writeNamespaceOverride?: string } = {},
    ) => {
      extractionCalls.push({
        sessionKeys: turns.map((t) => t.sessionKey),
        writeNamespaceOverride: options.writeNamespaceOverride,
      });
    },
  } as unknown as Orchestrator;

  return { orch, contexts, lcmCalls, extractionCalls, objectiveStateNamespaces };
}

function observeRequest(
  overrides: Partial<EngramAccessObserveRequest>,
): EngramAccessObserveRequest {
  return {
    sessionKey: "sess-observe",
    messages: [
      { role: "user", content: "what database are we using?" },
      { role: "assistant", content: "we use postgres for the primary store" },
    ],
    ...overrides,
  } as EngramAccessObserveRequest;
}

/** A principal whose self namespace exists, so the overlay base is non-default. */
function withSelfPolicyPrefix(principal: string): Partial<PluginConfig> {
  return {
    namespacePolicies: [
      { name: principal, readPrincipals: [principal], writePrincipals: [principal] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: `${principal}:`, principal }],
  } as Partial<PluginConfig>;
}

test("#1495 projectTag: LCM, extraction, objective-state, and response all agree on the effective namespace", async () => {
  const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Blend/Supply" }),
  );

  // Effective write namespace == principal self base overlaid with the project,
  // EXACTLY what a same-session project-scoped recall/store resolves.
  const expected = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Blend/Supply")),
  );

  assert.equal(res.effectiveNamespace, expected, "response effectiveNamespace");
  assert.notEqual(expected, "default", "overlay must change the namespace");

  // LCM archival key carries the effective namespace prefix.
  assert.equal(probe.lcmCalls.length, 1);
  assert.equal(
    probe.lcmCalls[0].sessionKey,
    `${expected}:pi-geek:abc123`,
    "LCM key must be prefixed with the EFFECTIVE write namespace",
  );

  // Extraction replay turns key off the effective namespace and pin the write.
  assert.equal(probe.extractionCalls.length, 1);
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set([`${expected}:pi-geek:abc123`]),
    "extraction replay turns must carry the effective-namespace session key",
  );
  assert.equal(
    probe.extractionCalls[0].writeNamespaceOverride,
    expected,
    "extraction must pin the write to the effective namespace",
  );

  // Objective-state snapshot target == effective namespace.
  assert.ok(
    probe.objectiveStateNamespaces.every((ns) => ns === expected),
    `objective-state target must be the effective namespace, got ${JSON.stringify(probe.objectiveStateNamespaces)}`,
  );
});

test("#1495 cwd (git repo): every observe side effect agrees on the effective namespace", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "remnic-observe-git-"));
  // A real (synthetic) git repo so resolveGitContext can read rev-parse output.
  // No remote/commit needed — projectId derives from the resolved root path.
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  try {
    const gitCtx = await resolveGitContext(repoDir);
    assert.ok(gitCtx, "synthetic repo must resolve a git context");

    const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
    const service = new EngramAccessService(probe.orch);

    const res = await service.observe(
      observeRequest({ sessionKey: "pi-geek:cwd1", cwd: repoDir }),
    );

    const expected = combineNamespaces(
      "pi-geek",
      projectNamespaceName(gitCtx!.projectId),
    );

    assert.equal(res.effectiveNamespace, expected);
    assert.equal(probe.lcmCalls[0].sessionKey, `${expected}:pi-geek:cwd1`);
    assert.deepEqual(
      new Set(probe.extractionCalls[0].sessionKeys),
      new Set([`${expected}:pi-geek:cwd1`]),
    );
    assert.equal(probe.extractionCalls[0].writeNamespaceOverride, expected);
    assert.ok(probe.objectiveStateNamespaces.every((ns) => ns === expected));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("#1495 explicit namespace wins and project context does NOT silently override it", async () => {
  const probe = makeObserveProbe({
    namespacePolicies: [
      { name: "team", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({
      sessionKey: "pi-geek:abc123",
      namespace: "team",
      projectTag: "Blend/Supply",
    }),
  );

  assert.equal(res.effectiveNamespace, "team", "explicit namespace must win");
  assert.equal(probe.lcmCalls[0].sessionKey, "team:pi-geek:abc123");
  assert.equal(probe.extractionCalls[0].writeNamespaceOverride, "team");
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["team:pi-geek:abc123"]),
  );
  assert.ok(probe.objectiveStateNamespaces.every((ns) => ns === "team"));
});

test("#1495 projectScope:false ⇒ no overlay (unqualified write stays on config.defaultNamespace)", async () => {
  // With projectScope off there is NO coding overlay, so an unqualified observe
  // stays on config.defaultNamespace — exactly the pre-#1434 / memory_store
  // behavior for an unqualified write (rule 39: identical across paths). It must
  // NOT be silently moved to the principal self namespace. lcmSessionKey carries
  // no prefix (effective == default), and no extraction override is needed.
  const probe = makeObserveProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    codingMode: { projectScope: false },
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Blend/Supply" }),
  );

  assert.equal(res.effectiveNamespace, "default");
  assert.equal(res.scopeDebug!.codingOverlayApplied, false);
  assert.equal(probe.lcmCalls[0].sessionKey, "pi-geek:abc123");
  assert.equal(probe.extractionCalls[0].writeNamespaceOverride, undefined);
});

test("#1495 namespacesEnabled:false ⇒ single-store behavior preserved", async () => {
  const probe = makeObserveProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Blend/Supply" }),
  );

  assert.equal(res.effectiveNamespace, "default");
  assert.equal(res.namespace, "default");
  // No namespace prefix on the LCM key when the effective ns is the default.
  assert.equal(probe.lcmCalls[0].sessionKey, "pi-geek:abc123");
  // No override needed when there is only one store.
  assert.equal(probe.extractionCalls[0].writeNamespaceOverride, undefined);
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["pi-geek:abc123"]),
  );
});

test("#1495 unauthorized explicit namespace throws BEFORE session context is attached", async () => {
  const probe = makeObserveProbe();
  const service = new EngramAccessService(probe.orch);

  await assert.rejects(
    service.observe(
      observeRequest({
        sessionKey: "pi-geek:abc123",
        namespace: "victim-secret",
        projectTag: "Blend/Supply",
      }),
    ),
    /not writable/,
  );

  // No orphaned coding context, no side effects after the auth failure.
  assert.equal(probe.contexts.get("pi-geek:abc123"), undefined);
  assert.equal(probe.lcmCalls.length, 0);
  assert.equal(probe.extractionCalls.length, 0);
  assert.equal(probe.objectiveStateNamespaces.length, 0);
});

test("#1495 scopeDebug exposes the resolved plan for callers/tests", async () => {
  const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Blend/Supply" }),
  );

  const expected = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Blend/Supply")),
  );
  assert.ok(res.scopeDebug, "scopeDebug must be present");
  assert.equal(res.scopeDebug!.principal, "pi-geek");
  assert.equal(res.scopeDebug!.baseNamespace, "pi-geek");
  assert.equal(res.scopeDebug!.writeNamespace, expected);
  assert.equal(res.scopeDebug!.codingOverlayApplied, true);
});

test("#1495 the scope plan's writeNamespace matches resolveCodingScopedWriteNamespace (memory_store / suggestion_submit parity, rule 39)", async () => {
  // Regression guard: observe's effective scope MUST be identical to what the
  // explicit-write tools (memory_store / suggestion_submit) resolve via
  // resolveCodingScopedWriteNamespace. If these ever diverge, observed turns and
  // explicit writes on the same session/project would land in different stores.
  const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
  // Bind a session coding context so both resolvers see the same project.
  probe.contexts.set("pi-geek:abc123", {
    projectId: projectTagProjectId("Blend/Supply"),
    branch: null,
    rootPath: projectTagProjectId("Blend/Supply"),
    defaultBranch: null,
  });
  const service = new EngramAccessService(probe.orch);

  const internals = service as unknown as {
    resolveMemoryScopePlan: (r: unknown) => Promise<{ writeNamespace: string }>;
    resolveCodingScopedWriteNamespace: (r: unknown) => Promise<string>;
  };

  for (const req of [
    { sessionKey: "pi-geek:abc123", authenticatedPrincipal: "pi-geek" },
    {
      sessionKey: "pi-geek:abc123",
      authenticatedPrincipal: "pi-geek",
      namespace: "pi-geek",
    },
  ]) {
    const plan = await internals.resolveMemoryScopePlan.call(service, req);
    const explicit = await internals.resolveCodingScopedWriteNamespace.call(
      service,
      req,
    );
    assert.equal(
      plan.writeNamespace,
      explicit,
      `observe and explicit-write resolvers must agree for ${JSON.stringify(req)}`,
    );
  }
});

test("#1495 skipExtraction does not enqueue extraction but still archives LCM under the effective namespace", async () => {
  const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({
      sessionKey: "pi-geek:abc123",
      projectTag: "Blend/Supply",
      skipExtraction: true,
    }),
  );

  const expected = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Blend/Supply")),
  );
  assert.equal(res.extractionQueued, false);
  assert.equal(probe.extractionCalls.length, 0);
  assert.equal(probe.lcmCalls[0].sessionKey, `${expected}:pi-geek:abc123`);
});
