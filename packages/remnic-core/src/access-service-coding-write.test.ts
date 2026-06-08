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

test("#1434 a sessionless write with projectTag stays on the base namespace (recall symmetry)", async () => {
  // Without a sessionKey the recall path can't attach or look up coding context
  // (maybeAttachCodingContext / applyCodingNamespaceOverlay both no-op), so a
  // sessionless recall searches the base namespace. A sessionless write must
  // therefore also stay on the base — else the store would be hidden from the
  // same client's recall (Codex review).
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    authenticatedPrincipal: "alice",
    projectTag: "Blend/Supply",
    content: "x",
  });
  assert.equal(resolved, "default");
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

test("#1434 an existing session binding wins over per-call projectTag (recall symmetry)", async () => {
  // Session is bound to project A; this write also passes per-call projectTag B.
  // The write MUST resolve to A — the same project the session's recall searches
  // (recall is session-first: maybeAttachCodingContext returns early when a
  // context is already attached). A per-call-wins write would land in B, which
  // that session's recall never searches, so the memory would be undiscoverable.
  const orch = makeOrchestratorStub();
  orch.setCodingContextForSession("sess-reuse", {
    projectId: projectTagProjectId("Project/A"),
    branch: null,
    rootPath: projectTagProjectId("Project/A"),
    defaultBranch: null,
  });
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    sessionKey: "sess-reuse",
    authenticatedPrincipal: "alice",
    projectTag: "Project/B",
    content: "x",
  });
  assert.equal(resolved, projectNamespaceFor("Project/A"));
  assert.notEqual(resolved, projectNamespaceFor("Project/B"));
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

test("#1434 unqualified write (self policy) stays on config.defaultNamespace", async () => {
  // Even when principal "alice" has a self policy, an UNQUALIFIED write (no
  // coding overlay) stays on config.defaultNamespace — exactly the pre-#1434
  // behavior. #1434 only re-scopes project-identified writes; it must not
  // silently move plain unqualified writes to a principal self namespace (Codex
  // review). The symmetry fix applies to the coding-overlay path only.
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
  assert.equal(resolved, "default");
});

test("#1434 unqualified write with no principal policy stays on the default namespace", async () => {
  // No policy named after the principal => base is defaultNamespace, so behavior
  // is unchanged for the common deployment.
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    sessionKey: "sess-3b",
    authenticatedPrincipal: "alice",
    content: "x",
  });
  assert.equal(resolved, "default");
});

test("#1434 project write overlays onto the principal self base (recall symmetry)", async () => {
  // With a self policy, a project-scoped write overlays onto the principal self
  // base (defaultNamespaceForPrincipal) — the SAME base recall/observe/buffer
  // overlay onto — so the store is discoverable by that principal's
  // project-scoped recall (Cursor review / rule 42).
  const orch = makeOrchestratorStub({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    sessionKey: "sess-3c",
    authenticatedPrincipal: "alice",
    projectTag: "Blend/Supply",
    content: "x",
  });
  assert.equal(
    resolved,
    combineNamespaces("alice", projectNamespaceName(projectTagProjectId("Blend/Supply"))),
  );
});

test("#1434 an explicit coding-overlay namespace string is NOT a writable target", async () => {
  // Project scoping is requested via cwd/projectTag, never by naming the derived
  // overlay namespace. A caller naming an overlay-shaped namespace directly is
  // authorized strictly through canWriteNamespace and rejected, so the persist
  // allow-list can never be bypassed by guessing an overlay name.
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  await assert.rejects(
    resolver(service)({
      sessionKey: "sess-explicit-overlay",
      authenticatedPrincipal: "alice",
      namespace: projectNamespaceFor("Blend/Supply"), // "default-project-…"
      content: "x",
    }),
    /not writable/,
  );
});

test("#1434 a prefix-colliding principal namespace cannot be written cross-tenant (Codex P1)", async () => {
  // Policies for both `alice` and `alice-project-team`. An authenticated `alice`
  // must NOT be able to write `alice-project-team-project-foo` (the OTHER
  // principal's project-scoped namespace) by exploiting a shared `alice-project-`
  // prefix. Strict canWriteNamespace authorization rejects it.
  const orch = makeOrchestratorStub({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
      {
        name: "alice-project-team",
        readPrincipals: ["teamuser"],
        writePrincipals: ["teamuser"],
      },
    ],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(orch);
  await assert.rejects(
    resolver(service)({
      sessionKey: "sess-collide",
      authenticatedPrincipal: "alice",
      namespace: "alice-project-team-project-foo",
      content: "x",
    }),
    /not writable/,
  );
});

test("#1434 a derived overlay base the principal cannot write is rejected (Codex P1)", async () => {
  // The principal has a self policy but NO write access to the configured
  // default namespace. An explicit `default-project-foo` must be rejected —
  // overlay namespaces are never accepted as caller strings, and the base must
  // pass canWriteNamespace.
  const orch = makeOrchestratorStub({
    defaultNamespace: "default",
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
      { name: "default", readPrincipals: ["admin"], writePrincipals: ["admin"] },
    ],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(orch);
  await assert.rejects(
    resolver(service)({
      sessionKey: "sess-base-noauth",
      authenticatedPrincipal: "alice",
      namespace: "default-project-foo",
      content: "x",
    }),
    /not writable/,
  );
});

test("#1434 a forged cross-principal namespace cannot widen access", async () => {
  // A caller naming a namespace that is not writable for this principal is
  // rejected by canWriteNamespace — it can't escalate to another principal's
  // namespace.
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  await assert.rejects(
    resolver(service)({
      sessionKey: "sess-forge",
      authenticatedPrincipal: "alice",
      namespace: "victim-secret",
      content: "x",
    }),
    /not writable/,
  );
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

function makeAttachOrchestrator() {
  const contexts = new Map<string, CodingContext>();
  const getStorageCalls: Array<string | undefined> = [];
  const orch = {
    config: {
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
      codingMode: { projectScope: true },
      memoryDir: "/synthetic/remnic-coding-write-attach",
      recallCrossNamespaceBudgetEnabled: false,
      recallCrossNamespaceBudgetWindowMs: 60_000,
      recallCrossNamespaceBudgetSoftLimit: 10,
      recallCrossNamespaceBudgetHardLimit: 30,
    },
    getCodingContextForSession: (sk: string) => contexts.get(sk) ?? null,
    setCodingContextForSession: (sk: string, ctx: CodingContext) => {
      contexts.set(sk, ctx);
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
  return { orch, contexts, getStorageCalls };
}

function storeRequest(
  overrides: Record<string, unknown>,
): Parameters<EngramAccessService["memoryStore"]>[0] {
  return {
    authenticatedPrincipal: "alice",
    content: "durable project memory",
    category: "fact",
    confidence: 0.9,
    tags: [],
    ...overrides,
  } as unknown as Parameters<EngramAccessService["memoryStore"]>[0];
}

test("#1434 a real memory_store attaches coding context so a later bare recall on the session is scoped (Cursor review)", async () => {
  // A store with sessionKey + per-call projectTag must seed the session's
  // coding binding (like recall's maybeAttachCodingContext), so a SUBSEQUENT
  // bare recall on the same session — one that omits cwd/projectTag — is scoped
  // to the same project and finds the memory.
  const { orch, contexts, getStorageCalls } = makeAttachOrchestrator();
  const service = new EngramAccessService(orch);

  const res = await service.memoryStore(
    storeRequest({ sessionKey: "sess-attach", projectTag: "Blend/Supply" }),
  );

  assert.equal(res.status, "stored");
  assert.equal(res.namespace, projectNamespaceFor("Blend/Supply"));
  // The store attached the coding context the recall path reads.
  assert.equal(
    contexts.get("sess-attach")?.projectId,
    projectTagProjectId("Blend/Supply"),
  );
  assert.ok(
    getStorageCalls.every((ns) => ns === projectNamespaceFor("Blend/Supply")),
    `expected all getStorage calls on the project namespace, got ${JSON.stringify(getStorageCalls)}`,
  );
  // A later BARE resolve (no per-call context) on the same session — what a
  // subsequent recall on this session uses — is now scoped to the same project.
  const bare = await resolver(service)({
    sessionKey: "sess-attach",
    authenticatedPrincipal: "alice",
    content: "y",
  });
  assert.equal(bare, projectNamespaceFor("Blend/Supply"));
});

test("#1434 an explicit-namespace store does NOT bind the session to a project (Codex review)", async () => {
  // An explicit `namespace` bypasses the coding overlay, so the write must not
  // seed a project binding the session never wrote to — else later bare recalls
  // would search a project namespace with no committed memory.
  const { orch, contexts } = makeAttachOrchestrator();
  const service = new EngramAccessService(orch);
  const res = await service.memoryStore(
    storeRequest({ sessionKey: "sess-explicit", namespace: "default", projectTag: "Blend/Supply" }),
  );
  assert.equal(res.status, "stored");
  assert.equal(res.namespace, "default");
  assert.equal(contexts.get("sess-explicit"), undefined, "explicit-namespace write must not bind the session");
});

test("#1434 a dryRun store does NOT bind the session to a project (Codex review)", async () => {
  // A dryRun is a read-only preview; it must not mutate session coding context.
  const { orch, contexts } = makeAttachOrchestrator();
  const service = new EngramAccessService(orch);
  const res = await service.memoryStore(
    storeRequest({ sessionKey: "sess-dry", projectTag: "Blend/Supply", dryRun: true }),
  );
  assert.equal(res.status, "validated");
  assert.equal(contexts.get("sess-dry"), undefined, "dryRun must not bind the session");
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
