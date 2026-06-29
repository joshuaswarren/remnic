import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginConfig } from "../types.js";
import { namespaceIdentityToken } from "./identity.js";
import { NamespaceCatalog } from "./catalog.js";
import { NamespaceStorageRouter } from "./storage.js";

function makeConfig(memoryDir: string, overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    memoryDir,
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    qmdCollection: "remnic",
    entitySchemas: {},
    inlineSourceAttributionFormat: undefined,
    ...overrides,
  } as unknown as PluginConfig;
}

async function mkMemoryDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "remnic-ns-catalog-"));
}

test("markWrite registers a dynamic project namespace in the catalog", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });

    const record = await catalog.getNamespaceRecord("project-origin-abc123");
    assert.ok(record, "expected record to exist");
    assert.equal(record?.namespace, "project-origin-abc123");
    assert.equal(record?.kind, "project");
    assert.ok(record?.lastWriteAt, "expected lastWriteAt to be set");
    assert.equal(record?.discoveredBy, "write");
    assert.ok(record?.storageDir.includes("namespaces"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("configured default and shared namespaces appear in the catalog after register", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.registerConfiguredNamespaces();

    const list = await catalog.listNamespaces();
    assert.ok(list.some((r) => r.namespace === "default" && r.kind === "default"));
    assert.ok(list.some((r) => r.namespace === "shared" && r.kind === "shared"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildFromDisk finds existing tokenized namespace directories", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "team-pi-project-origin-abc123";
    await mkdir(path.join(memoryDir, "namespaces", namespaceIdentityToken(ns), "facts"), {
      recursive: true,
    });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();

    assert.equal(result.dryRun, false);
    assert.ok(result.records.some((r) => r.namespace === ns));
    const fromDisk = result.records.find((r) => r.namespace === ns);
    assert.equal(fromDisk?.kind, "team-project");
    assert.equal(fromDisk?.discoveredBy, "scan");

    // Persisted: a fresh catalog reads it back.
    const reloaded = new NamespaceCatalog(makeConfig(memoryDir));
    const record = await reloaded.getNamespaceRecord(ns);
    assert.ok(record, "expected rebuilt record to persist");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildFromDisk dry-run does not write the catalog file", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await mkdir(path.join(memoryDir, "namespaces", namespaceIdentityToken("alpha"), "facts"), {
      recursive: true,
    });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk({ dryRun: true });
    assert.equal(result.dryRun, true);
    assert.ok(result.records.some((r) => r.namespace === "alpha"));

    const catalogFile = path.join(memoryDir, "state", "namespaces.jsonl");
    let exists = true;
    try {
      await readFile(catalogFile, "utf8");
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "dry-run must not write the catalog file");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildFromDisk preserves the legacy default root (memoryDir) compatibility case", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    // Legacy layout: facts live directly in memoryDir, no namespaces/ subdir.
    await mkdir(path.join(memoryDir, "facts"), { recursive: true });
    await writeFile(path.join(memoryDir, "facts", "f1.md"), "# synthetic\n", "utf8");
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();

    const def = result.records.find((r) => r.namespace === "default");
    assert.ok(def, "expected default namespace record");
    assert.equal(def?.kind, "default");
    // Legacy default root resolves to memoryDir itself, not a tokenized dir.
    assert.equal(def?.storageDir, memoryDir);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildFromDisk reports symlinked namespace roots instead of trusting them", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    await mkdir(path.join(outside, "secret"), { recursive: true });
    const linkPath = path.join(memoryDir, "namespaces", namespaceIdentityToken("evil"));
    try {
      await symlink(outside, linkPath, "dir");
    } catch {
      // Some CI environments disallow symlinks; skip gracefully.
      return;
    }

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      result.skipped.some((s) => s.reason === "symlink"),
      "expected symlinked root to be reported as skipped",
    );
    assert.ok(
      !result.records.some((r) => r.storageDir.startsWith(outside)),
      "must not catalog a root that escapes memoryDir",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("unsafe namespace tokens are rejected by mark APIs", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await assert.rejects(() => catalog.markWrite("../escape"));
    await assert.rejects(() => catalog.markRead("a/b"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("markRead/markWrite/markMaintenance update only metadata, never content", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    // Place a synthetic memory file we can assert is untouched.
    const factDir = path.join(memoryDir, "namespaces", namespaceIdentityToken("alpha"), "facts");
    await mkdir(factDir, { recursive: true });
    const factPath = path.join(factDir, "f1.md");
    await writeFile(factPath, "# synthetic fact\nbody\n", "utf8");
    const before = await readFile(factPath, "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markRead("alpha");
    await catalog.markWrite("alpha");
    await catalog.markMaintenance("alpha", "dreams");

    const after = await readFile(factPath, "utf8");
    assert.equal(after, before, "memory content must not be modified by catalog touches");

    const record = await catalog.getNamespaceRecord("alpha");
    assert.ok(record?.lastReadAt);
    assert.ok(record?.lastWriteAt);
    assert.ok(record?.lastMaintenanceAt?.dreams);

    // Catalog file must contain only metadata, never the fact body.
    const raw = await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8");
    assert.ok(!raw.includes("synthetic fact"));
    assert.ok(!raw.includes("body"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildFromDisk is idempotent", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await mkdir(path.join(memoryDir, "namespaces", namespaceIdentityToken("alpha"), "facts"), {
      recursive: true,
    });
    await mkdir(path.join(memoryDir, "namespaces", namespaceIdentityToken("beta"), "entities"), {
      recursive: true,
    });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const first = await catalog.rebuildFromDisk();
    const firstRaw = await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8");

    const catalog2 = new NamespaceCatalog(makeConfig(memoryDir));
    const second = await catalog2.rebuildFromDisk();
    const secondRaw = await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8");

    const names = (recs: { namespace: string }[]) => recs.map((r) => r.namespace).sort();
    assert.deepEqual(names(first.records), names(second.records));
    assert.equal(firstRaw, secondRaw, "rebuild output must be byte-identical when run twice");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("catalog records can be consumed by a fake maintenance scheduler", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123");
    await catalog.markWrite("shared");

    // Fake scheduler: fan out a job over all catalog namespaces and record it.
    const records = await catalog.listNamespaces();
    const jobName = "compaction";
    for (const r of records) {
      await catalog.markMaintenance(r.namespace, jobName);
    }

    const after = await catalog.listNamespaces();
    assert.ok(after.length >= 2);
    for (const r of after) {
      assert.ok(r.lastMaintenanceAt?.[jobName], `expected ${r.namespace} to have maintenance ts`);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("listNamespaces supports filtering by kind and discoveredBy", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.registerConfiguredNamespaces();
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });

    const projects = await catalog.listNamespaces({ kind: "project" });
    assert.ok(projects.every((r) => r.kind === "project"));
    assert.ok(projects.some((r) => r.namespace === "project-origin-abc123"));

    const written = await catalog.listNamespaces({ discoveredBy: "write" });
    assert.ok(written.every((r) => r.discoveredBy === "write"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("catalog is inert (no-op) when namespaces are disabled", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir, { namespacesEnabled: false }));
    await catalog.markWrite("project-origin-abc123");
    await catalog.markRead("shared");
    await catalog.registerConfiguredNamespaces();

    const list = await catalog.listNamespaces();
    assert.deepEqual(list, [], "disabled catalog must enumerate nothing");

    // No catalog file should be created when disabled.
    let exists = true;
    try {
      await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8");
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "disabled catalog must not write to disk");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("catalog tolerates corrupt / non-object JSONL lines on read", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const file = path.join(stateDir, "namespaces.jsonl");
    // Mix of garbage, JSON null, valid record, and a valid record missing fields.
    const validToken = namespaceIdentityToken("alpha");
    const lines = [
      "not json at all",
      "null",
      "123",
      JSON.stringify({ namespace: "" }), // invalid: empty namespace
      JSON.stringify({
        namespace: "alpha",
        identityToken: validToken,
        kind: "explicit",
        createdAt: new Date().toISOString(),
        storageDir: path.join(memoryDir, "namespaces", validToken),
        discoveredBy: "write",
      }),
    ];
    await writeFile(file, lines.join("\n") + "\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const list = await catalog.listNamespaces();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.namespace, "alpha");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageRouter integration: catalog registers namespace on storageFor", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const catalog = new NamespaceCatalog(config);
    const router = new NamespaceStorageRouter(config, {
      onResolve: (namespace, storageDir) => {
        void catalog.registerResolved(namespace, storageDir);
      },
    });
    await router.storageFor("project-origin-abc123");
    // allow the fire-and-forget registration to settle
    await new Promise((r) => setTimeout(r, 10));

    const record = await catalog.getNamespaceRecord("project-origin-abc123");
    assert.ok(record, "storageFor should have registered the namespace");
    assert.equal(record?.discoveredBy, "config");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Issue 1 (cursor[bot]): the register/resolve hook must NOT clobber prior
// provenance on an existing record. A namespace first discovered via a `write`
// touch must keep discoveredBy:"write" even after later routing resolves fire
// the `config` register hook (including on router cache hits).
test("register does not overwrite prior discoveredBy on an existing record", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // First seen via a write — provenance is "write".
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const afterWrite = await catalog.getNamespaceRecord("project-origin-abc123");
    assert.equal(afterWrite?.discoveredBy, "write");
    const createdAt = afterWrite?.createdAt;

    // A later routing resolve fires the register hook with discoveredBy:"config".
    await catalog.registerResolved(
      "project-origin-abc123",
      path.join(memoryDir, "namespaces", namespaceIdentityToken("project-origin-abc123")),
    );

    const afterRegister = await catalog.getNamespaceRecord("project-origin-abc123");
    assert.equal(
      afterRegister?.discoveredBy,
      "write",
      "register must preserve prior write provenance, not reset it to config",
    );
    assert.equal(afterRegister?.createdAt, createdAt, "createdAt is creation-only and must be preserved");
    // The write touch field is still present (register does not erase it).
    assert.ok(afterRegister?.lastWriteAt, "lastWriteAt must survive the register touch");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Symmetric: a record first registered via config keeps discoveredBy:"config"
// after a routing resolve (no spurious downgrade either), and a later explicit
// write touch still updates lastWriteAt without rewriting provenance.
test("explicit discoveredBy is only applied at record creation, not on later touches", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.registerResolved(
      "project-origin-xyz",
      path.join(memoryDir, "namespaces", namespaceIdentityToken("project-origin-xyz")),
    );
    assert.equal((await catalog.getNamespaceRecord("project-origin-xyz"))?.discoveredBy, "config");

    // A later write touch carries discoveredBy:"write" but must NOT relabel the
    // already-discovered record.
    await catalog.markWrite("project-origin-xyz", { discoveredBy: "write" });
    const after = await catalog.getNamespaceRecord("project-origin-xyz");
    assert.equal(after?.discoveredBy, "config", "existing provenance is preserved");
    assert.ok(after?.lastWriteAt, "write touch still records lastWriteAt");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Issue 4 (codex P2): concurrent fire-and-forget touches for the same
// namespace must each read the latest record inside the serialized chain and
// merge their fields — none may be dropped by a racing append winning
// compaction. Fire many touches without awaiting between them, then assert the
// final compacted record retains read + write + maintenance + register fields.
test("concurrent touches on one namespace preserve all fields (no dropped metadata)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken("project-origin-race"));

    // Kick off near-simultaneous touches of every kind; do NOT await between
    // them so the read-modify-append sections must serialize correctly.
    await Promise.all([
      catalog.markRead("project-origin-race", { discoveredBy: "read" }),
      catalog.markWrite("project-origin-race", { discoveredBy: "write" }),
      catalog.markMaintenance("project-origin-race", "dreams"),
      catalog.registerResolved("project-origin-race", storageDir),
      catalog.markMaintenance("project-origin-race", "compaction"),
    ]);

    const record = await catalog.getNamespaceRecord("project-origin-race");
    assert.ok(record, "expected a record after concurrent touches");
    assert.ok(record?.lastReadAt, "lastReadAt must survive concurrent touches");
    assert.ok(record?.lastWriteAt, "lastWriteAt must survive concurrent touches");
    assert.ok(record?.lastMaintenanceAt?.dreams, "dreams maintenance ts must survive");
    assert.ok(record?.lastMaintenanceAt?.compaction, "compaction maintenance ts must survive");
    // Exactly one logical namespace record after compaction.
    const list = await catalog.listNamespaces();
    assert.equal(
      list.filter((r) => r.namespace === "project-origin-race").length,
      1,
      "compaction must fold concurrent appends into a single record",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Tighter race: a register firing concurrently with read+write must not drop
// the write's lastWriteAt or the read's lastReadAt (the exact scenario the
// codex thread called out — the router hook is fire-and-forget alongside the
// hot-path read/write touches). Run several rounds on distinct namespaces so
// the assertion does not depend on one lucky scheduling.
test("concurrent register + markWrite + markRead never drops touch fields", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    for (let i = 0; i < 25; i++) {
      const ns = `project-origin-rw-${i}`;
      const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
      await Promise.all([
        catalog.registerResolved(ns, storageDir),
        catalog.markWrite(ns, { discoveredBy: "write" }),
        catalog.markRead(ns, { discoveredBy: "read" }),
      ]);
      const record = await catalog.getNamespaceRecord(ns);
      assert.ok(record?.lastWriteAt, `round ${i}: write must survive a racing register/read`);
      assert.ok(record?.lastReadAt, `round ${i}: read must survive a racing register/write`);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Issue 3 (cursor + codex): a string "false"/"0" opt-out from CLI/env/JSON
// must keep the catalog inert (no jsonl writes), matching the boolean opt-out.
// parseConfig is what coerces these strings; assert the catalog honors the
// resulting flag end to end by feeding it a config whose flag is the coerced
// boolean.
test("catalog is inert when namespaceCatalogEnabled is false (string opt-out coerced)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    // Simulate the post-parseConfig state for `namespaceCatalogEnabled: "false"`
    // / "0": the coerced boolean is false, so the catalog must do nothing.
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, { namespaceCatalogEnabled: false }),
    );
    assert.equal(catalog.enabled, false, "catalog must report disabled");
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    await catalog.markRead("shared");
    await catalog.registerConfiguredNamespaces();

    assert.deepEqual(await catalog.listNamespaces(), [], "disabled catalog enumerates nothing");
    let exists = true;
    try {
      await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8");
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "opted-out catalog must not write the jsonl file");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Issue 2 (cursor[bot]): the chunked extraction path writes the parent memory
// then `continue`s past the non-chunked write, so it must record its OWN write
// touch. This asserts the catalog contract the orchestrator's chunked branch now
// relies on: a markWrite (as fired by the chunked path) updates lastWriteAt for
// the target namespace exactly like the non-chunked path.
test("chunked write path contract: markWrite updates lastWriteAt for the namespace", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const ns = "project-origin-chunked";
    const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    // This is exactly the call the orchestrator chunked branch now makes
    // (markCatalogWrite -> markWrite with discoveredBy "write" + storageDir).
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record?.lastWriteAt, "chunked write must update lastWriteAt");
    assert.equal(record?.storageDir, storageDir);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
