/**
 * #3515 review (wAK): `setCodingContext` must bind set AND clear to the
 * caller's authenticated principal, and a client-supplied rootPath must be
 * marked remote so no daemon surface opens it as a local path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { codingContextLocalRoot } from "./access-coding-context-resolution.js";
import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface OrchestratorInternals {
  config: PluginConfig;
  _codingContextBySession: Map<string, CodingContext>;
}

function makeOrchestratorStub(overrides: Partial<PluginConfig> = {}): Orchestrator {
  const orch = Object.create(Orchestrator.prototype);
  const internals: OrchestratorInternals = orch;
  // SAFETY: test stub config — only the fields setCodingContext reads are populated.
  internals.config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    codingMode: { projectScope: true },
    memoryDir: "/synthetic/remnic-set-coding-context",
    ...overrides,
  } as PluginConfig;
  internals._codingContextBySession = new Map();
  return orch;
}

const CTX = {
  projectId: "origin:aaaa0001",
  branch: "main",
  rootPath: "/repo/a",
  defaultBranch: "main",
};

test("a foreign principal cannot set a session's coding context", () => {
  const service = new EngramAccessService(makeOrchestratorStub());
  // "agent:bob:…" derives principal "bob"; caller alice is not the owner.
  assert.throws(
    () => service.setCodingContext({ sessionKey: "agent:bob:slack:c1", codingContext: CTX, authenticatedPrincipal: "alice" }),
    /not owned by authenticated principal/,
  );
});

test("a foreign principal cannot clear a session's coding context", () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  service.setCodingContext({ sessionKey: "agent:bob:slack:c1", codingContext: CTX, authenticatedPrincipal: "bob" });
  assert.throws(
    () => service.setCodingContext({ sessionKey: "agent:bob:slack:c1", codingContext: null, authenticatedPrincipal: "alice" }),
    /not owned by authenticated principal/,
  );
  assert.notEqual(orch.getCodingContextForSession("agent:bob:slack:c1"), null, "rejected clear must not drop the context");
});

test("the owning principal can set and clear; an unclaimed (default) session binds to the first caller", () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  service.setCodingContext({ sessionKey: "agent:alice:slack:c1", codingContext: CTX, authenticatedPrincipal: "alice" });
  service.setCodingContext({ sessionKey: "agent:alice:slack:c1", codingContext: null, authenticatedPrincipal: "alice" });
  assert.equal(orch.getCodingContextForSession("agent:alice:slack:c1"), null);
  // "pane-42" derives "default" — not principal-owned, first caller binds.
  service.setCodingContext({ sessionKey: "pane-42", codingContext: CTX, authenticatedPrincipal: "alice" });
  assert.notEqual(orch.getCodingContextForSession("pane-42"), null);
});

test("a missing authenticated principal is rejected while namespaces are enabled", () => {
  const service = new EngramAccessService(makeOrchestratorStub());
  assert.throws(
    () => service.setCodingContext({ sessionKey: "agent:alice:slack:c1", codingContext: CTX }),
    /not owned by authenticated principal/,
  );
});

test("namespaces-disabled keeps the binding permissive", () => {
  const orch = makeOrchestratorStub({ namespacesEnabled: false });
  const service = new EngramAccessService(orch);
  service.setCodingContext({ sessionKey: "agent:bob:slack:c1", codingContext: CTX });
  assert.notEqual(orch.getCodingContextForSession("agent:bob:slack:c1"), null);
});

test("client-supplied roots are marked remote; daemon-resolved roots are not", () => {
  const orch = makeOrchestratorStub({ namespacesEnabled: false });
  const service = new EngramAccessService(orch);
  service.setCodingContext({ sessionKey: "remote-1", codingContext: CTX, remote: true });
  service.setCodingContext({ sessionKey: "local-1", codingContext: CTX });
  assert.equal(orch.getCodingContextForSession("remote-1")?.remote, true);
  assert.notEqual(orch.getCodingContextForSession("local-1")?.remote, true);
});

test("the first authenticated writer to an unclaimed session owns it until cleared", () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  // alice binds pane-42; the claim must outlive the config-derived "default".
  service.setCodingContext({ sessionKey: "pane-42", codingContext: CTX, authenticatedPrincipal: "alice" });
  assert.throws(
    () => service.setCodingContext({ sessionKey: "pane-42", codingContext: CTX, authenticatedPrincipal: "bob" }),
    /not owned by authenticated principal/,
  );
  assert.throws(
    () => service.setCodingContext({ sessionKey: "pane-42", codingContext: null, authenticatedPrincipal: "bob" }),
    /not owned by authenticated principal/,
  );
  // A principal-less caller cannot overwrite a claimed session either.
  assert.throws(
    () => service.setCodingContext({ sessionKey: "pane-42", codingContext: CTX }),
    /not owned by authenticated principal/,
  );
  // Clearing releases the claim: the next caller binds fresh.
  service.setCodingContext({ sessionKey: "pane-42", codingContext: null, authenticatedPrincipal: "alice" });
  service.setCodingContext({ sessionKey: "pane-42", codingContext: CTX, authenticatedPrincipal: "bob" });
  assert.notEqual(orch.getCodingContextForSession("pane-42"), null);
});

test("an internal caller may write an unclaimed session without a principal", () => {
  const orch = makeOrchestratorStub();
  const service = new EngramAccessService(orch);
  // Daemon-internal attaches (cwd/projectTag resolution, recall fallback)
  // carry no transport principal; an unclaimed session accepts the write
  // without it creating an ownership claim.
  service.setCodingContext({ sessionKey: "pane-77", codingContext: CTX });
  assert.notEqual(orch.getCodingContextForSession("pane-77"), null);
  service.setCodingContext({ sessionKey: "pane-77", codingContext: CTX, authenticatedPrincipal: "carol" });
  assert.throws(
    () => service.setCodingContext({ sessionKey: "pane-77", codingContext: CTX }),
    /not owned by authenticated principal/,
  );
});

test("a remote context's local root degrades to the tag label, never a path", () => {
  const orch = makeOrchestratorStub({ namespacesEnabled: false });
  const service = new EngramAccessService(orch);
  service.setCodingContext({
    sessionKey: "remote-path",
    codingContext: { ...CTX, projectId: "/srv/secrets" },
    remote: true,
  });
  const ctx = orch.getCodingContextForSession("remote-path");
  assert.equal(ctx?.remote, true);
  // The caller-shaped path must never come back as a daemon-openable root.
  assert.equal(codingContextLocalRoot(ctx!), "tag:/srv/secrets");
  assert.equal(codingContextLocalRoot({ ...CTX, projectId: "tag:x", remote: true }), "tag:x");
});
