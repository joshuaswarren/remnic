import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginConfig } from "../types.js";
import { namespaceIdentityToken } from "./identity.js";
import { NamespaceCatalog } from "./catalog.js";
import { NamespaceStorageRouter, resolveDefaultNamespaceRoot } from "./storage.js";

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

// ── Round 2, Issue A (cursor High + codex P2): a hot-path touch that lands
// while `rebuildFromDisk --apply` is running must NOT be discarded by the
// atomic rewrite. Round 1 snapshotted catalog state OUTSIDE the write chain and
// then rewrote from that snapshot, so a touch appended after the snapshot but
// before the rewrite was lost. Now the entire scan → load → rewrite runs inside
// ONE serialized critical section, so a concurrent markWrite either lands before
// the rebuild's in-chain load (folded into the rewrite) or after the rewrite
// (its own later critical turn re-reads the rewritten file and re-appends). Run
// many rounds so the assertion never depends on one lucky scheduling.
test("rebuildFromDisk --apply does not drop a concurrent markWrite touch", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    for (let i = 0; i < 30; i++) {
      const ns = `project-origin-rebuild-race-${i}`;
      const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
      // Give the namespace on-disk data so rebuild discovers it as a scan record
      // (with no lastWriteAt). The racing markWrite is what supplies lastWriteAt.
      await mkdir(path.join(storageDir, "facts"), { recursive: true });

      // Fire rebuild and a write touch concurrently without awaiting between.
      await Promise.all([
        catalog.rebuildFromDisk(),
        catalog.markWrite(ns, { discoveredBy: "write", storageDir }),
      ]);

      const record = await catalog.getNamespaceRecord(ns);
      assert.ok(
        record,
        `round ${i}: namespace must exist after concurrent rebuild + write`,
      );
      assert.ok(
        record?.lastWriteAt,
        `round ${i}: a markWrite racing rebuildFromDisk --apply must not be dropped`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Companion: markRead and registerResolved touches racing a rebuild are also
// preserved (the lost-touch class covers all touch kinds, not just write).
test("rebuildFromDisk --apply preserves concurrent markRead / registerResolved touches", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    for (let i = 0; i < 20; i++) {
      const ns = `project-origin-rebuild-rr-${i}`;
      const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
      await mkdir(path.join(storageDir, "facts"), { recursive: true });
      await Promise.all([
        catalog.rebuildFromDisk(),
        catalog.markRead(ns, { discoveredBy: "read" }),
        catalog.registerResolved(ns, storageDir),
      ]);
      const record = await catalog.getNamespaceRecord(ns);
      assert.ok(record, `round ${i}: namespace must survive concurrent rebuild`);
      assert.ok(
        record?.lastReadAt,
        `round ${i}: a markRead racing rebuildFromDisk must not be dropped`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// `--dry-run` must remain non-mutating even though it now takes the critical
// section for a consistent read.
test("rebuildFromDisk dry-run takes the critical section but writes nothing", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await mkdir(path.join(memoryDir, "namespaces", namespaceIdentityToken("gamma"), "facts"), {
      recursive: true,
    });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk({ dryRun: true });
    assert.equal(result.dryRun, true);
    assert.ok(result.records.some((r) => r.namespace === "gamma"));
    let exists = true;
    try {
      await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8");
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "dry-run must not write the catalog file");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 2, Issue C (codex P2): the rebuilt default record's storageDir must
// match the runtime router's `defaultNamespaceRoot`. While legacy default data
// lives directly under memoryDir, the router keeps the default root at
// memoryDir even if a tokenized `namespaces/<default-token>` dir also exists.
// Rebuild must NOT overwrite the default record with the tokenized path, or
// maintenance/QMD would read a different default root than live reads.
test("rebuildFromDisk keeps default storageDir aligned with the router (legacy data present)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    // Legacy default data lives directly under memoryDir.
    await mkdir(path.join(memoryDir, "facts"), { recursive: true });
    await writeFile(path.join(memoryDir, "facts", "legacy.md"), "# legacy\n", "utf8");
    // AND a tokenized default dir also exists with data — the divergent case.
    const tokenizedDefaultDir = path.join(
      memoryDir,
      "namespaces",
      namespaceIdentityToken(config.defaultNamespace),
    );
    await mkdir(path.join(tokenizedDefaultDir, "facts"), { recursive: true });
    await writeFile(path.join(tokenizedDefaultDir, "facts", "tok.md"), "# tok\n", "utf8");

    // Resolve what the runtime router would use for the default root.
    const routerRoot = await resolveDefaultNamespaceRoot(config);
    assert.equal(
      routerRoot,
      memoryDir,
      "router keeps default root at memoryDir while legacy data exists",
    );

    const catalog = new NamespaceCatalog(config);
    const result = await catalog.rebuildFromDisk();
    const def = result.records.find((r) => r.namespace === config.defaultNamespace);
    assert.ok(def, "expected a default namespace record");
    assert.equal(def?.kind, "default");
    assert.equal(
      def?.storageDir,
      routerRoot,
      "rebuilt default storageDir must equal the router's defaultNamespaceRoot, not the tokenized path",
    );
    assert.notEqual(
      def?.storageDir,
      tokenizedDefaultDir,
      "rebuild must not point the default record at the tokenized dir while legacy data exists",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 3, Issue #1 (cursor Medium): rebuild must NOT skip a tokenized
// namespace root that only holds a `state/` dir — the router counts the `state`
// runtime child (includeRuntimeState) when deciding a root has storage, so a
// namespace the router actively resolves would otherwise vanish from the
// rebuilt catalog after --apply.
test("rebuildFromDisk catalogs a tokenized root that only has a state dir", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-stateonly";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    // Only a runtime `state/` child — no content category dirs.
    await mkdir(path.join(tokenDir, "state"), { recursive: true });

    const config = makeConfig(memoryDir);
    // The router treats this root as present (runtime state counts as a marker).
    const router = new NamespaceStorageRouter(config);
    const sm = await router.storageFor(ns);
    assert.equal(sm.dir, tokenDir, "router resolves the state-only tokenized root");

    const catalog = new NamespaceCatalog(config);
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      result.records.some((r) => r.namespace === ns),
      "rebuild must catalog a state-only root the router resolves",
    );
    assert.ok(
      !result.skipped.some((s) => s.token === namespaceIdentityToken(ns)),
      "state-only root must not be reported as skipped",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 3, Issue #2 (cursor Low): rebuild must preserve creation-only
// provenance. A configured/policy namespace first DISCOVERED via a write touch
// keeps discoveredBy:"write" after rebuild — rebuild must not reset it to
// "config" just because it is listed in policies. Mirrors the touch-path
// creation-only invariant.
test("rebuildFromDisk preserves prior write provenance for a configured namespace", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "explicit-policy-ns";
    const config = makeConfig(memoryDir, {
      namespacePolicies: [{ name: ns } as any],
    });
    const catalog = new NamespaceCatalog(config);

    // First seen via a write — provenance is "write", with on-disk data so the
    // scan branch also discovers it.
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
    assert.equal(
      (await catalog.getNamespaceRecord(ns))?.discoveredBy,
      "write",
      "precondition: namespace discovered via write",
    );

    await catalog.rebuildFromDisk();

    const after = await catalog.getNamespaceRecord(ns);
    assert.equal(
      after?.discoveredBy,
      "write",
      "rebuild must preserve prior write provenance, not reset configured ns to config",
    );
    assert.ok(after?.lastWriteAt, "rebuild must preserve the lastWriteAt touch field");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 4, Issue #4 (codex P2): an explicit metadata.storageDir from a
// markWrite/registerResolved caller must be containment-checked before it is
// persisted. An out-of-memoryDir path must NOT end up as the namespace's
// catalog storageDir; the catalog falls back to the trusted resolved dir.
test("explicit storageDir outside memoryDir is rejected (containment)", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const ns = "project-origin-escape";
    const evilDir = path.join(outside, "evil");

    // A bad hook passes an arbitrary path outside memoryDir.
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: evilDir });

    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record should still be created");
    assert.ok(
      !record!.storageDir.startsWith(outside),
      "catalog must not persist a storage dir outside memoryDir",
    );
    // Falls back to the trusted tokenized root under <memoryDir>/namespaces.
    assert.equal(
      record!.storageDir,
      path.join(memoryDir, "namespaces", namespaceIdentityToken(ns)),
      "rejected explicit dir must fall back to the resolved namespaces/<token> root",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// A legitimate explicit storageDir contained under <memoryDir>/namespaces (the
// router's resolved dir, incl. a legacy raw-name dir) is accepted verbatim.
test("explicit storageDir contained under namespaces/ is accepted", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const ns = "project-origin-ok";
    // A legacy raw-name dir under namespaces/ (what the router may resolve to).
    const legacyDir = path.join(memoryDir, "namespaces", ns);
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: legacyDir });
    const record = await catalog.getNamespaceRecord(ns);
    assert.equal(
      record?.storageDir,
      legacyDir,
      "a contained explicit dir must be persisted as-is",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
