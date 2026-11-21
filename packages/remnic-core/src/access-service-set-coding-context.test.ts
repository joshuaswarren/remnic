/**
 * #3515 review (wAK): `setCodingContext` must bind set AND clear to the
 * caller's authenticated principal, and a client-supplied rootPath must be
 * marked remote so no daemon surface opens it as a local path.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("a remote post whose root is a repo on the daemon host keeps its local root", () => {
  const orch = makeOrchestratorStub({ namespacesEnabled: false });
  const service = new EngramAccessService(orch);
  // Same-host pane: the client-resolved root exists on this filesystem, so
  // surfaces must get the real path, not the degraded tag label.
  const repoRoot = mkdtempSync(join(tmpdir(), "same-host-repo-"));
  try {
    mkdirSync(join(repoRoot, ".git"));
    service.setCodingContext({
      sessionKey: "pane-1",
      codingContext: { projectId: "origin:abc123", branch: "main", rootPath: repoRoot, defaultBranch: "main" },
      remote: true,
    });
    const ctx = orch.getCodingContextForSession("pane-1");
    assert.notEqual(ctx?.remote, true, "a daemon-visible repo root must not stay remote");
    assert.equal(codingContextLocalRoot(ctx!), repoRoot);
    // A linked worktree carries a .git file, not a directory.
    const worktreeRoot = mkdtempSync(join(tmpdir(), "same-host-worktree-"));
    try {
      writeFileSync(join(worktreeRoot, ".git"), "gitdir: /elsewhere");
      service.setCodingContext({
        sessionKey: "pane-2",
        codingContext: { projectId: "origin:def456", branch: "main", rootPath: worktreeRoot, defaultBranch: "main" },
        remote: true,
      });
      assert.equal(codingContextLocalRoot(orch.getCodingContextForSession("pane-2")!), worktreeRoot);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    // A directory that is not a repo still degrades to the tag label.
    const plainDir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    try {
      service.setCodingContext({
        sessionKey: "pane-3",
        codingContext: { projectId: "origin:ghi789", branch: "main", rootPath: plainDir, defaultBranch: "main" },
        remote: true,
      });
      const plain = orch.getCodingContextForSession("pane-3");
      assert.equal(plain?.remote, true);
      assert.equal(codingContextLocalRoot(plain!), "tag:origin:ghi789");
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
    // A path that does not exist here stays remote.
    service.setCodingContext({
      sessionKey: "pane-4",
      codingContext: { projectId: "origin:jkl000", branch: "main", rootPath: "/nonexistent/remote/repo", defaultBranch: "main" },
      remote: true,
    });
    const missing = orch.getCodingContextForSession("pane-4");
    assert.equal(missing?.remote, true);
    assert.equal(codingContextLocalRoot(missing!), "tag:origin:jkl000");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
