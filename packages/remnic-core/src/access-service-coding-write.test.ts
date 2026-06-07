/**
 * #1434: explicit-write tools (memory_store / suggestion_submit) must resolve
 * their write namespace through the SAME project-scope overlay the read path
 * uses, so a memory stored with a client-injected `cwd`/`projectTag` is
 * discoverable by project-scoped recall (rule 42 symmetry). Previously these
 * tools ignored coding context and always wrote to the base namespace.
 *
 * These tests exercise the private `resolveCodingScopedWriteNamespace` resolver
 * against a real `Orchestrator.prototype` stub, so `applyCodingNamespaceOverlay`
 * is the actual shared read/write primitive (no divergence risk).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import { defaultNamespaceForPrincipal } from "./namespaces/principal.js";
import type { CodingContext, PluginConfig } from "./types.js";

function makeOrchestratorStub(
  overrides: Partial<PluginConfig> = {},
): Orchestrator {
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

test("#1434 memory_store resolves the project namespace from projectTag, matching the shared overlay", async () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);

  const resolved = await (
    service as unknown as {
      resolveCodingScopedWriteNamespace: (req: unknown) => Promise<string>;
    }
  ).resolveCodingScopedWriteNamespace({
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
    projectTag: "Blend/Supply",
    content: "x",
  });

  // The resolver must route through the documented shared read/write overlay
  // primitive, so store and recall land on the same namespace (rule 42).
  const base = defaultNamespaceForPrincipal("alice", orch.config);
  const expected = orch.applyCodingNamespaceOverlay("sess-1", base);
  assert.equal(resolved, expected);
  assert.notEqual(resolved, base, "project context must change the namespace");
});

test("#1434 explicit namespace wins and bypasses coding overlay (no context attached)", async () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);

  const resolved = await (
    service as unknown as {
      resolveCodingScopedWriteNamespace: (req: unknown) => Promise<string>;
    }
  ).resolveCodingScopedWriteNamespace({
    sessionKey: "sess-2",
    authenticatedPrincipal: "alice",
    namespace: "default",
    projectTag: "Blend/Supply",
    content: "x",
  });

  assert.equal(resolved, "default");
  assert.equal(
    orch.getCodingContextForSession("sess-2"),
    null,
    "explicit-namespace path must short-circuit before attaching coding context",
  );
});

test("#1434 no coding context resolves to the base namespace (no behavior change)", async () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);

  const resolved = await (
    service as unknown as {
      resolveCodingScopedWriteNamespace: (req: unknown) => Promise<string>;
    }
  ).resolveCodingScopedWriteNamespace({
    sessionKey: "sess-3",
    authenticatedPrincipal: "alice",
    content: "x",
  });

  assert.equal(resolved, defaultNamespaceForPrincipal("alice", orch.config));
});

test("#1434 a write rejected by base-namespace auth does not attach coding context (cursor Medium)", async () => {
  // A principal whose base namespace policy denies writes => resolution must
  // throw BEFORE attaching cwd/projectTag, leaving no orphaned coding context on
  // the session (mirrors observe's ordering).
  const orch = makeOrchestratorStub({
    namespacePolicies: [
      { name: "bob", readPrincipals: ["bob"], writePrincipals: [] },
    ],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(orch);

  await assert.rejects(
    (
      service as unknown as {
        resolveCodingScopedWriteNamespace: (req: unknown) => Promise<string>;
      }
    ).resolveCodingScopedWriteNamespace({
      sessionKey: "sess-denied",
      authenticatedPrincipal: "bob",
      projectTag: "Blend/Supply",
      content: "x",
    }),
    /not writable/,
  );
  assert.equal(
    orch.getCodingContextForSession("sess-denied"),
    null,
    "rejected write must not leave coding context attached",
  );
});

test("#1434 namespaces disabled: cwd/projectTag are a no-op (common single-tenant MCP case)", async () => {
  const orch = makeOrchestratorStub({ namespacesEnabled: false } as Partial<PluginConfig>);
  const service = new EngramAccessService(orch);

  const resolved = await (
    service as unknown as {
      resolveCodingScopedWriteNamespace: (req: unknown) => Promise<string>;
    }
  ).resolveCodingScopedWriteNamespace({
    sessionKey: "sess-4",
    projectTag: "Blend/Supply",
    content: "x",
  });

  assert.equal(resolved, "default");
});
