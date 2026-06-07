/**
 * #1434: explicit-write tools (memory_store / suggestion_submit) must resolve
 * their write namespace through the SAME project-scope overlay the read path
 * uses, so a memory stored with a client-injected `cwd`/`projectTag` is
 * discoverable by project-scoped recall (rule 42 symmetry). Previously these
 * tools ignored coding context and always wrote to the base namespace.
 *
 * Invariants verified here (review hardening on PR #1444):
 *  - Symmetry: a `projectTag`/`cwd` (or an existing session context) overlays
 *    the project namespace onto the base.
 *  - Base preserved: unqualified writes stay on `config.defaultNamespace` — they
 *    are NOT moved to a principal self namespace (Codex review).
 *  - Read-only: the resolver NEVER mutates session coding context, so
 *    idempotency peeks / dryRun preflights are side-effect free (Codex review).
 *  - Precedence: explicit `namespace` wins; namespaces-disabled is a no-op.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
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

test("#1434 unqualified write stays on config.defaultNamespace (no self-namespace drift)", async () => {
  // Principal "alice" has a self policy, but an unqualified write with no coding
  // context must still land on the global default namespace, not "alice".
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
