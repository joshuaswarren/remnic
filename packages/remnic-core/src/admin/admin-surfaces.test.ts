/**
 * Tests for the admin console surfaces (issue #1502).
 *
 * Each surface is exercised against the SAME core APIs the runtime uses so
 * the acceptance criteria ("scope inspector returns the same plan as runtime
 * resolver"; "promotion requires reason and enforces authorization"; etc.)
 * hold by construction rather than by mock.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NamespaceCatalog } from "../namespaces/catalog.js";
import { parseConfig } from "../config.js";
import {
  AdminPromotionError,
  auditTranscripts,
  gatherMaintenanceHealth,
  inspectScope,
  listAdminNamespaces,
  promoteMemory,
  REDACTED,
  redactSensitive,
  type PromotionStorageProvider,
} from "./admin-surfaces.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal namespace-enabled config for admin-surface tests. */
function makeConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    ...overrides,
  });
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remnic-admin-test-"));
}

// ---------------------------------------------------------------------------
// redactSensitive
// ---------------------------------------------------------------------------

test("redactSensitive redacts bearer-token-shaped values and sensitive keys", () => {
  const redacted = redactSensitive({
    namespace: "default",
    authToken: "sk-live-abc123",
    nested: {
      bearer: "Bearer xyz",
      safe: "keep me",
      password: "hunter2",
    },
    array: ["bearer sk-secret", "normal value"],
    identityToken: "abcdef0123456789", // 16-hex — NOT redacted (storage token)
  });
  assert.equal(redacted.namespace, "default");
  assert.equal((redacted as Record<string, unknown>).authToken, REDACTED);
  assert.equal(
    ((redacted as Record<string, unknown>).nested as Record<string, unknown>).bearer,
    REDACTED,
  );
  assert.equal(
    ((redacted as Record<string, unknown>).nested as Record<string, unknown>).safe,
    "keep me",
  );
  assert.equal(
    ((redacted as Record<string, unknown>).nested as Record<string, unknown>).password,
    REDACTED,
  );
  // The 16-hex identity token must survive (it's a routing token, not a credential).
  assert.equal((redacted as Record<string, unknown>).identityToken, "abcdef0123456789");
});

test("redactSensitive leaves primitives untouched", () => {
  assert.equal(redactSensitive("plain"), "plain");
  assert.equal(redactSensitive(42), 42);
  assert.equal(redactSensitive(true), true);
  assert.equal(redactSensitive(null), null);
});

// ---------------------------------------------------------------------------
// inspectScope — single-user (namespaces disabled)
// ---------------------------------------------------------------------------

test("inspectScope returns a self-layer plan in single-user mode", () => {
  const config = parseConfig({ namespacesEnabled: false });
  const inspection = inspectScope({ config, sessionKey: "agent:bot:discord:channel:1" });
  assert.equal(inspection.principal, "default");
  assert.equal(inspection.scopeProfileId, null);
  assert.equal(inspection.codingOverlay, null);
  assert.ok(inspection.readNamespaces.length >= 1);
  assert.equal(inspection.writeNamespace, config.defaultNamespace);
  const selfLayer = inspection.layers.find((layer) => layer.id === "self");
  assert.ok(selfLayer, "a self layer must be present in single-user mode");
  assert.equal(selfLayer?.namespace, config.defaultNamespace);
});

// ---------------------------------------------------------------------------
// inspectScope — namespace-aware: principal derived from session key
// ---------------------------------------------------------------------------

test("inspectScope resolves a principal-scoped write namespace when namespaces are enabled", () => {
  const config = makeConfig({
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "alice:", principal: "alice" }],
    namespacePolicies: [{ name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
  });
  const inspection = inspectScope({ config, sessionKey: "alice:bot:discord:1" });
  assert.equal(inspection.principal, "alice");
  assert.equal(inspection.writeNamespace, "alice");
  assert.ok(
    inspection.readNamespaces.includes("alice"),
    "read namespaces must include the principal self namespace",
  );
  // The plan field MUST be present so the "same plan as runtime resolver"
  // acceptance test holds — the dashboard displays this verbatim.
  assert.ok(inspection.plan, "plan must be present");
  assert.equal(inspection.plan.baseNamespace, inspection.writeNamespace);
});

test("inspectScope surfaces a warning when namespaces are enabled but no principal resolves", () => {
  const config = makeConfig();
  const inspection = inspectScope({ config, sessionKey: undefined });
  assert.ok(
    inspection.warnings.some((w) => w.includes("no principal resolved")),
    "expected a no-principal warning",
  );
});

test("inspectScope flags an ignored namespace override that is not readable", () => {
  const config = makeConfig({
    namespacePolicies: [
      { name: "protected", readPrincipals: ["bob"], writePrincipals: ["bob"] },
    ],
  });
  const inspection = inspectScope({
    config,
    sessionKey: "alice:bot:x:1",
    namespace: "protected",
  });
  // The override is not readable by alice → warning + plan falls through.
  assert.equal(inspection.namespaceOverride, undefined);
  assert.ok(
    inspection.warnings.some((w) => w.includes("not readable")),
    "expected an ignored-override warning",
  );
});

// ---------------------------------------------------------------------------
// listAdminNamespaces
// ---------------------------------------------------------------------------

test("listAdminNamespaces returns disabled payload when the catalog is off", async () => {
  const config = parseConfig({ namespacesEnabled: false });
  const catalog = new NamespaceCatalog(config);
  const result = await listAdminNamespaces({ catalog });
  assert.equal(result.enabled, false);
  assert.equal(result.entries.length, 0);
});

test("listAdminNamespaces lists configured + discovered namespaces and marks stale entries", async () => {
  const memoryDir = await makeTempDir();
  try {
    const config = makeConfig({ memoryDir });
    const catalog = new NamespaceCatalog(config);
    await catalog.registerConfiguredNamespaces();
    const result = await listAdminNamespaces({ catalog, staleThresholdDays: 0 });
    assert.equal(result.enabled, true);
    // default + shared should both be present.
    const names = result.entries.map((entry) => entry.namespace);
    assert.ok(names.includes("default"), "default namespace must be listed");
    assert.ok(names.includes("shared"), "shared namespace must be listed");
    // staleThresholdDays: 0 → every entry written > 0 days ago is stale.
    // freshly-registered namespaces have no lastWriteAt, so they are stale.
    assert.ok(result.entries.every((entry) => entry.stale), "fresh entries should be stale");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("listAdminNamespaces filters by principal", async () => {
  const memoryDir = await makeTempDir();
  try {
    const config = makeConfig({
      memoryDir,
      namespacePolicies: [
        { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
        { name: "bob", readPrincipals: ["bob"], writePrincipals: ["bob"] },
      ],
    });
    const catalog = new NamespaceCatalog(config);
    await catalog.registerConfiguredNamespaces();
    const result = await listAdminNamespaces({ catalog, filter: { principal: "alice" } });
    assert.ok(result.entries.every((entry) => entry.principal === "alice"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gatherMaintenanceHealth
// ---------------------------------------------------------------------------

test("gatherMaintenanceHealth reports degraded mode when QMD probe fails", async () => {
  const memoryDir = await makeTempDir();
  try {
    const config = makeConfig({ memoryDir });
    const catalog = new NamespaceCatalog(config);
    await catalog.registerConfiguredNamespaces();
    const report = await gatherMaintenanceHealth({
      catalog,
      qmdHealthProvider: async () => {
        throw new Error("qmd unreachable");
      },
    });
    assert.equal(report.enabled, true);
    assert.equal(report.degradedMode, true);
    assert.ok(
      report.perNamespace.some((entry) => entry.qmdDegraded && entry.qmdError?.includes("unreachable")),
      "the failing namespace must be flagged degraded with the error message",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("gatherMaintenanceHealth reports healthy when QMD probe returns available", async () => {
  const memoryDir = await makeTempDir();
  try {
    const config = makeConfig({ memoryDir });
    const catalog = new NamespaceCatalog(config);
    await catalog.registerConfiguredNamespaces();
    const report = await gatherMaintenanceHealth({
      catalog,
      qmdHealthProvider: async (namespace) => ({
        namespace,
        collection: `col-${namespace}`,
        available: true,
        collectionState: "present",
        debugStatus: "ok",
        installedVersion: "1.0.0",
        supportedVersion: "1.0.0",
        supported: true,
        upgradeAvailable: false,
        daemonMode: false,
      }),
    });
    assert.equal(report.degradedMode, false);
    assert.ok(report.perNamespace.every((entry) => !entry.qmdDegraded));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// auditTranscripts
// ---------------------------------------------------------------------------

test("auditTranscripts detects mixed other/default data and stays dry-run", async () => {
  const memoryDir = await makeTempDir();
  try {
    // Seed a shared other/default file holding two distinct sessions.
    const transcriptsDir = path.join(memoryDir, "transcripts", "other", "default");
    await mkdir(transcriptsDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(
      path.join(transcriptsDir, `${today}.jsonl`),
      [
        JSON.stringify({ sessionKey: "pi-geek:abc", entry: "hello from abc", role: "user" }),
        JSON.stringify({ sessionKey: "pi-geek:def", entry: "hello from def", role: "user" }),
      ].join("\n") + "\n",
    );
    const report = await auditTranscripts(memoryDir);
    assert.equal(report.dryRun, true);
    assert.equal(report.mixedOtherDefault, true);
    assert.equal(report.distinctSessions, 2);
    assert.equal(report.movedEntries, 2);
    assert.ok(report.summary.includes("2 distinct sessions"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auditTranscripts reports clean when no legacy data exists", async () => {
  const memoryDir = await makeTempDir();
  try {
    const report = await auditTranscripts(memoryDir);
    assert.equal(report.mixedOtherDefault, false);
    assert.equal(report.distinctSessions, 0);
    assert.equal(report.movedEntries, 0);
    assert.ok(report.summary.includes("nothing to migrate"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// promoteMemory — reason + authorization enforcement
// ---------------------------------------------------------------------------

/** In-memory storage provider for promotion tests. */
function makeMemoryStorageProvider(): PromotionStorageProvider & {
  written: Array<{ namespace: string; memoryId: string; tags: string[]; lineage: string[] }>;
} {
  const written: Array<{ namespace: string; memoryId: string; tags: string[]; lineage: string[] }> = [];
  let counter = 0;
  return {
    written,
    readMemory: async () => ({
      category: "fact" as const,
      content: "the sky is blue",
      frontmatter: { confidence: 0.9, tags: ["test"] } as never,
    }),
    writePromotedMemory: async (namespace, memory) => {
      counter += 1;
      const memoryId = `promoted-${counter}`;
      written.push({
        namespace,
        memoryId,
        tags: memory.tags,
        lineage: memory.lineage ?? [],
      });
      return memoryId;
    },
  };
}

test("promoteMemory rejects an empty reason", async () => {
  const config = makeConfig();
  const storage = makeMemoryStorageProvider();
  await assert.rejects(
    () =>
      promoteMemory({
        config,
        sourceMemoryId: "mem-1",
        sourceNamespace: "default",
        targets: [{ kind: "explicit", namespace: "shared" }],
        reason: "   ",
        actor: "operator",
        storage,
      }),
    (err: unknown) => err instanceof AdminPromotionError && err.code === "reason_required",
  );
});

test("promoteMemory rejects when no targets are supplied", async () => {
  const config = makeConfig();
  const storage = makeMemoryStorageProvider();
  await assert.rejects(
    () =>
      promoteMemory({
        config,
        sourceMemoryId: "mem-1",
        sourceNamespace: "default",
        targets: [],
        reason: "ok reason",
        actor: "operator",
        storage,
      }),
    (err: unknown) => err instanceof AdminPromotionError && err.code === "targets_required",
  );
});

test("promoteMemory writes into an explicit writable target namespace and records audit lineage", async () => {
  const config = makeConfig({
    namespacePolicies: [
      { name: "shared", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
  });
  const storage = makeMemoryStorageProvider();
  const result = await promoteMemory({
    config,
    sourceMemoryId: "mem-1",
    sourceNamespace: "default",
    principal: "alice",
    targets: [{ kind: "explicit", namespace: "shared" }],
    reason: "promote for team visibility",
    actor: "alice",
    storage,
  });
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0]?.promoted, true);
  assert.equal(result.targets[0]?.namespace, "shared");
  assert.equal(result.audit.reason, "promote for team visibility");
  assert.equal(result.audit.targets.length, 1);
  assert.equal(result.audit.targets[0]?.promoted, true);
  assert.equal(storage.written.length, 1);
  assert.equal(storage.written[0]?.namespace, "shared");
  assert.ok(storage.written[0]?.tags.includes("admin-promotion-explicit"));
  assert.deepEqual(storage.written[0]?.lineage, ["mem-1"]);
});

test("promoteMemory refuses an explicit target the principal cannot write", async () => {
  const config = makeConfig({
    namespacePolicies: [
      { name: "protected", readPrincipals: ["bob"], writePrincipals: ["bob"] },
    ],
  });
  const storage = makeMemoryStorageProvider();
  const result = await promoteMemory({
    config,
    sourceMemoryId: "mem-1",
    sourceNamespace: "default",
    principal: "alice",
    targets: [{ kind: "explicit", namespace: "protected" }],
    reason: "attempt unauthorized promotion",
    actor: "alice",
    storage,
  });
  assert.equal(result.ok, false);
  assert.equal(result.targets[0]?.authorized, false);
  assert.equal(result.targets[0]?.promoted, false);
  assert.equal(storage.written.length, 0);
});

test("promoteMemory throws source_not_found when the source memory is absent", async () => {
  const config = makeConfig();
  const storage: PromotionStorageProvider = {
    readMemory: async () => null,
    writePromotedMemory: async () => "unused",
  };
  await assert.rejects(
    () =>
      promoteMemory({
        config,
        sourceMemoryId: "missing",
        sourceNamespace: "default",
        targets: [{ kind: "explicit", namespace: "shared" }],
        reason: "ok",
        actor: "alice",
        storage,
      }),
    (err: unknown) => err instanceof AdminPromotionError && err.code === "source_not_found",
  );
});
