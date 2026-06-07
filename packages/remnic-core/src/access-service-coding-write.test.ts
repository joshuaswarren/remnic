/**
 * #1434: explicit-write tools (memory_store / suggestion_submit) must resolve
 * their write namespace through the SAME project-scope overlay the read path
 * uses, so a memory stored with a client-injected `cwd`/`projectTag` is
 * discoverable by project-scoped recall (rule 42 symmetry). Previously these
 * tools ignored coding context and always wrote to the base namespace.
 *
 * Invariants verified here (review hardening on PR #1444):
 *  - Symmetry: a `projectTag`/`cwd` (or an existing session context) overlays
 *    the project namespace onto the principal self base — the SAME namespace
 *    recall/observe/buffer use — so scoped stores are found by scoped recall.
 *  - Base: the principal self namespace (defaultNamespaceForPrincipal), which
 *    collapses to `config.defaultNamespace` when namespaces are disabled or the
 *    principal has no self policy (the common deployment is unchanged).
 *  - Read-only: the resolver NEVER mutates session coding context, so
 *    idempotency peeks / dryRun preflights are side-effect free (Codex review).
 *  - Persist: a pre-resolved project namespace reaches storage instead of being
 *    rejected by the static policy allow-list (Codex P1 / Cursor High).
 *  - Precedence: explicit `namespace` wins; namespaces-disabled is a no-op.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import { persistExplicitCapture } from "./explicit-capture.js";
import type { ValidExplicitCapture } from "./explicit-capture.js";
import {
  combineNamespaces,
  projectNamespaceName,
  projectTagProjectId,
} from "./coding/coding-namespace.js";
import type { CodingContext, PluginConfig } from "./types.js";

function makeOrchestratorStub(overrides: Partial<PluginConfig> = {}): Orchestrator {
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  const internals = orch as unknown as {
    config: PluginConfig;
    _codingContextBySession: Map<string, CodingContext>;
  };
  internals.config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    codingMode: { projectScope: true },
    memoryDir: "/synthetic/remnic-coding-write",
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
    ...overrides,
  } as unknown as PluginConfig;
  internals._codingContextBySession = new Map();
  return orch;
}

function resolver(service: EngramAccessService) {
  return (req: unknown) =>
    (
      service as unknown as {
        resolveCodingScopedWriteNamespace: (r: unknown) => Promise<string>;
      }
    ).resolveCodingScopedWriteNamespace(req);
}

function projectNamespaceFor(tag: string): string {
  // projectScope (no branch scope) overlay namespace == projectNamespaceName.
  return combineNamespaces("default", projectNamespaceName(projectTagProjectId(tag)));
}

test("#1434 projectTag scopes the write to the project namespace, read-only", async () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);

  const resolved = await resolver(service)({
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
    projectTag: "Blend/Supply",
    content: "x",
  });

  assert.equal(resolved, projectNamespaceFor("Blend/Supply"));
  assert.notEqual(resolved, "default", "project context must change the namespace");
  // Read-only: resolving must NOT persist coding context on the session.
  assert.equal(
    orch.getCodingContextForSession("sess-1"),
    null,
    "resolver must not mutate session coding context (peek/dryRun safety)",
  );
});

test("#1434 an existing session coding context scopes the write (recall-then-store flow)", async () => {
  const orch = makeOrchestratorStub();
  orch.setCodingContextForSession("sess-ctx", {
    projectId: projectTagProjectId("Blend/Supply"),
    branch: null,
    rootPath: projectTagProjectId("Blend/Supply"),
    defaultBranch: null,
  });
  const service = new EngramAccessService(orch);

  const resolved = await resolver(service)({
    sessionKey: "sess-ctx",
    authenticatedPrincipal: "alice",
    content: "x",
  });
  assert.equal(resolved, projectNamespaceFor("Blend/Supply"));
});

test("#1434 explicit namespace wins and bypasses coding overlay", async () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    sessionKey: "sess-2",
    authenticatedPrincipal: "alice",
    namespace: "default",
    projectTag: "Blend/Supply",
    content: "x",
  });
  assert.equal(resolved, "default");
});

test("#1434 unqualified write uses the principal self namespace, matching recall", async () => {
  // Principal "alice" has a self policy: an unqualified write resolves to the
  // same self namespace recall/observe/buffer use (defaultNamespaceForPrincipal),
  // so explicit writes are discoverable by that principal's recall.
  const orch = makeOrchestratorStub({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    sessionKey: "sess-3",
    authenticatedPrincipal: "alice",
    content: "x",
  });
  assert.equal(resolved, "alice");
});

test("#1434 unqualified write with no principal policy stays on the default namespace", async () => {
  // No policy named after the principal => base collapses to defaultNamespace,
  // so behavior is unchanged for the common deployment.
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    sessionKey: "sess-3b",
    authenticatedPrincipal: "alice",
    content: "x",
  });
  assert.equal(resolved, "default");
});

test("#1434 namespaces disabled: cwd/projectTag are a no-op (common single-tenant MCP case)", async () => {
  const orch = makeOrchestratorStub({ namespacesEnabled: false } as Partial<PluginConfig>);
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    sessionKey: "sess-4",
    projectTag: "Blend/Supply",
    content: "x",
  });
  assert.equal(resolved, "default");
});

// ── Persist layer (#1434 P1/High): a pre-resolved project namespace must reach
// storage instead of being rejected by the static policy allow-list. ──────────

function makePersistOrchestrator() {
  const getStorageCalls: Array<string | undefined> = [];
  const orch = {
    config: {
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
    },
    getStorage: async (ns?: string) => {
      getStorageCalls.push(ns);
      return {
        readAllMemories: async () => [],
        writeMemory: async () => "mem-1",
        appendMemoryLifecycleEvents: async () => {},
      };
    },
  } as unknown as Orchestrator;
  return { orch, getStorageCalls };
}

function candidate(overrides: Partial<ValidExplicitCapture> = {}): ValidExplicitCapture {
  return {
    content: "durable project memory",
    category: "fact",
    confidence: 0.9,
    tags: [],
    namespace: "default-project-tag-abc123",
    ...overrides,
  };
}

test("#1434 persistExplicitCapture routes a pre-resolved project namespace to storage", async () => {
  const { orch, getStorageCalls } = makePersistOrchestrator();
  const res = await persistExplicitCapture(
    orch,
    candidate({ namespacePreResolved: true }),
    "memory_store",
  );
  assert.equal(res.id, "mem-1");
  // The dynamic project namespace must be used verbatim (dup-check + write),
  // never rewritten or rejected.
  assert.ok(
    getStorageCalls.every((ns) => ns === "default-project-tag-abc123"),
    `expected all getStorage calls on the project namespace, got ${JSON.stringify(getStorageCalls)}`,
  );
});

test("#1434 persistExplicitCapture still rejects an unauthorized namespace when not pre-resolved", async () => {
  const { orch } = makePersistOrchestrator();
  await assert.rejects(
    persistExplicitCapture(orch, candidate(), "memory_store"),
    /unsupported namespace/,
    "the policy allow-list guard must still apply to callers that do not pre-authorize",
  );
});
