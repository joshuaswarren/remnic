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
import os from "node:os";
import path from "node:path";
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
import { sealedWriteToLegacyArgs, type SealedMemoryEnvelope } from "./write-envelope.js";

function withSealedWrite<T extends { writeMemory: (...args: never[]) => unknown }>(stub: T): T {
  // SAFETY: the decorated stub only gains writeSealedMemory and dir, both assigned below before any caller reads them.
  const decorated = stub as T & {
    writeSealedMemory?: (envelope: SealedMemoryEnvelope, extras?: Record<string, unknown>) => unknown;
    dir?: string;
  };
  // #3354: the fact-dedup window keys its lock on storage.dir and takes a
  // real file lock, so the fake needs a writable per-process dir.
  decorated.dir = path.join(os.tmpdir(), `remnic-coding-write-fake-${process.pid}`);
  decorated.writeSealedMemory = (envelope, extras = {}) => {
    const { category, content, options } = sealedWriteToLegacyArgs(envelope, extras);
    return (stub.writeMemory as (c: unknown, b: unknown, o: unknown) => unknown)(category, content, options);
  };
  return decorated;
}


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
  return combineNamespaces("default", projectNamespaceName(projectTagProjectId(tag)));
}

test("#1434 projectTag scopes the write to the project namespace, read-only", async () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);

  const resolved = await resolver(service)({
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
    projectTag: "Acme/Webshop",
    content: "x",
  });

  assert.equal(resolved, projectNamespaceFor("Acme/Webshop"));
  assert.notEqual(resolved, "default", "project context must change the namespace");
  assert.equal(
    orch.getCodingContextForSession("sess-1"),
    null,
    "resolver must not mutate session coding context (peek/dryRun safety)",
  );
});

test("#1434 a sessionless write with projectTag stays on the base namespace (recall symmetry)", async () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    authenticatedPrincipal: "alice",
    projectTag: "Acme/Webshop",
    content: "x",
  });
  assert.equal(resolved, "default");
});

test("#1434 an existing session coding context scopes the write (recall-then-store flow)", async () => {
  const orch = makeOrchestratorStub();
  orch.setCodingContextForSession("sess-ctx", {
    projectId: projectTagProjectId("Acme/Webshop"),
    branch: null,
    rootPath: projectTagProjectId("Acme/Webshop"),
    defaultBranch: null,
  });
  const service = new EngramAccessService(orch);

  const resolved = await resolver(service)({
    sessionKey: "sess-ctx",
    authenticatedPrincipal: "alice",
    content: "x",
  });
  assert.equal(resolved, projectNamespaceFor("Acme/Webshop"));
});

test("#1434 an existing session binding wins over per-call projectTag (recall symmetry)", async () => {
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
    projectTag: "Acme/Webshop",
    content: "x",
  });
  assert.equal(resolved, "default");
});

test("#1434 unqualified write (self policy) stays on config.defaultNamespace", async () => {
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
  const orch = makeOrchestratorStub({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(orch);
  const resolved = await resolver(service)({
    sessionKey: "sess-3c",
    authenticatedPrincipal: "alice",
    projectTag: "Acme/Webshop",
    content: "x",
  });
  assert.equal(
    resolved,
    combineNamespaces("alice", projectNamespaceName(projectTagProjectId("Acme/Webshop"))),
  );
});

test("#1434 an explicit coding-overlay namespace string is NOT a writable target", async () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  await assert.rejects(
    resolver(service)({
      sessionKey: "sess-explicit-overlay",
      authenticatedPrincipal: "alice",
      namespace: projectNamespaceFor("Acme/Webshop"), // "default-project-…"
      content: "x",
    }),
    /not writable/,
  );
});

test("#1434 a prefix-colliding principal namespace cannot be written cross-tenant (Codex P1)", async () => {
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
    projectTag: "Acme/Webshop",
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
      return withSealedWrite({
        readAllMemories: async () => [],
        writeMemory: async () => ({ id: "mem-1", tombstoneBlocked: false }),
        appendMemoryLifecycleEvents: async () => {},
      });
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
  const { orch, contexts, getStorageCalls } = makeAttachOrchestrator();
  const service = new EngramAccessService(orch);

  const res = await service.memoryStore(
    storeRequest({ sessionKey: "sess-attach", projectTag: "Acme/Webshop" }),
  );

  assert.equal(res.status, "stored");
  assert.equal(res.namespace, projectNamespaceFor("Acme/Webshop"));
  assert.equal(
    contexts.get("sess-attach")?.projectId,
    projectTagProjectId("Acme/Webshop"),
  );
  assert.ok(
    getStorageCalls.every((ns) => ns === projectNamespaceFor("Acme/Webshop")),
    `expected all getStorage calls on the project namespace, got ${JSON.stringify(getStorageCalls)}`,
  );
  const bare = await resolver(service)({
    sessionKey: "sess-attach",
    authenticatedPrincipal: "alice",
    content: "y",
  });
  assert.equal(bare, projectNamespaceFor("Acme/Webshop"));
});

test("#1434 an explicit-namespace store does NOT bind the session to a project (Codex review)", async () => {
  const { orch, contexts } = makeAttachOrchestrator();
  const service = new EngramAccessService(orch);
  const res = await service.memoryStore(
    storeRequest({ sessionKey: "sess-explicit", namespace: "default", projectTag: "Acme/Webshop" }),
  );
  assert.equal(res.status, "stored");
  assert.equal(res.namespace, "default");
  assert.equal(contexts.get("sess-explicit"), undefined, "explicit-namespace write must not bind the session");
});

test("#1434 a dryRun store does NOT bind the session to a project (Codex review)", async () => {
  const { orch, contexts } = makeAttachOrchestrator();
  const service = new EngramAccessService(orch);
  const res = await service.memoryStore(
    storeRequest({ sessionKey: "sess-dry", projectTag: "Acme/Webshop", dryRun: true }),
  );
  assert.equal(res.status, "validated");
  assert.equal(contexts.get("sess-dry"), undefined, "dryRun must not bind the session");
});


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
      return withSealedWrite({
        readAllMemories: async () => [],
        writeMemory: async () => ({ id: "mem-1", tombstoneBlocked: false }),
        appendMemoryLifecycleEvents: async () => {},
      });
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

test("memory_store reports a duplicate for an existing blocked review row", async () => {
  const orch = makeOrchestratorStub();
  let writeCalls = 0;
  const storage = withSealedWrite({
    readAllMemories: async () => [
      {
        path: "/synthetic/remnic-coding-write/memories/blocked.md",
        frontmatter: {
          id: "blocked-existing",
          category: "fact",
          status: "pending_review",
          blockedBy: "tombstone-1",
          tags: [],
        },
        content: "durable blocked memory",
      },
    ],
    writeMemory: async () => {
      writeCalls += 1;
      return { id: "unexpected-write", tombstoneBlocked: true };
    },
    appendMemoryLifecycleEvents: async () => {},
  });
  orch.getStorage = async () => storage as never;
  const service = new EngramAccessService(orch);

  const response = await service.memoryStore({
    content: "durable blocked memory",
    category: "fact",
    confidence: 0.9,
    tags: [],
    authenticatedPrincipal: "alice",
  } as never);

  assert.equal(response.status, "duplicate");
  assert.equal(response.queued, false);
  assert.equal(response.duplicateOf, "blocked-existing");
  assert.equal(writeCalls, 0);
});
