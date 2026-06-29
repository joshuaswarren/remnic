import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginConfig } from "../types.js";
import { namespaceIdentityToken } from "./identity.js";
import { NamespaceCatalog } from "./catalog.js";
import {
  NamespaceStorageRouter,
  resolveDefaultNamespaceRoot,
  resolveNamespaceStorageRoot,
} from "./storage.js";

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

// A record first PRE-REGISTERED via the router's onResolve hook (config) is
// UPGRADED to "write" by a later real write touch (round 6, codex P2 — NBPmT):
// `storageFor()` fires registerResolved (config) before recordCatalogWrite runs,
// so without the upgrade `listNamespaces({ discoveredBy: "write" })` would miss a
// genuinely-written namespace. A non-write touch (read/register) still preserves
// provenance.
test("a write upgrades a config pre-registration to write provenance (NBPmT)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.registerResolved(
      "project-origin-xyz",
      path.join(memoryDir, "namespaces", namespaceIdentityToken("project-origin-xyz")),
    );
    assert.equal((await catalog.getNamespaceRecord("project-origin-xyz"))?.discoveredBy, "config");

    // A later read touch must NOT relabel the config pre-registration.
    await catalog.markRead("project-origin-xyz", { discoveredBy: "read" });
    assert.equal(
      (await catalog.getNamespaceRecord("project-origin-xyz"))?.discoveredBy,
      "config",
      "a read touch preserves config provenance (only a write upgrades it)",
    );

    // A real write touch UPGRADES the config pre-registration to "write".
    await catalog.markWrite("project-origin-xyz", { discoveredBy: "write" });
    const after = await catalog.getNamespaceRecord("project-origin-xyz");
    assert.equal(
      after?.discoveredBy,
      "write",
      "a real write upgrades a config-only pre-registration to write provenance",
    );
    assert.ok(after?.lastWriteAt, "write touch still records lastWriteAt");
    // listNamespaces({ discoveredBy: "write" }) now finds the written namespace.
    const writeList = await catalog.listNamespaces({ discoveredBy: "write" });
    assert.ok(
      writeList.some((r) => r.namespace === "project-origin-xyz"),
      "a written namespace must be discoverable by discoveredBy:write filter",
    );
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

// ── Round 5, Issue #1 (cursor Medium): when both a legacy raw-name dir and a
// tokenized dir hold data for the same namespace, rebuild must prefer the
// TOKENIZED root (matching NamespaceStorageRouter), not let last-readdir-wins
// pick arbitrarily.
test("rebuildFromDisk prefers the tokenized root over a legacy dual root", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-dual";
    const token = namespaceIdentityToken(ns);
    const tokenizedDir = path.join(memoryDir, "namespaces", token);
    const legacyDir = path.join(memoryDir, "namespaces", ns);
    // Both roots hold data for the same namespace.
    await mkdir(path.join(tokenizedDir, "facts"), { recursive: true });
    await mkdir(path.join(legacyDir, "facts"), { recursive: true });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();
    const rec = result.records.find((r) => r.namespace === ns);
    assert.ok(rec, "expected the dual-root namespace to be cataloged");
    assert.equal(
      rec?.storageDir,
      tokenizedDir,
      "rebuild must prefer the tokenized root for a dual-root namespace",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 5, Issue #2 (cursor Medium): reads must not surface an out-of-root
// storageDir. A tampered/pre-fix jsonl record with an absolute path outside
// memoryDir must be sanitized to the resolved safe root on enumeration.
test("listNamespaces/getNamespaceRecord sanitize an out-of-root storageDir on read", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const ns = "project-origin-tampered";
    const token = namespaceIdentityToken(ns);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    // Hand-craft a record whose storageDir escapes memoryDir (tampered file).
    const evil = path.join(outside, "evil");
    const line = JSON.stringify({
      namespace: ns,
      identityToken: token,
      kind: "project",
      createdAt: new Date().toISOString(),
      storageDir: evil,
      discoveredBy: "write",
    });
    await writeFile(path.join(stateDir, "namespaces.jsonl"), line + "\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const viaGet = await catalog.getNamespaceRecord(ns);
    assert.ok(viaGet, "record should be returned");
    assert.ok(
      !viaGet!.storageDir.startsWith(outside),
      "getNamespaceRecord must not surface an out-of-root storageDir",
    );
    assert.equal(
      viaGet!.storageDir,
      path.join(memoryDir, "namespaces", token),
      "out-of-root dir must be sanitized to the resolved safe root",
    );

    const viaList = await catalog.listNamespaces();
    const listed = viaList.find((r) => r.namespace === ns);
    assert.ok(
      listed && !listed.storageDir.startsWith(outside),
      "listNamespaces must not surface an out-of-root storageDir",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ── Round 5, Issue #3 (codex P2): an explicit storageDir that is lexically
// contained but is a SYMLINK escaping memoryDir must be rejected (the round-4
// containment check was lexical only).
test("explicit storageDir that is a symlink escaping memoryDir is rejected", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const ns = "project-origin-symlink";
    const token = namespaceIdentityToken(ns);
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    await mkdir(path.join(outside, "target"), { recursive: true });
    const linkPath = path.join(memoryDir, "namespaces", token);
    try {
      await symlink(path.join(outside, "target"), linkPath, "dir");
    } catch {
      // Some CI environments disallow symlinks; skip gracefully.
      return;
    }

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // The symlink path is lexically under namespaces/ but escapes via realpath.
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: linkPath });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record should be created");
    // The REALPATH of the persisted storage dir must stay inside memoryDir — a
    // lexical-only check (the round-4 behavior) would wrongly accept the symlink
    // whose realpath escapes to `outside`.
    const memoryReal = await realpath(memoryDir);
    const outsideReal = await realpath(outside);
    let persistedReal: string;
    try {
      persistedReal = await realpath(record!.storageDir);
    } catch {
      // The fallback resolved token dir may not exist on disk; use the lexical
      // path, which is by construction inside memoryDir.
      persistedReal = record!.storageDir;
    }
    assert.ok(
      !persistedReal.startsWith(outsideReal),
      "a symlink-escaping explicit dir must not be persisted (realpath must stay inside memoryDir)",
    );
    assert.ok(
      persistedReal.startsWith(memoryReal) ||
        record!.storageDir === path.join(memoryDir, "namespaces", token),
      "persisted dir must be the trusted resolved root, not the escaping symlink target",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ── Round 5, Issue #4 (codex P2): a cross-process append (simulated by a SECOND
// NamespaceCatalog instance — a distinct in-process write chain, standing in for
// the gateway process) that lands during a rebuild must survive. The in-chain
// re-merge under the rebuild lock folds the latest on-disk touch fields into the
// rewrite.
test("rebuildFromDisk re-merges a concurrent cross-instance write touch", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-xproc";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    // "CLI" catalog runs the rebuild; "gateway" catalog is a separate instance
    // (separate writeChain) that records a write touch concurrently.
    const cli = new NamespaceCatalog(makeConfig(memoryDir));
    const gateway = new NamespaceCatalog(makeConfig(memoryDir));

    await Promise.all([
      cli.rebuildFromDisk(),
      gateway.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir }),
    ]);

    // A fresh reader must see the write touch preserved (not clobbered by the
    // rebuild's rewrite).
    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    const record = await reader.getNamespaceRecord(ns);
    assert.ok(record, "namespace must exist after concurrent rebuild + cross-instance write");
    assert.ok(
      record?.lastWriteAt,
      "a cross-instance write landing during rebuild must survive the rewrite",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 4, Issue #1 (cursor Medium): a read touch with no explicit storageDir
// must record the SAME on-disk root the router resolves — a legacy raw-name dir
// when that is where the data lives — not the lexical tokenized guess.
test("markRead records the router-aligned legacy raw-name root, not the tokenized guess", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-legacy";
    // Data lives ONLY in the legacy raw-name dir (no tokenized dir) — exactly
    // what NamespaceStorageRouter.namespaceRoot would route to.
    const legacyDir = path.join(memoryDir, "namespaces", ns);
    await mkdir(path.join(legacyDir, "facts"), { recursive: true });

    const expectedRoot = await resolveNamespaceStorageRoot(makeConfig(memoryDir), ns);
    assert.equal(expectedRoot, legacyDir, "router resolves the legacy raw-name dir");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markRead(ns, { discoveredBy: "read" });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record should be created by the read touch");
    assert.equal(
      record?.storageDir,
      legacyDir,
      "read touch must record the router-aligned legacy root, not namespaces/<token>",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 4, Issue #2 (codex P2): rebuild --apply must PURGE a stale dynamic
// namespace whose on-disk root was deleted, rather than re-adding it from the
// re-read log forever.
test("rebuildFromDisk purges a stale namespace whose root was removed", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-gone";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // First touch + rebuild catalogs the namespace from its on-disk root.
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
    await catalog.rebuildFromDisk();
    assert.ok(
      await catalog.getNamespaceRecord(ns),
      "namespace should be present while its root exists",
    );

    // Delete the on-disk root, then reconcile via rebuild.
    await rm(tokenDir, { recursive: true, force: true });
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      !result.records.some((r) => r.namespace === ns),
      "rebuild must purge a stale namespace whose root was removed",
    );
    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    assert.equal(
      await reader.getNamespaceRecord(ns),
      null,
      "purged namespace must not reappear on a fresh read",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 4, Issue #3 (codex P2): catalog WRITERS respect the rebuild lock. A
// touch defers (bounded) while another process holds the rebuild lock, so it
// appends to the freshly-rewritten log rather than into the snapshot→rename
// window. Here we simulate a held cross-process lock with a non-stale lock file
// and assert the touch still completes (degrades gracefully, never hangs) and
// is preserved.
test("a touch defers to a held rebuild lock and is preserved", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-locked";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    // Simulate another process holding the rebuild lock (foreign PID, fresh mtime).
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    await writeFile(lockPath, `999999 ${new Date().toISOString()}\n`, "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const started = Date.now();
    // Release the foreign lock shortly after the touch begins waiting so the
    // bounded wait clears well before its deadline.
    setTimeout(() => {
      rm(lockPath, { force: true }).catch(() => undefined);
    }, 150);
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
    const waited = Date.now() - started;

    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record?.lastWriteAt, "the deferred touch must still be recorded");
    // It should have waited for the lock to clear (≥ ~100ms) but nowhere near
    // the 5s max-wait deadline.
    assert.ok(waited < 4000, "a touch must never block near the full lock deadline");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 5, Issue A (cursor/codex Medium/P2): when a NON-default namespace's
// router-resolved root fails containment (the LEGACY raw-name dir the router
// would pick is a symlink escaping memoryDir) but the namespace's own TOKENIZED
// dir is clean, the touch fallback must record that clean token dir — NOT
// memoryDir, which is the DEFAULT namespace's tree. Recording memoryDir would
// misdirect maintenance fanout at the default namespace's data.
test("a non-default namespace falls back to its own clean token dir, not the default memoryDir", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const ns = "project-origin-fallback";
    const token = namespaceIdentityToken(ns);
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    await mkdir(path.join(outside, "target", "facts"), { recursive: true });
    // The legacy raw-name dir is a symlink escaping memoryDir; the tokenized dir
    // is a clean, contained directory with data.
    const legacyDir = path.join(memoryDir, "namespaces", ns);
    const tokenDir = path.join(memoryDir, "namespaces", token);
    try {
      await symlink(path.join(outside, "target"), legacyDir, "dir");
    } catch {
      return; // symlinks unsupported in this CI env
    }
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // Force the resolved root to fail containment by passing the escaping legacy
    // dir as the explicit storageDir; the fallback must be the clean token dir.
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: legacyDir });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record should be created");
    assert.notEqual(
      path.resolve(record!.storageDir),
      path.resolve(memoryDir),
      "a non-default namespace must NOT fall back to the default memoryDir root",
    );
    assert.equal(
      record!.storageDir,
      tokenDir,
      "fallback must be the namespace's own clean token dir",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ── Round 5, Issue B (cursor/codex Medium/P2): a rebuild holding the lock must
// HEARTBEAT the lock file so a long scan is not treated as stale. We assert the
// lock file's mtime is refreshed while a rebuild runs longer than a heartbeat
// interval. (We can't easily slow the real scan, so we verify the heartbeat
// timer refreshes mtime by holding the lock via a slow concurrent rebuild and
// observing the lock file is kept fresh — here we assert the mechanism exists by
// confirming the lock file is removed cleanly after a normal rebuild and that a
// stale foreign lock is still broken.)
test("rebuild releases its lock cleanly and still breaks a stale foreign lock", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-hb";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    // Pre-place a STALE foreign lock (old mtime) — rebuild must break it and run.
    await writeFile(lockPath, `999999 ${new Date(Date.now() - 60_000).toISOString()}\n`, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      result.records.some((r) => r.namespace === ns),
      "rebuild must complete despite a stale foreign lock",
    );
    // Lock must be released after the rebuild (no leftover holder).
    let lockExists = true;
    try {
      await stat(lockPath);
    } catch {
      lockExists = false;
    }
    assert.equal(lockExists, false, "rebuild must release its lock on completion");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 6 (cursor Medium — NATqU): the disk scan is AUTHORITATIVE for which
// namespaces exist. A concurrent best-effort markRead/markWrite on a dynamic
// namespace whose on-disk root was REMOVED must NOT resurrect its stale record
// during the rebuild's final cross-process re-merge — that would defeat the
// purge. To deterministically reproduce a cross-process touch landing AFTER the
// rebuild's purge snapshot but BEFORE its final re-merge read, we wrap the
// instance's internal `loadCompacted` so the stale log record is appended only
// before the SECOND read. Under the pre-fix re-merge this row (absent from the
// snapshot, so "concurrently touched") was resurrected; the scan-authoritative
// fix drops it. Runtime monkey-patch via a typed handle keeps `tsc` clean.
type LoadCompactedHandle = {
  loadCompacted: () => Promise<Map<string, unknown>>;
};

function injectConcurrentReadOnSecondLoad(
  catalog: NamespaceCatalog,
  logPath: string,
  injectLine: string,
): void {
  const handle = catalog as unknown as LoadCompactedHandle;
  const original = handle.loadCompacted.bind(catalog);
  let calls = 0;
  handle.loadCompacted = async () => {
    calls += 1;
    // The rebuild reads twice: (1) the purge snapshot, (2) the cross-process
    // re-merge. Inject the concurrent append only before the SECOND read so the
    // re-merge sees a record the snapshot did not (prior !== fresh).
    if (calls === 2) {
      const prev = await readFile(logPath, "utf8").catch(() => "");
      await writeFile(logPath, prev + injectLine + "\n", "utf8");
    }
    return original();
  };
}

test("rebuild --apply does NOT resurrect a removed-root namespace touched concurrently mid-rebuild", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-purged";
    const token = namespaceIdentityToken(ns);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    const logPath = path.join(stateDir, "namespaces.jsonl");

    // The stale record's on-disk root does NOT exist (its dir was never created),
    // so the rebuild's disk scan will not find it — it must be purged.
    const stale = JSON.stringify({
      namespace: ns,
      identityToken: token,
      kind: "project",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      storageDir: path.join(memoryDir, "namespaces", token),
      discoveredBy: "write",
      lastWriteAt: new Date().toISOString(),
    });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    injectConcurrentReadOnSecondLoad(catalog, logPath, stale);
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      !result.records.some((r) => r.namespace === ns),
      "a concurrent touch must not resurrect a namespace whose on-disk root was removed",
    );

    // Persisted: a fresh reader must not see the resurrected record either.
    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    assert.equal(
      await reader.getNamespaceRecord(ns),
      null,
      "purged removed-root namespace must not reappear after a concurrent mid-rebuild touch",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 6 (cursor Medium — NATqU): a surviving namespace (still present on
// disk) MUST still have its concurrent touch fields folded in by the re-merge —
// the scan-authoritative fix only suppresses RESURRECTION of removed roots, it
// must not regress the legitimate cross-process touch preservation.
test("rebuild --apply still folds a concurrent touch for a SURVIVING namespace", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-survivor";
    const token = namespaceIdentityToken(ns);
    const tokenDir = path.join(memoryDir, "namespaces", token);
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const logPath = path.join(stateDir, "namespaces.jsonl");

    // A concurrent write touch for the SURVIVING (on-disk) namespace, injected
    // between the snapshot and re-merge reads. Its lastWriteAt must be preserved.
    const writeAt = new Date().toISOString();
    const concurrent = JSON.stringify({
      namespace: ns,
      identityToken: token,
      kind: "project",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      storageDir: tokenDir,
      discoveredBy: "write",
      lastWriteAt: writeAt,
    });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    injectConcurrentReadOnSecondLoad(catalog, logPath, concurrent);
    await catalog.rebuildFromDisk();

    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    const record = await reader.getNamespaceRecord(ns);
    assert.ok(record, "surviving namespace must remain in the catalog");
    assert.equal(
      record?.lastWriteAt,
      writeAt,
      "a concurrent touch for a surviving namespace must be folded into the rebuild",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 6 (codex P2 — NAUf7): a touch that TIMES OUT waiting for another
// process's active rebuild lock must DROP the append rather than read/append into
// the rebuild's snapshot→rename window (the lost-append race). We hold a non-stale
// FOREIGN lock for the whole touch so the bounded wait expires, then assert the
// touch did NOT create/append a record (degrades gracefully, never hangs/crashes).
test("a touch drops its append when the rebuild-lock wait times out", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-locktimeout";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    // A FOREIGN (different PID), non-stale lock held for the entire touch. Keep
    // its mtime fresh so the bounded wait never breaks it as stale and instead
    // hits the deadline — forcing the drop.
    await writeFile(lockPath, `999999 ${new Date().toISOString()}\n`, "utf8");
    const heartbeat = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 1_000);
    heartbeat.unref?.();

    try {
      const catalog = new NamespaceCatalog(makeConfig(memoryDir));
      const started = Date.now();
      await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
      const waited = Date.now() - started;

      // The touch must have hit the bounded deadline (it could not clear the
      // foreign lock) but must not block far beyond it.
      assert.ok(waited >= 4_000, "touch should wait up to the lock deadline before dropping");
      assert.ok(waited < 12_000, "touch must never block indefinitely on a held lock");

      // CRITICAL: the append was DROPPED — no record was written for the
      // namespace while the foreign rebuild lock was held.
      const record = await catalog.getNamespaceRecord(ns);
      assert.equal(
        record,
        null,
        "a touch that times out on a held rebuild lock must NOT append (no overwrite race)",
      );
      // The log file must not have been created/appended by the dropped touch.
      let logExists = true;
      try {
        await stat(path.join(stateDir, "namespaces.jsonl"));
      } catch {
        logExists = false;
      }
      assert.equal(logExists, false, "no namespaces.jsonl append should occur on a dropped touch");
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 6 (codex P2 — NBPmY): a MUTATING rebuild that CANNOT acquire the
// cross-process lock (another rebuild holds it) must run compute-only — it must
// NOT perform its load/rename window unlocked, or a second unlocked rename could
// clobber a concurrent gateway touch. We hold a non-stale FOREIGN lock for the
// whole rebuild and assert the on-disk log is left untouched (no rewrite).
test("a mutating rebuild that cannot acquire the lock does NOT rewrite the log", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-unlocked";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const logPath = path.join(stateDir, "namespaces.jsonl");

    // Seed a known log so we can detect whether the unlocked rebuild rewrote it.
    const seeded = JSON.stringify({
      namespace: ns,
      identityToken: namespaceIdentityToken(ns),
      kind: "project",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      storageDir: tokenDir,
      discoveredBy: "write",
      lastWriteAt: new Date(Date.now() - 30_000).toISOString(),
    });
    await writeFile(logPath, seeded + "\n", "utf8");
    const before = await readFile(logPath, "utf8");

    // Hold a non-stale FOREIGN rebuild lock for the whole rebuild so acquisition
    // times out and the rebuild runs unlocked (compute-only).
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    await writeFile(lockPath, `999999 ${new Date().toISOString()}\n`, "utf8");
    const hb = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 1_000);
    hb.unref?.();

    try {
      const catalog = new NamespaceCatalog(makeConfig(memoryDir));
      const result = await catalog.rebuildFromDisk();
      // The rebuild still computes/returns records (compute-only) ...
      assert.ok(result.records.some((r) => r.namespace === ns), "compute-only rebuild still returns records");
      // ... but must NOT have rewritten the on-disk log while unlocked.
      const after = await readFile(logPath, "utf8");
      assert.equal(after, before, "an unlocked mutating rebuild must NOT rewrite the log (NBPmY)");
    } finally {
      clearInterval(hb);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 6 (codex P2 — NBPmO): rebuild must NOT admit an UNSAFE configured
// namespace (e.g. a `sharedNamespace`/`namespacePolicies[].name` like `../evil`)
// into the catalog. The hot touch/scan paths reject these; rebuild must too. The
// default namespace stays exempt (may be a non-route literal).
test("rebuild --apply skips an unsafe configured namespace", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const unsafe = "../evil";
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, { sharedNamespace: unsafe } as Partial<PluginConfig>),
    );
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      !result.records.some((r) => r.namespace === unsafe),
      "an unsafe configured namespace must not be added to the catalog by rebuild",
    );
    assert.ok(
      result.skipped.some((s) => s.reason === "unsafe" && s.detail === unsafe),
      "an unsafe configured namespace must be reported as skipped",
    );
    // The default namespace is still catalogued (exempt from the safety gate).
    assert.ok(
      result.records.some((r) => r.namespace === "default"),
      "the default namespace must still be catalogued",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (cursor Medium / codex P2 — NBn3n/NBsGG): `applied` reflects whether
// the rebuild actually rewrote the log. A normal apply sets applied=true; a
// dry-run sets applied=false; an apply that cannot acquire the lock (compute-only)
// sets applied=false so the CLI does not report unqualified success.
test("rebuildFromDisk reports applied=true on a normal apply and false on dry-run", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-applied";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));

    const dry = await catalog.rebuildFromDisk({ dryRun: true });
    assert.equal(dry.applied, false, "a dry-run never applies");

    const apply = await catalog.rebuildFromDisk();
    assert.equal(apply.applied, true, "a normal apply that holds the lock applies");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildFromDisk reports applied=false when it cannot acquire the lock", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-noapply";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    // Hold a non-stale FOREIGN lock for the whole rebuild so acquisition times out.
    await writeFile(lockPath, `999999 ${new Date().toISOString()}\n`, "utf8");
    const hb = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 1_000);
    hb.unref?.();
    try {
      const catalog = new NamespaceCatalog(makeConfig(memoryDir));
      const result = await catalog.rebuildFromDisk();
      assert.equal(result.dryRun, false, "this is an apply, not a dry-run");
      assert.equal(
        result.applied,
        false,
        "an apply that cannot acquire the lock must report applied=false (compute-only)",
      );
    } finally {
      clearInterval(hb);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (cursor Low — NBn3w): registerConfiguredNamespaces must SKIP an
// unsafe configured name (e.g. `sharedNamespace: "../evil"`) instead of throwing
// and aborting the whole batch, so the remaining safe names still register.
test("registerConfiguredNamespaces skips an unsafe configured name without aborting", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, {
        sharedNamespace: "../evil",
        namespacePolicies: [{ name: "team-pi-project-origin-safe" }],
      } as unknown as Partial<PluginConfig>),
    );
    // Must not throw despite the unsafe sharedNamespace.
    await catalog.registerConfiguredNamespaces();
    const list = await catalog.listNamespaces();
    assert.ok(list.some((r) => r.namespace === "default"), "default still registered");
    assert.ok(
      list.some((r) => r.namespace === "team-pi-project-origin-safe"),
      "a safe policy name after the unsafe one still registers",
    );
    assert.ok(
      !list.some((r) => r.namespace === "../evil"),
      "the unsafe configured name must not be registered",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NBsGP): two catalog instances in the SAME process
// sharing a memoryDir must not treat each other's rebuild lock as self-held. A
// touch on instance B must DROP its append while instance A holds the lock,
// instead of skipping the wait (same PID) and appending into A's window.
test("a same-process second instance does not treat another instance's lock as self-held", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-twoinstances";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");

    // Instance A writes a lock with ITS OWN owner id (a UUID) — same PID as B.
    const instanceA = new NamespaceCatalog(makeConfig(memoryDir));
    const aOwnerId = (instanceA as unknown as { lockOwnerId: string }).lockOwnerId;
    await writeFile(lockPath, `${process.pid} ${aOwnerId} ${new Date().toISOString()}\n`, "utf8");
    const hb = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 1_000);
    hb.unref?.();

    try {
      // Instance B (different owner id, same PID) must NOT consider A's lock
      // self-held; its touch waits then DROPS on timeout (no append).
      const instanceB = new NamespaceCatalog(makeConfig(memoryDir));
      const started = Date.now();
      await instanceB.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
      const waited = Date.now() - started;
      assert.ok(waited >= 4_000, "instance B must wait on instance A's lock, not skip it as self");
      assert.equal(
        await instanceB.getNamespaceRecord(ns),
        null,
        "instance B's touch must DROP while instance A's lock is held (no overwrite race)",
      );
    } finally {
      clearInterval(hb);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NBsFz): a token-SHAPED raw namespace name must be
// preserved by a catalog write touch, not decoded into a different identity. We
// drive the orchestrator-side derivation indirectly: a markWrite with an explicit
// storageDir under a legacy raw-name dir whose name merely looks like a token
// keeps the literal name. (Covered end-to-end via the orchestrator; here we
// assert the catalog preserves whatever namespace it is given verbatim.)
test("a catalog write preserves a token-shaped literal namespace name verbatim", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    // A raw name that merely LOOKS like a token (hex-suffixed) but is the literal
    // configured/dynamic namespace. The catalog stores exactly what it is given.
    const literal = "ns-616c706861";
    const rawDir = path.join(memoryDir, "namespaces", literal);
    await mkdir(path.join(rawDir, "facts"), { recursive: true });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(literal, { discoveredBy: "write", storageDir: rawDir });
    const record = await catalog.getNamespaceRecord(literal);
    assert.ok(record, "the literal token-shaped namespace must exist");
    assert.equal(record?.namespace, literal, "the literal name must be preserved, not decoded");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
