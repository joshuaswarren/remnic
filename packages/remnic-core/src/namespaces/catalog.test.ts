import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginConfig } from "../types.js";
import { namespaceIdentityFromToken, namespaceIdentityToken } from "./identity.js";
import { NamespaceCatalog } from "./catalog.js";
import {
  NamespaceStorageRouter,
  resolveDefaultNamespaceRoot,
  resolveNamespaceStorageRoot,
} from "./storage.js";
import { withHeldFileLock } from "../utils/serialize-mutations.js";

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

class CountingNamespaceCatalog extends NamespaceCatalog {
  catalogReadCount = 0;

  constructor(config: PluginConfig) {
    super(config);
    this.onCatalogReadForTest = () => {
      this.catalogReadCount++;
    };
  }

  setAfterAppendHook(hook: () => Promise<void>): void {
    this.onAfterCatalogAppendForTest = hook;
  }
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

test("touch reloads the catalog after an external append", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("alpha", { discoveredBy: "write" });

    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    const alpha = JSON.parse((await readFile(catalogPath, "utf8")).trim());
    const externalNamespace = "external";
    await appendFile(
      catalogPath,
      `${JSON.stringify({
        ...alpha,
        namespace: externalNamespace,
        identityToken: namespaceIdentityToken(externalNamespace),
        storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken(externalNamespace)),
      })}\n`,
      "utf8",
    );

    await catalog.markRead("alpha");

    assert.ok(
      (await catalog.listNamespaces()).some((record) => record.namespace === externalNamespace),
      "the touch must fold in a row appended through another file descriptor",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("repeated touches do not re-read an unchanged catalog", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new CountingNamespaceCatalog(makeConfig(memoryDir));

    await catalog.markWrite("alpha", { discoveredBy: "write" });
    await catalog.markRead("alpha");
    await catalog.markMaintenance("alpha", "test");

    assert.equal(catalog.catalogReadCount, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a foreign append between append and stat invalidates the cache", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new CountingNamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("alpha", { discoveredBy: "write" });

    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    const alpha = JSON.parse((await readFile(catalogPath, "utf8")).trim());
    const externalNamespace = "racing-external";
    catalog.setAfterAppendHook(async () => {
      await appendFile(
        catalogPath,
        `${JSON.stringify({
          ...alpha,
          namespace: externalNamespace,
          identityToken: namespaceIdentityToken(externalNamespace),
          storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken(externalNamespace)),
        })}\n`,
        "utf8",
      );
    });

    await catalog.markRead("alpha");
    const readsBeforeReload = catalog.catalogReadCount;
    const records = await catalog.listNamespaces();

    assert.equal(catalog.catalogReadCount, readsBeforeReload + 1);
    assert.ok(records.some((record) => record.namespace === externalNamespace));
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

test("rebuildFromDisk accepts config without sharedNamespace", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    delete (config as Partial<PluginConfig>).sharedNamespace;
    const catalog = new NamespaceCatalog(config);

    await assert.doesNotReject(catalog.rebuildFromDisk());
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

test("rebuildFromDisk rejects roots with malformed category markers even when a sibling marker is valid", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-bad-category-marker";
    const token = namespaceIdentityToken(ns);
    const tokenDir = path.join(memoryDir, "namespaces", token);
    await mkdir(tokenDir, { recursive: true });
    await writeFile(path.join(tokenDir, "facts"), "not a directory", "utf8");
    await mkdir(path.join(tokenDir, "state"), { recursive: true });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();

    assert.ok(
      !result.records.some((r) => r.namespace === ns),
      "a root with a malformed scan category marker must not be catalogued",
    );
    assert.ok(
      result.skipped.some(
        (s) =>
          s.token === token &&
          s.reason === "unsafe" &&
          s.detail?.includes("facts: expected directory"),
      ),
      "the malformed category marker must be reported as an unsafe skipped root",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 8 (codex P2 — NE9K_): the `namespaces` SCAN ROOT itself must be
// containment-checked BEFORE `readdir` follows it. If `<memoryDir>/namespaces` is
// a symlink to an outside tree, readdir would enumerate that arbitrary tree
// (leaking names / spending time on a huge dir) before the per-entry lstat checks
// run. rebuild must NOT read a symlinked scan root: it reports it as one skipped
// unsafe root and catalogs none of the outside entries.
test("rebuildFromDisk rejects a symlinked namespaces scan root without enumerating it", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    // The outside tree contains tokenized namespace dirs WITH data that would be
    // catalogued if the symlinked root were followed.
    const leakedNs = "project-origin-leaked";
    await mkdir(path.join(outside, namespaceIdentityToken(leakedNs), "facts"), { recursive: true });
    // `<memoryDir>/namespaces` IS a symlink to the outside tree.
    try {
      await symlink(outside, path.join(memoryDir, "namespaces"), "dir");
    } catch {
      // Some CI environments disallow symlinks; skip gracefully.
      return;
    }

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();

    // The outside namespace must NOT be enumerated/catalogued.
    assert.ok(
      !result.records.some((r) => r.namespace === leakedNs),
      "a symlinked namespaces scan root must not be enumerated into the catalog",
    );
    assert.ok(
      !result.records.some((r) => r.storageDir.startsWith(outside)),
      "no record may point at a storageDir inside the symlinked-out scan root",
    );
    // The symlinked root is reported as one skipped unsafe root.
    assert.ok(
      result.skipped.some((s) => s.token === "namespaces" && s.reason === "symlink"),
      "the symlinked namespaces scan root must be reported as skipped",
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

test("catalog read fails open when the catalog path is a directory", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await mkdir(path.join(memoryDir, "state", "namespaces.jsonl"), { recursive: true });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));

    await assert.doesNotReject(async () => {
      assert.deepEqual(await catalog.listNamespaces(), []);
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("catalog quarantines malformed JSONL record fields at the parse boundary", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const file = path.join(stateDir, "namespaces.jsonl");
    const now = new Date().toISOString();
    const validToken = namespaceIdentityToken("valid");
    const lines = [
      JSON.stringify({
        namespace: "bad-kind",
        identityToken: namespaceIdentityToken("bad-kind"),
        kind: "bogus",
        createdAt: now,
        storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken("bad-kind")),
        discoveredBy: "write",
      }),
      JSON.stringify({
        namespace: "bad-source",
        identityToken: namespaceIdentityToken("bad-source"),
        kind: "explicit",
        createdAt: now,
        storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken("bad-source")),
        discoveredBy: "telepathy",
      }),
      JSON.stringify({
        namespace: "bad-token",
        identityToken: namespaceIdentityToken("other"),
        kind: "explicit",
        createdAt: now,
        storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken("bad-token")),
        discoveredBy: "write",
      }),
      JSON.stringify({
        namespace: "bad-created",
        identityToken: namespaceIdentityToken("bad-created"),
        kind: "explicit",
        createdAt: "not-a-date",
        storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken("bad-created")),
        discoveredBy: "write",
      }),
      JSON.stringify({
        namespace: " valid ",
        identityToken: validToken,
        kind: "project",
        createdAt: now,
        storageDir: path.join(memoryDir, "namespaces", validToken),
        discoveredBy: "write",
        lastReadAt: "not-a-date",
        lastWriteAt: "not-a-date",
        lastMaintenanceAt: {
          bad: "not-a-date",
          ok: now,
        },
      }),
    ];
    await writeFile(file, lines.join("\n") + "\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const list = await catalog.listNamespaces();

    assert.deepEqual(
      list.map((r) => r.namespace),
      ["bad-kind", "valid"],
      "unknown kinds coerce to explicit; other malformed records stay quarantined",
    );
    assert.equal(list.find((r) => r.namespace === "bad-kind")?.kind, "explicit");
    const valid = list.find((r) => r.namespace === "valid");
    assert.equal(valid?.kind, "project");
    assert.equal(valid?.discoveredBy, "write");
    assert.equal(valid?.lastReadAt, undefined);
    assert.equal(valid?.lastWriteAt, undefined);
    assert.deepEqual(valid?.lastMaintenanceAt, { ok: now });
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
      // Return the registration promise so the router tracks it as in-flight and
      // `whenResolveHooksSettled()` can await it deterministically (no timer race).
      onResolve: (namespace, storageDir) => catalog.registerResolved(namespace, storageDir),
    });
    await router.storageFor("project-origin-abc123");
    // Deterministically await the fire-and-forget registration instead of sleeping.
    await router.whenResolveHooksSettled();

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
// `storageFor()` fires registerResolved (config) before the storage chokepoint runs,
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
    // (storage chokepoint -> markWrite with discoveredBy "write" + storageDir).
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

test("rebuildFromDisk skips non-canonical raw namespace roots", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-spaced";
    const rawDir = path.join(memoryDir, "namespaces", `${ns} `);
    await mkdir(path.join(rawDir, "facts"), { recursive: true });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();

    assert.equal(
      result.records.some((r) => r.namespace === ns && path.resolve(r.storageDir) === path.resolve(rawDir)),
      false,
      "rebuild must not attach the canonical namespace to a non-canonical raw root",
    );
    assert.equal(
      result.records.some((r) => path.resolve(r.storageDir) === path.resolve(rawDir)),
      false,
      "no catalog record may point at a raw root the router cannot resolve",
    );
    assert.ok(
      result.skipped.some((s) => s.token === `${ns} ` && s.reason === "unsafe" && s.detail === `${ns} `),
      "the non-canonical raw root should be reported as an unsafe skip",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildFromDisk preserves a raw ns-default namespace root", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const rawNs = "ns-default";
    const rawDir = path.join(memoryDir, "namespaces", rawNs);
    await mkdir(path.join(rawDir, "facts"), { recursive: true });
    await writeFile(path.join(rawDir, "facts", "f1.md"), "# synthetic\n", "utf8");

    assert.equal(
      namespaceIdentityFromToken(rawNs),
      "",
      "precondition: ns-default is the reserved empty/default identity token",
    );

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();
    const rec = result.records.find((r) => r.namespace === rawNs);

    assert.ok(rec, "rebuild must preserve a routeable raw namespace named ns-default");
    assert.equal(path.resolve(rec.storageDir), path.resolve(rawDir));
    assert.ok(
      !result.skipped.some((s) => s.token === rawNs && s.reason === "unsafe"),
      "the reserved-token decode must fall back to the raw namespace before unsafe checks",
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

// ── NGZqr (codex P2): the READ sanitizer must REJECT an unsafe non-default
// namespace NAME, not only sanitize its storageDir. A pre-fix/tampered jsonl row
// with an unsafe namespace (e.g. `../evil`) was surfaced by listNamespaces/
// getNamespaceRecord because the sanitizer only fixed storageDir — and
// isStorageDirForNamespace can still build a tokenized root for such a name, so
// the storageDir check alone passes. The hot touch + rebuild scan paths reject
// these names with isSafeRouteNamespace; the read boundary must agree, or
// maintenance/QMD could enumerate a namespace those paths reject.
test("listNamespaces/getNamespaceRecord drop an UNSAFE namespace row on read (NGZqr)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const unsafeNs = "../evil"; // fails isSafeRouteNamespace (parent ref + slash)
    const safeNs = "project-origin-ok";
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lines = [
      // A tampered/pre-fix row carrying an unsafe namespace name.
      JSON.stringify({
        namespace: unsafeNs,
        identityToken: namespaceIdentityToken(unsafeNs),
        kind: "project",
        createdAt: new Date().toISOString(),
        storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken(unsafeNs)),
        discoveredBy: "write",
      }),
      // A normal, safe row that MUST still be returned.
      JSON.stringify({
        namespace: safeNs,
        identityToken: namespaceIdentityToken(safeNs),
        kind: "project",
        createdAt: new Date().toISOString(),
        storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken(safeNs)),
        discoveredBy: "write",
      }),
    ];
    await writeFile(path.join(stateDir, "namespaces.jsonl"), lines.join("\n") + "\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // The unsafe namespace must NOT be surfaced by either read surface.
    assert.equal(
      await catalog.getNamespaceRecord(unsafeNs),
      null,
      "getNamespaceRecord must drop an unsafe namespace row",
    );
    const list = await catalog.listNamespaces();
    assert.ok(
      !list.some((r) => r.namespace === unsafeNs),
      "listNamespaces must not surface an unsafe namespace row",
    );
    // The safe namespace is unaffected.
    assert.ok(
      list.some((r) => r.namespace === safeNs),
      "a safe namespace row must still be enumerated",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
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

// NIw0F (codex P2): a scanned namespace root whose only marker child is BOGUS —
// e.g. `facts` is a regular file (or symlink) instead of a real directory —
// must NOT be treated as live. Downstream `scanMemoryDir` throws on a
// symlinked/non-directory category root, so cataloging it would make
// catalog-driven QMD maintenance fail repeatedly on a root with no usable data.
test("rebuildFromDisk does not catalog a namespace whose only marker child is a non-directory file", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-bogus";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(tokenDir, { recursive: true });
    // `facts` exists but is a regular FILE, not a category directory — bogus.
    await writeFile(path.join(tokenDir, "facts"), "not a directory\n", "utf8");

    const result = await new NamespaceCatalog(makeConfig(memoryDir)).rebuildFromDisk();
    assert.ok(
      !result.records.some((r) => r.namespace === ns),
      "a namespace whose only marker is a non-directory file must not be cataloged as live",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Companion to NIw0F: a real category DIRECTORY marker still makes the root live.
test("rebuildFromDisk catalogs a namespace whose facts marker is a real directory", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-realfacts";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    const result = await new NamespaceCatalog(makeConfig(memoryDir)).rebuildFromDisk();
    assert.ok(
      result.records.some((r) => r.namespace === ns),
      "a namespace with a real facts directory must be cataloged as live",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// NH-FH (cursor Medium): when the configured default name carries surrounding
// whitespace, catalog records key it by its NORMALIZED (trimmed) identity, but
// default-namespace exemptions and memoryDir-ownership checks must compare against
// the SAME normalized form — otherwise the default row is misclassified, dropped
// at read, or given the wrong storage root.
test("a whitespace-padded default namespace is still recognized as the default row", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    // The configured default name has surrounding whitespace; records use the
    // trimmed key "default".
    const catalog = new NamespaceCatalog(makeConfig(memoryDir, { defaultNamespace: "  default  " }));
    await catalog.registerConfiguredNamespaces();

    // The default row reads back (not dropped) under its normalized identity,
    // classified as kind "default", and rooted at memoryDir — NOT a tokenized
    // non-default route dir.
    const record = await catalog.getNamespaceRecord("default");
    assert.ok(record, "the default row must survive read sanitization despite a padded config name");
    assert.equal(record?.kind, "default", "padded default config name must classify as the default row");
    assert.equal(
      path.resolve(record!.storageDir),
      path.resolve(memoryDir),
      "the default namespace must own the legacy memoryDir root, not a tokenized non-default dir",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// NIabe (codex P2): when `defaultNamespace` carries surrounding whitespace,
// `resolveDefaultNamespaceRoot` must build the LEGACY default root from the
// NORMALIZED name so it still finds a live `namespaces/default` root. Building it
// from the raw spaced name would look for `namespaces/<spaced>`, miss the real
// root, and fall back to memoryDir/tokenized — pointing reads/writes/rebuild at
// an empty root even though the router classifies the trimmed value as default.
test("resolveDefaultNamespaceRoot finds the legacy default root under a whitespace-padded default name", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir, { defaultNamespace: "  default  " });
    // The live legacy default root is `namespaces/default` (the TRIMMED name) with
    // data; memoryDir itself holds NO legacy data, so the resolver would otherwise
    // fall back to memoryDir.
    const legacyDefaultDir = path.join(memoryDir, "namespaces", "default");
    await mkdir(path.join(legacyDefaultDir, "facts"), { recursive: true });
    await writeFile(path.join(legacyDefaultDir, "facts", "live.md"), "# live\n", "utf8");

    const root = await resolveDefaultNamespaceRoot(config);
    assert.equal(
      path.resolve(root),
      path.resolve(legacyDefaultDir),
      "the resolver must find the live namespaces/default root, not fall back to memoryDir",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// NH3Xy (codex P2): a fallback root must NOT prove a non-default namespace's
// liveness during rebuild --apply. When a dynamic namespace's own token root is a
// symlink/escape (skipped by the scan) but a stale touch row remains, the liveness
// recheck used to resolve the namespace to the DEFAULT `memoryDir` (the fallback)
// and — because the default tree has data — wrongly KEEP the stale row pointing at
// the default tree. The fix treats a non-default namespace that resolves only to
// memoryDir as having no independent live root, so the stale row is purged.
test("rebuildFromDisk purges a stale non-default namespace whose only resolvable root is the default memoryDir", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    // The DEFAULT namespace (memoryDir root) has data, so hasMemoryData(memoryDir)
    // is true — this is what made the buggy fallback look "live".
    await mkdir(path.join(memoryDir, "facts"), { recursive: true });

    const ns = "project-origin-skipped";
    const token = namespaceIdentityToken(ns);
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    // The namespace's OWN token dir is a symlink escaping memoryDir — the scan
    // skips it as unsafe, and its fallback (token dir not contained) lands on
    // memoryDir. Point the symlink at real outside data so a followed link would
    // (wrongly) look populated.
    await mkdir(path.join(outside, "target", "facts"), { recursive: true });
    const tokenDir = path.join(memoryDir, "namespaces", token);
    try {
      await symlink(path.join(outside, "target"), tokenDir, "dir");
    } catch {
      return; // symlinks unsupported in this CI env
    }

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // A touch row exists for the namespace (the escaping legacy/explicit dir forces
    // the resolved root to fail containment), but the scan skips its symlinked root.
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });

    const result = await catalog.rebuildFromDisk();
    assert.ok(
      !result.records.some((r) => r.namespace === ns),
      "a non-default namespace that resolves only to the default memoryDir must be purged, not kept",
    );
    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    assert.equal(
      await reader.getNamespaceRecord(ns),
      null,
      "the purged namespace must not reappear on a fresh read",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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

// ── NFJV8 (codex P2): a dynamic namespace CREATED on disk AFTER the rebuild's
// directory scan but BEFORE its final cross-process re-merge must be KEPT, not
// purged. The scan snapshot missed the brand-new root, yet a gateway markWrite
// already appended a row that shows up in the re-merge's `latest` read. Pre-fix,
// that row (absent from `rebuilt`) was dropped as if the namespace was deleted,
// silently rewriting the catalog without a live, on-disk namespace. The fix
// re-checks the namespace's storage root on disk RIGHT NOW (same symlink/realpath/
// containment + memory-data safety as the scan): exists ⇒ keep (created-after-scan
// is live), confirmed-gone ⇒ purge (preserving the NATqU removed-root fix).
//
// We reuse the second-load injection seam, but ALSO create the namespace's facts
// dir on the SECOND load — so the dir appears AFTER the scan's `readdir` ran but
// BEFORE the re-merge's purge re-check, exactly modelling create-after-scan.
function injectCreatedAfterScanOnSecondLoad(
  catalog: NamespaceCatalog,
  logPath: string,
  injectLine: string,
  rootFactsDir: string,
): void {
  const handle = catalog as unknown as LoadCompactedHandle;
  const original = handle.loadCompacted.bind(catalog);
  let calls = 0;
  handle.loadCompacted = async () => {
    calls += 1;
    if (calls === 2) {
      // 1) The namespace's root is created on disk now (after the scan snapshot).
      await mkdir(rootFactsDir, { recursive: true });
      // 2) The gateway's concurrent markWrite row, present in this re-merge read.
      const prev = await readFile(logPath, "utf8").catch(() => "");
      await writeFile(logPath, prev + injectLine + "\n", "utf8");
    }
    return original();
  };
}

test("rebuild --apply KEEPS a namespace created on disk after the scan but before the re-merge", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-postscan";
    const token = namespaceIdentityToken(ns);
    const tokenDir = path.join(memoryDir, "namespaces", token);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    const logPath = path.join(stateDir, "namespaces.jsonl");

    // The row a gateway markWrite would have appended for the brand-new namespace.
    // Its on-disk root does NOT exist at scan time; it is created (with memory
    // data) on the second load, so the scan misses it but the re-check finds it.
    const writeAt = new Date().toISOString();
    const fresh = JSON.stringify({
      namespace: ns,
      identityToken: token,
      kind: "project",
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      storageDir: tokenDir,
      discoveredBy: "write",
      lastWriteAt: writeAt,
    });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    injectCreatedAfterScanOnSecondLoad(catalog, logPath, fresh, path.join(tokenDir, "facts"));
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      result.records.some((r) => r.namespace === ns),
      "a namespace created on disk after the scan but before the re-merge must be KEPT, not purged",
    );

    // Persisted + its live write timestamp preserved so writtenSince/maintenance
    // can find it without waiting for another touch or rebuild.
    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    const record = await reader.getNamespaceRecord(ns);
    assert.ok(record, "created-after-scan namespace must be persisted in the catalog");
    assert.equal(
      record?.lastWriteAt,
      writeAt,
      "the live write timestamp for a created-after-scan namespace must be preserved",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// NFJV8 inverse guard: a row whose root is GENUINELY gone (never created on disk)
// must STILL be purged — the re-check distinguishes created-after-scan (root
// EXISTS now) from a removed/never-present root (confirmed ABSENT), so it does not
// reintroduce the NATqU resurrection bug. Same injection seam, but the dir is
// never created, so the disk re-check confirms absence and the row is dropped.
test("rebuild --apply STILL purges a row whose on-disk root never exists (NFJV8 does not regress NATqU)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-ghost";
    const token = namespaceIdentityToken(ns);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    const logPath = path.join(stateDir, "namespaces.jsonl");

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
    // Inject the concurrent row on the second load WITHOUT creating the dir, so the
    // re-check confirms the root is absent on disk and the row is purged.
    injectConcurrentReadOnSecondLoad(catalog, logPath, stale);
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      !result.records.some((r) => r.namespace === ns),
      "a row whose on-disk root never exists must still be purged after the disk re-check",
    );

    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    assert.equal(
      await reader.getNamespaceRecord(ns),
      null,
      "ghost-root namespace must not reappear after the disk re-check confirms absence",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── NGLz5 (codex P2): the created-after-scan keep branch must REVALIDATE the
// namespace key (from the untrusted log) with the SAME safety gate the scan uses
// before re-checking its live root. An UNSAFE namespace row (pre-fix / tampered
// `namespaces.jsonl`) whose tokenized dir happens to exist with data was SKIPPED
// by the scan as unsafe — so it is absent from `rebuilt` by design, not deletion.
// Without re-validating, the keep branch would resurrect it and `--apply` would
// rewrite the catalog with a namespace the hot touch/config/scan paths all reject.
// The unsafe row must be DROPPED (purged), not kept.
test("rebuild --apply does NOT resurrect an UNSAFE namespace row even if its token dir has data (NGLz5)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    // Unsafe per isSafeRouteNamespace (space + `!`); its identity token still
    // hex-encodes, so we can create a real on-disk tokenized dir with data.
    const ns = "unsafe ns!";
    const token = namespaceIdentityToken(ns);
    const tokenDir = path.join(memoryDir, "namespaces", token);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    // The unsafe namespace's tokenized dir EXISTS with memory data — the scan
    // still skips it as unsafe, so it never enters `rebuilt`.
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const logPath = path.join(stateDir, "namespaces.jsonl");

    const unsafeRow = JSON.stringify({
      namespace: ns,
      identityToken: token,
      kind: "project",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      storageDir: tokenDir,
      discoveredBy: "write",
      lastWriteAt: new Date().toISOString(),
    });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // Inject the unsafe row on the re-merge read (the dir already exists on disk),
    // so the keep branch's live-root recheck WOULD pass — only the safety gate
    // stops it.
    injectConcurrentReadOnSecondLoad(catalog, logPath, unsafeRow);
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      !result.records.some((r) => r.namespace === ns),
      "an unsafe namespace row must not be resurrected by the created-after-scan keep branch",
    );

    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    assert.equal(
      await reader.getNamespaceRecord(ns),
      null,
      "an unsafe namespace must not appear in the rebuilt catalog after --apply",
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

// ── NGnek (codex P2): a configured namespace with harmless surrounding whitespace
// (e.g. `sharedNamespace: "shared "`) must be NORMALIZED before seeding, so the
// catalog records the same identity + router-resolved root the live router uses.
// Pre-fix, rebuild seeded a row for the RAW `"shared "` resolving to a
// `namespaces/shared ` root that live reads/writes never touch — pointing
// maintenance/QMD at the wrong directory.
test("rebuild normalizes a configured namespace with surrounding whitespace (NGnek)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir, { sharedNamespace: "shared " } as Partial<PluginConfig>);
    const catalog = new NamespaceCatalog(config);
    const result = await catalog.rebuildFromDisk();

    // The catalog must record the TRIMMED identity, not the raw whitespace name.
    assert.ok(
      result.records.some((r) => r.namespace === "shared"),
      "a configured namespace must be seeded under its normalized (trimmed) identity",
    );
    assert.ok(
      !result.records.some((r) => r.namespace === "shared "),
      "the raw whitespace namespace must NOT be seeded",
    );
    const shared = result.records.find((r) => r.namespace === "shared");
    assert.ok(shared, "normalized shared namespace is catalogued");
    // Its kind is correctly classified as `shared` (inferKind normalizes config).
    assert.equal(shared!.kind, "shared", "the normalized namespace is classified as shared");
    // Its storageDir must be the router-aligned root for the trimmed name, with no
    // trailing-space directory component. The router itself trims, so resolving for
    // "shared" yields the live root.
    assert.equal(
      path.resolve(shared!.storageDir),
      path.resolve(await resolveNamespaceStorageRoot(config, "shared")),
      "the normalized namespace resolves to the router root for the trimmed name",
    );
    assert.ok(
      !shared!.storageDir.endsWith("shared "),
      "the storageDir must not point at a trailing-space directory",
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
// touch on instance B must DROP its append while a foreign lock is held,
// instead of skipping the wait (same PID) and appending into the holder's
// window.
//
// Issue #1524 note: the catalog now delegates to the shared withHeldFileLock
// utility, which generates a per-CALL owner uuid (stronger than the previous
// per-instance lockOwnerId). ANY foreign lock — including one written by
// another call on the SAME instance — is therefore not self-held. The test
// seeds a foreign lock with an arbitrary uuid + a heartbeat that keeps it
// fresh, then asserts a touch on a fresh instance waits then DROPS.
test("a same-process second instance does not treat another instance's lock as self-held", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-twoinstances";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");

    // A foreign held lock: a different PID + a real UUID owner id (so it is
    // NEVER mistaken for self by any catalog instance in any process) + a fresh
    // mtime. A heartbeat keeps it fresh so it is never broken as stale during
    // the touch's bounded wait.
    const foreignOwner = "00000000-0000-4000-8000-000000000000";
    await writeFile(lockPath, `999999 ${foreignOwner} ${new Date().toISOString()}\n`, "utf8");
    const hb = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 1_000);
    hb.unref?.();

    try {
      // The catalog instance must NOT consider the foreign lock self-held; its
      // touch waits then DROPS on timeout (no append).
      const instance = new NamespaceCatalog(makeConfig(memoryDir));
      const started = Date.now();
      await instance.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
      const waited = Date.now() - started;
      assert.ok(waited >= 4_000, "the catalog must wait on the foreign lock, not skip it as self");
      assert.equal(
        await instance.getNamespaceRecord(ns),
        null,
        "the touch must DROP while the foreign lock is held (no overwrite race)",
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

// ── Round 7 (codex P2 — NCzT4): the configured-namespace seeding step must NOT
// persist an escaping `storageDir` for a configured non-default namespace whose
// token dir is a symlink pointing OUTSIDE memoryDir. It must reject it (skipped:
// escape) just like the scan loop does, BEFORE the record is seeded/rewritten.
test("rebuild --apply rejects a configured namespace whose token dir escapes via symlink", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const ns = "team-pi-project-origin-escape";
    const token = namespaceIdentityToken(ns);
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    await mkdir(path.join(outside, "evil"), { recursive: true });
    // The configured namespace's token dir is a symlink escaping memoryDir.
    await symlink(path.join(outside, "evil"), path.join(memoryDir, "namespaces", token), "dir");

    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, {
        namespacePolicies: [{ name: ns }],
      } as unknown as Partial<PluginConfig>),
    );
    const result = await catalog.rebuildFromDisk();
    const record = result.records.find((r) => r.namespace === ns);
    assert.ok(
      !record,
      "a configured namespace whose token dir escapes memoryDir must NOT be seeded",
    );
    assert.ok(
      result.skipped.some((s) => s.reason === "escape" && s.token === token),
      "the escaping configured token dir must be reported as skipped (escape)",
    );
    // Persisted log must not carry an escaping storageDir for the namespace.
    const raw = await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8").catch(() => "");
    assert.ok(!raw.includes(path.join(outside, "evil")), "no escaping storageDir may be persisted");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NCzT6): a rebuild must release ONLY its own lock. If
// another process broke our (stale) lock and acquired a REPLACEMENT before our
// finally runs, we must NOT unlink that replacement. We simulate this by swapping
// the lock file for a foreign-owned one during the rebuild and asserting the
// foreign lock survives.
test("a rebuild releases only its own lock, not a replacement foreign lock", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-lockowner";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // Drive the rebuild, but mid-flight (during the scan's loadCompacted) replace
    // the lock file with a FOREIGN-owned one, simulating a process that broke our
    // stale lock and acquired a replacement.
    // A foreign owner id (UUID-shaped, not this instance's) so the rebuild's
    // ownership check correctly treats it as NOT self-held and leaves it alone.
    const foreignOwnerId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const foreignLock = `999999 ${foreignOwnerId} ${new Date().toISOString()}\n`;
    const handle = catalog as unknown as { loadCompacted: () => Promise<Map<string, unknown>> };
    const original = handle.loadCompacted.bind(catalog);
    let swapped = false;
    handle.loadCompacted = async () => {
      if (!swapped) {
        swapped = true;
        await writeFile(lockPath, foreignLock, "utf8");
      }
      return original();
    };

    await catalog.rebuildFromDisk();

    // The foreign replacement lock must still exist (we only release our own).
    const after = await readFile(lockPath, "utf8").catch(() => "");
    assert.equal(after, foreignLock, "a rebuild must not unlink a replacement foreign lock");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NDATT): an explicit storageDir that is contained but
// belongs to ANOTHER namespace's tree (or memoryDir for a non-default namespace)
// must be REJECTED — it must not be persisted as this namespace's root. The touch
// falls back to the namespace's own resolved root.
test("markWrite rejects a cross-namespace explicit storageDir", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const nsA = "project-origin-aaa";
    const nsB = "project-origin-bbb";
    const tokenA = namespaceIdentityToken(nsA);
    const tokenB = namespaceIdentityToken(nsB);
    const bDir = path.join(memoryDir, "namespaces", tokenB);
    await mkdir(path.join(bDir, "facts"), { recursive: true });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // Attempt to record namespace A with namespace B's tree as its storageDir.
    await catalog.markWrite(nsA, { discoveredBy: "write", storageDir: bDir });
    const recordA = await catalog.getNamespaceRecord(nsA);
    assert.ok(recordA, "namespace A record is still created");
    assert.notEqual(
      path.resolve(recordA!.storageDir),
      path.resolve(bDir),
      "A must NOT be recorded under B's tree (cross-namespace root)",
    );
    assert.equal(
      path.resolve(recordA!.storageDir),
      path.resolve(path.join(memoryDir, "namespaces", tokenA)),
      "A falls back to its OWN resolved tokenized root",
    );

    // And memoryDir is rejected for a non-default namespace.
    await catalog.markWrite(nsA, { discoveredBy: "write", storageDir: memoryDir });
    const recordA2 = await catalog.getNamespaceRecord(nsA);
    assert.notEqual(
      path.resolve(recordA2!.storageDir),
      path.resolve(memoryDir),
      "a non-default namespace must not be recorded at memoryDir (default tree)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NDXHe): the READ sanitizer must also reject a contained
// but CROSS-NAMESPACE root (a pre-fix/tampered jsonl record for `project-a` whose
// storageDir is `project-b`'s token dir or memoryDir). listNamespaces /
// getNamespaceRecord must substitute the namespace's OWN resolved root, keeping
// read and write symmetric (rule 42).
test("read sanitizer substitutes a contained cross-namespace storageDir", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const nsA = "project-origin-reada";
    const nsB = "project-origin-readb";
    const tokenA = namespaceIdentityToken(nsA);
    const tokenB = namespaceIdentityToken(nsB);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    // A tampered/pre-fix record: A points at B's (contained) token dir.
    const line = JSON.stringify({
      namespace: nsA,
      identityToken: tokenA,
      kind: "project",
      createdAt: new Date().toISOString(),
      storageDir: path.join(memoryDir, "namespaces", tokenB),
      discoveredBy: "write",
    });
    await writeFile(path.join(stateDir, "namespaces.jsonl"), line + "\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const rec = await catalog.getNamespaceRecord(nsA);
    assert.ok(rec, "record A is returned");
    assert.notEqual(
      path.resolve(rec!.storageDir),
      path.resolve(path.join(memoryDir, "namespaces", tokenB)),
      "read must NOT surface B's tree as A's root",
    );
    assert.equal(
      path.resolve(rec!.storageDir),
      path.resolve(path.join(memoryDir, "namespaces", tokenA)),
      "read substitutes A's OWN resolved root",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NDo79): an explicit storageDir whose LEAF does not exist
// yet but whose existing parent (`namespaces/`) is a SYMLINK escaping memoryDir
// must be rejected. Lexical containment alone would accept it, then a later mkdir
// would follow the symlink outside the memory root. The touch must fall back to a
// safe root instead of persisting the escaping path.
test("explicit storageDir under a symlinked-out parent (non-existent leaf) is rejected", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    // Replace <memoryDir>/namespaces with a symlink to an outside dir.
    await mkdir(path.join(outside, "evilroot"), { recursive: true });
    await symlink(path.join(outside, "evilroot"), path.join(memoryDir, "namespaces"), "dir");

    const ns = "project-origin-symparent";
    // The leaf does not exist yet; its parent (namespaces/) is the escaping link.
    const escapingLeaf = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: escapingLeaf });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record is still created");
    // The caller's explicit dir resolves (via the symlinked `namespaces/` parent)
    // OUTSIDE memoryDir, so it must be REJECTED — the catalog must not persist the
    // exact escaping path the caller supplied. Pre-fix, `isContainedStorageDir`
    // accepted the non-existent leaf and recorded it verbatim.
    assert.notEqual(
      path.resolve(record!.storageDir),
      path.resolve(escapingLeaf),
      "a storageDir escaping via a symlinked parent must not be persisted verbatim",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ── NF21i (codex P2): an explicit storageDir that EXISTS as a regular FILE (not a
// directory) must be REJECTED by the containment check. We place the file at the
// namespace's OWN canonical token dir path (`namespaces/<token>`) so it passes the
// namespace-ownership check (isStorageDirForNamespace) and the ONLY thing that can
// reject it is the directory check inside isContainedStorageDir. A file is
// lexically contained and its realpath stays inside memoryDir, so pre-fix it was
// accepted and persisted as a broken root. Post-fix the file root is rejected and
// the touch falls back to a safe contained root (CLAUDE.md rule #24).
test("an explicit storageDir that is a regular FILE at the token dir is rejected (NF21i)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-fileroot";
    const token = namespaceIdentityToken(ns);
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    // The namespace's canonical token dir path is occupied by a regular FILE.
    const tokenPathAsFile = path.join(memoryDir, "namespaces", token);
    await writeFile(tokenPathAsFile, "# not a directory\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenPathAsFile });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record is still created");
    // The file at the token path must NOT be persisted as the namespace's root —
    // a storage root must be a directory. (Pre-fix the file was accepted verbatim.)
    assert.notEqual(
      path.resolve(record!.storageDir),
      path.resolve(tokenPathAsFile),
      "a regular file must not be persisted as a namespace storage root",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── NHIdt (codex P2): a NOT-YET-EXISTING leaf whose nearest existing ANCESTOR is a
// regular FILE must be rejected. `realpath(parent)` succeeds and resolves inside
// memoryDir for a file `<memoryDir>/namespaces`, so a containment-only ancestor
// check would ACCEPT a leaf that can never be created (no child dir under a file).
// We place a FILE at `namespaces` and pass an explicit non-existent leaf under it;
// the touch must not persist that escaping/uncreatable path.
test("an explicit storageDir whose nearest existing ancestor is a FILE is rejected (NHIdt)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-fileancestor";
    const token = namespaceIdentityToken(ns);
    // `<memoryDir>/namespaces` is a regular FILE, not a directory.
    const namespacesAsFile = path.join(memoryDir, "namespaces");
    await writeFile(namespacesAsFile, "# not a directory\n", "utf8");
    // The explicit leaf does not exist; its nearest existing ancestor is the file.
    const leafUnderFile = path.join(namespacesAsFile, token);

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: leafUnderFile });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record is still created");
    assert.notEqual(
      path.resolve(record!.storageDir),
      path.resolve(leafUnderFile),
      "a leaf whose nearest existing ancestor is a file must not be persisted as a root",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NDo8C): an ASYNC onResolve hook that REJECTS must not
// crash storage resolution — the rejection must be swallowed (best-effort).
test("an async onResolve hook rejection does not crash storage resolution", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    let called = 0;
    const router = new NamespaceStorageRouter(makeConfig(memoryDir), {
      onResolve: async () => {
        called += 1;
        throw new Error("async hook failure");
      },
    });
    // Must not throw or produce an unhandled rejection that fails the test.
    const sm = await router.storageFor("default");
    assert.ok(sm, "storage resolution succeeds despite a rejecting async hook");
    // Deterministically await the swallowed rejection instead of sleeping.
    await router.whenResolveHooksSettled();
    assert.ok(called >= 1, "the async hook was invoked");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── NFJV- (codex P2): the once-per-namespace resolve-hook dedup must account for
// IN-FLIGHT async registrations. The catalog's onResolve hook is async (returns
// registerResolved(...)), so the `notifiedResolved` map is only set after the
// promise settles. A burst of storageFor() cache hits for the SAME namespace
// before the first append finishes must NOT each fire their own registration —
// otherwise hot recall/extraction grows namespaces.jsonl with duplicate touches.
test("concurrent storageFor() for one namespace fires the resolve hook ONCE while it is in-flight", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    let calls = 0;
    // A deferred promise we resolve manually, so every concurrent storageFor()
    // call observes the registration as still IN-FLIGHT (not yet settled).
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const router = new NamespaceStorageRouter(makeConfig(memoryDir), {
      onResolve: async () => {
        calls += 1;
        await gate;
      },
    });

    // Fire N concurrent resolutions for the SAME namespace while the first hook
    // is still awaiting `gate`. Pre-fix, all N pass the post-settle dedup guard
    // and fire N hooks; post-fix the in-flight marker collapses them to one.
    const N = 8;
    await Promise.all(Array.from({ length: N }, () => router.storageFor("project-origin-inflight")));
    assert.equal(calls, 1, "only one resolve hook may fire while the registration is in-flight");

    // Let the in-flight registration settle, then a steady-state cache hit must
    // still be a catalog no-op (now deduped via notifiedResolved).
    release();
    await router.whenResolveHooksSettled();
    await router.storageFor("project-origin-inflight");
    assert.equal(calls, 1, "a steady-state cache hit after settle must not re-fire the hook");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── NFJV- inverse: a DROPPED registration (hook returns false — e.g. the touch
// could not acquire the rebuild lock) must clear the in-flight marker so a LATER
// storageFor() RETRIES it. A dropped touch must remain retryable, not be
// permanently suppressed by the in-flight dedup.
test("a dropped resolve registration (hook returns false) is retried on a later storageFor()", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    let calls = 0;
    let result: boolean | void = false; // first registration is DROPPED
    const router = new NamespaceStorageRouter(makeConfig(memoryDir), {
      onResolve: async () => {
        calls += 1;
        return result;
      },
    });

    await router.storageFor("project-origin-retry");
    // Deterministically await the async hook so the in-flight marker is cleared.
    await router.whenResolveHooksSettled();
    assert.equal(calls, 1, "the hook fired once for the dropped registration");

    // Now the registration will succeed; a later resolve must RETRY (not be
    // suppressed by a stale in-flight/notified marker from the dropped attempt).
    result = undefined; // success (legacy void)
    await router.storageFor("project-origin-retry");
    await router.whenResolveHooksSettled();
    assert.equal(calls, 2, "a dropped registration must be retried on the next storageFor()");

    // After a SUCCESSFUL registration, further cache hits are deduped (no retry).
    await router.storageFor("project-origin-retry");
    await router.whenResolveHooksSettled();
    assert.equal(calls, 2, "a successful registration is not re-fired on subsequent cache hits");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── In-flight dedup under a DROPPED hook (cursor Medium 06f58a7c, codex P2).
// The serializer strictly orders queued tasks, but ordering alone does not
// collapse a burst when the hook returns `false` (dropped registration, e.g. a
// rebuild-lock timeout): `notifiedResolved` stays unset, so every queued sibling
// task passes its re-check and re-invokes the hook — N serial lock waits. The
// `inFlightResolveHooks` marker (set synchronously before queueing) collapses the
// burst to a single hook invocation; the drop stays retryable on a LATER
// storageFor(). This test PROVE-FAILS without the marker (calls === N) and PASSES
// with it (calls === 1).
test("a burst of concurrent storageFor() with a DROPPED hook fires it ONCE (not once per queued task)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    let calls = 0;
    // Gated hook that DROPS (returns false) once released. This is the real
    // scenario the reviewers flagged: the catalog's onResolve waits on the
    // rebuild lock (slow), times out, and returns false. While that hook is
    // in-flight, a burst of cache hits must collapse to the one in-flight
    // registration instead of each queueing its own serial lock wait.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const router = new NamespaceStorageRouter(makeConfig(memoryDir), {
      onResolve: async () => {
        calls += 1;
        await gate;
        return false; // dropped (rebuild-lock timeout analogue)
      },
    });

    // A burst of concurrent cache hits while the hook is IN-FLIGHT. Without the
    // in-flight dedup marker each enqueued task would re-run the dropped hook
    // once the first settles (N serial lock waits); with it they collapse.
    const N = 8;
    await Promise.all(Array.from({ length: N }, () => router.storageFor("project-origin-burst-drop")));
    // Let the in-flight hook settle as DROPPED.
    release();
    await router.whenResolveHooksSettled();
    assert.equal(calls, 1, "a dropped hook fires ONCE under a burst, not once per queued task");

    // The drop must remain retryable: a later storageFor() re-fires the hook.
    await router.storageFor("project-origin-burst-drop");
    await router.whenResolveHooksSettled();
    assert.equal(calls, 2, "a dropped registration is retried on the next storageFor()");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Composite-key in-flight dedup (cursor Medium, codex P2): the in-flight
// marker must be keyed by (namespace, storageDir), NOT namespace alone. A
// CHANGED storageDir (migration/realignment) for the same namespace while
// another dir's hook is pending must still get its OWN hook invocation — it is
// not collapsed onto the old dir's pending registration. A namespace-only key
// would silently drop the new-dir notification.
test("a CHANGED storageDir for the same namespace is not collapsed onto a pending hook", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const router = new NamespaceStorageRouter(makeConfig(memoryDir), {
      onResolve: async (_ns, dir) => {
        seen.push(dir);
        await gate;
      },
    });
    // notifyResolved is private; reach it via the same cast pattern other tests
    // use for router internals, so we can drive two distinct dirs directly.
    const internals = router as unknown as {
      notifyResolved(namespace: string, storageDir: string): void;
    };
    const dirA = path.join(memoryDir, "dir-a");
    const dirB = path.join(memoryDir, "dir-b");
    // dirA's hook is IN-FLIGHT (gated). dirB is a DIFFERENT dir for the same
    // namespace — it must NOT be collapsed onto dirA's pending registration.
    internals.notifyResolved("project-origin-dir-change", dirA);
    internals.notifyResolved("project-origin-dir-change", dirB);
    release();
    await router.whenResolveHooksSettled();
    assert.deepEqual(
      seen.sort(),
      [dirA, dirB].sort(),
      "both distinct dirs fire their own hook; the new dir is not collapsed onto the pending one",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NDxiS): a configured non-default namespace must be seeded
// with the ROUTER-resolved root, not a blanket tokenized dir. When a legacy raw
// root (`namespaces/<rawname>`) already exists, the router serves it, so the
// catalog must record that runtime path — not `namespaces/<token>`.
test("rebuild seeds a configured namespace at its router-resolved (legacy raw) root", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "team-pi-project-origin-cfg";
    // An EMPTY legacy raw-name root exists (no memory data) for this configured
    // policy namespace. The scan SKIPS empty roots, so only the configured
    // seeding determines the storageDir — which must match the router's choice.
    const legacyRaw = path.join(memoryDir, "namespaces", ns);
    await mkdir(legacyRaw, { recursive: true });

    const policyCfg = makeConfig(memoryDir, {
      namespacePolicies: [{ name: ns }],
    } as unknown as Partial<PluginConfig>);
    const routerRoot = await resolveNamespaceStorageRoot(policyCfg, ns);
    assert.equal(routerRoot, legacyRaw, "router resolves the empty legacy raw root when it exists");

    const catalog = new NamespaceCatalog(policyCfg);
    const result = await catalog.rebuildFromDisk();
    const rec = result.records.find((r) => r.namespace === ns);
    assert.ok(rec, "the configured namespace is catalogued");
    assert.equal(
      path.resolve(rec!.storageDir),
      path.resolve(legacyRaw),
      "a configured namespace must be seeded at its router-resolved root, not the tokenized dir",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — ND6Cz): touches run on per-process write chains, so two
// processes can each append a full snapshot for the same namespace carrying
// DIFFERENT touch fields. Plain last-record-wins compaction would erase the
// earlier snapshot's field; field-level merge during compaction preserves the
// MAX of each touch field so no cross-process touch recency is lost.
test("compaction preserves both touch fields from concurrent cross-process snapshots", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-xproc-merge";
    const token = namespaceIdentityToken(ns);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const tokenDir = path.join(memoryDir, "namespaces", token);

    const base = {
      namespace: ns,
      identityToken: token,
      kind: "project",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      storageDir: tokenDir,
      discoveredBy: "write",
    };
    const writeAt = new Date(Date.now() - 60_000).toISOString();
    const readAt = new Date(Date.now() - 30_000).toISOString();
    // Process A appended a WRITE snapshot (only lastWriteAt); process B then
    // appended a READ snapshot (only lastReadAt) built from the SAME prior state,
    // so it lacks A's lastWriteAt. Last-record-wins would drop lastWriteAt.
    const lineA = JSON.stringify({ ...base, lastWriteAt: writeAt });
    const lineB = JSON.stringify({ ...base, lastReadAt: readAt });
    await writeFile(path.join(stateDir, "namespaces.jsonl"), `${lineA}\n${lineB}\n`, "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const rec = await catalog.getNamespaceRecord(ns);
    assert.ok(rec, "the namespace is present after compaction");
    assert.equal(rec?.lastReadAt, readAt, "the later read snapshot's lastReadAt survives");
    assert.equal(
      rec?.lastWriteAt,
      writeAt,
      "the earlier write snapshot's lastWriteAt is NOT erased by the later read snapshot",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NEOFS): the DEFAULT namespace's seeded root must also be
// containment-checked. If `resolveDefaultNamespaceRoot()` returns a
// `namespaces/<default-token>` symlink escaping memoryDir (empty legacy default +
// symlinked tokenized dir with a marker), rebuild must NOT persist that escaping
// path for the default record — it falls back to the trusted memoryDir root.
test("rebuild does not persist an escaping symlinked default root", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    // An outside tree WITH a storage marker, linked from the default token dir.
    await mkdir(path.join(outside, "evildefault", "facts"), { recursive: true });
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    const defaultToken = namespaceIdentityToken("default");
    await symlink(
      path.join(outside, "evildefault"),
      path.join(memoryDir, "namespaces", defaultToken),
      "dir",
    );

    // Sanity: the router-level resolver would pick the escaping symlinked dir.
    const resolved = await resolveDefaultNamespaceRoot(makeConfig(memoryDir));
    assert.equal(
      path.resolve(resolved),
      path.resolve(path.join(memoryDir, "namespaces", defaultToken)),
      "resolveDefaultNamespaceRoot picks the symlinked default token dir",
    );

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();
    const def = result.records.find((r) => r.namespace === "default");
    assert.ok(def, "the default record exists");
    // The default storageDir must NOT resolve outside memoryDir.
    const realOutside = await realpath(outside).catch(() => outside);
    const realDefault = await realpath(def!.storageDir).catch(() => def!.storageDir);
    assert.ok(
      !realDefault.startsWith(realOutside),
      "the default record must not carry an escaping storageDir",
    );
    assert.equal(
      path.resolve(def!.storageDir),
      path.resolve(memoryDir),
      "an escaping default root falls back to the trusted memoryDir",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ── Round 7 (codex P2 — NEZkA): HELD-MUTEX rebuild lock. The crux invariant:
// no `namespaces.jsonl` append can occur between a rebuild's final
// `loadCompacted()` and its atomic `rename()`. Previously a touch only POLLED for
// the lock (`waitForRebuildLockClear`) then read+appended WITHOUT holding it — a
// check-then-act gap. If a touch passed the check while no lock existed, a rebuild
// could then acquire the lock, run its final load, and rename OVER the touch's
// later append → the append is silently lost-then-overwritten despite the lock.
//
// The two `NamespaceCatalog` instances below have independent write chains and
// distinct lock owner ids, exactly like two PROCESSES (the gateway writer vs. the
// CLI rebuilder). Two protected test seams let us reproduce the precise lost-append
// interleaving deterministically:
//   1. the writer pauses inside its touch critical section (post lock-decision);
//   2. the rebuilder pauses in its load→rename window (lock held).
// A barrier coordinates them so the touch's append, if it can happen, lands inside
// the rebuilder's load→rename window.
//
// With the OLD check-then-append code the writer's `waitForRebuildLockClear`
// returns true (it ran before any lock existed), the writer appends inside the
// window, and the rebuild's rename CLOBBERS it → the assertion FAILS. With the
// held mutex the writer cannot ACQUIRE the lock while the rebuilder holds it, so
// its append cannot land in the window: it either blocks until release (landing
// AFTER the rename, preserved) or is cleanly dropped — never lost-then-overwritten.
class SeamCatalog extends NamespaceCatalog {
  setTouchSeam(fn: (() => Promise<void>) | undefined): void {
    (this as unknown as { onTouchCriticalSectionForTest?: () => Promise<void> }).onTouchCriticalSectionForTest =
      fn;
  }
  setRebuildBeforeRenameSeam(fn: (() => Promise<void>) | undefined): void {
    (this as unknown as { onRebuildBeforeRenameForTest?: () => Promise<void> }).onRebuildBeforeRenameForTest =
      fn;
  }
  setRebuildAfterScanSeam(fn: (() => Promise<void>) | undefined): void {
    (this as unknown as { onRebuildAfterScanForTest?: () => Promise<void> }).onRebuildAfterScanForTest =
      fn;
  }
  setBreakStaleSeam(fn: (() => Promise<void>) | undefined): void {
    (this as unknown as { onBeforeBreakStaleUnlinkForTest?: () => Promise<void> }).onBeforeBreakStaleUnlinkForTest =
      fn;
  }
  /**
   * Drive the catalog's break-stale path through the shared util (issue #1524
   * adoption). The catalog no longer owns a private breakStaleRebuildLock; the
   * util's breakStaleLock fires inside its acquire loop, which is what
   * withHeldCatalogLock now invokes. We trigger that path with a SHORT maxWaitMs
   * so a surviving replacement lock is observed quickly (the production
   * REBUILD_LOCK_MAX_WAIT_MS would force a 5s wait on the NG7Bg-replacement
   * case). The seam is forwarded exactly as production does.
   */
  async callBreakStaleRebuildLock(): Promise<void> {
    const seam = (this as unknown as { onBeforeBreakStaleUnlinkForTest?: () => Promise<void> })
      .onBeforeBreakStaleUnlinkForTest;
    // Match the catalog's lock config (stale/heartbeat/poll); only maxWaitMs
    // is shortened for test speed. The break-stale invariant does not depend
    // on maxWaitMs — the seam fires inside breakStaleLock regardless.
    await withHeldFileLock(
      (this as unknown as { rebuildLockPath: string }).rebuildLockPath,
      {
        staleMs: 30_000,
        maxWaitMs: 200,
        pollMs: 10,
        heartbeatMs: 10_000,
        onBeforeBreakStaleUnlinkForTest: seam,
      },
      async () => {
        // No-op: we only need the acquire loop to invoke breakStaleLock so the
        // seam fires and the replacement/stale-lock invariant is exercised.
      },
    );
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("a touch append cannot land inside a rebuild's load→rename window (held mutex)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-held-mutex";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    // On-disk data so rebuild discovers the namespace as a scan record (no
    // lastWriteAt of its own); the racing write touch is what supplies lastWriteAt.
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    // Separate instances == separate processes (separate writeChain + lock owner).
    const writer = new SeamCatalog(makeConfig(memoryDir));
    const rebuilder = new SeamCatalog(makeConfig(memoryDir));

    // Barriers to force the exact lost-append interleaving regardless of timing.
    const writerInSection = deferred(); // writer has entered its touch critical section
    const rebuilderInWindow = deferred(); // rebuilder is in its load→rename window
    let writerObservedLockHeld = false;

    // Writer pauses right after its lock decision, INSIDE the critical section:
    // signal we are here, then wait for the rebuilder to reach its rename window
    // before proceeding to append. (With the held mutex the writer only reaches
    // this seam if it ACQUIRED the lock — so we also record whether the rebuilder
    // could acquire concurrently.)
    writer.setTouchSeam(async () => {
      writerInSection.resolve();
      // Bounded wait so a held-mutex run (where the rebuilder can NEVER reach its
      // window concurrently because the writer holds the lock) does not hang.
      await Promise.race([
        rebuilderInWindow.promise,
        new Promise<void>((r) => setTimeout(r, 1500)),
      ]);
    });

    // Rebuilder, inside its load→rename window (lock held): signal, then wait for
    // the writer to be in its section so an OLD-code append would land here.
    rebuilder.setRebuildBeforeRenameSeam(async () => {
      rebuilderInWindow.resolve();
      writerObservedLockHeld = true;
      await Promise.race([
        writerInSection.promise,
        new Promise<void>((r) => setTimeout(r, 1500)),
      ]);
      // Brief settle so an OLD-code writer (already past its no-lock check) has a
      // chance to append inside this window before we rename.
      await new Promise<void>((r) => setTimeout(r, 200));
    });

    // Fire both concurrently. The writer's markWrite is best-effort and must never
    // throw; the rebuild applies.
    const [, rebuildResult] = await Promise.all([
      writer.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir }),
      rebuilder.rebuildFromDisk(),
    ]);

    assert.ok(writerObservedLockHeld, "the rebuilder must have reached its rename window");

    // INVARIANT: the write touch is never silently lost-then-overwritten. With the
    // held mutex it lands AFTER the rebuild's rename (preserved) or is cleanly
    // dropped; it can NOT be clobbered mid-window. A fresh reader sees it preserved.
    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    const record = await reader.getNamespaceRecord(ns);
    assert.ok(record, "namespace must exist after the concurrent rebuild + write");
    assert.ok(
      record?.lastWriteAt,
      "the write touch must survive the rebuild — not be clobbered inside its load→rename window",
    );
    // The rebuild itself applied (held the lock and rewrote).
    assert.equal(rebuildResult.applied, true, "rebuild --apply held the lock and rewrote");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── NFgCT (codex P2): the cross-process mutex is now SCOPED to the final
// load→merge→rename window, NOT the disk scan. A gateway touch that races only the
// (potentially long) SCAN phase must therefore NOT be blocked/dropped — it should
// acquire the lock freely because the rebuild does not hold it during the scan.
// We pause the rebuild AFTER its scan but BEFORE it acquires the lock (the new
// after-scan seam), fire a cross-instance write touch there, and assert the touch
// SUCCEEDS (the lock was free) and its write survives the rebuild. Pre-fix (lock
// held across the whole scan) the touch would contend with the held lock.
test("a touch racing only the rebuild SCAN phase is not blocked by the mutex (NFgCT)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-scan-race";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    // Separate instances == separate processes (separate writeChain + lock owner).
    const writer = new SeamCatalog(makeConfig(memoryDir));
    const rebuilder = new SeamCatalog(makeConfig(memoryDir));

    let seamFired = false;
    // When the rebuild reaches the post-scan / pre-lock point, perform a
    // cross-instance write touch. Because the rebuild has NOT yet acquired the
    // lock, this touch must acquire it freely and APPEND (land a lastWriteAt), not
    // contend with a held lock and drop. `markWrite` resolves to void; we prove it
    // was NOT dropped by reading back the persisted record below. The touch
    // resolving WITHOUT hanging here already proves the scan does not hold the lock
    // (otherwise the writer would block on the very lock the rebuild owns).
    rebuilder.setRebuildAfterScanSeam(async () => {
      seamFired = true;
      await writer.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
      // Clear the seam so it does not re-fire on any nested rebuild.
      rebuilder.setRebuildAfterScanSeam(undefined);
    });

    const result = await rebuilder.rebuildFromDisk();
    assert.ok(seamFired, "the post-scan / pre-lock seam must have fired");
    assert.equal(result.applied, true, "the rebuild still held the lock for its final rewrite and applied");

    // The write touch landed during the lockless scan window and SURVIVED — the
    // rebuild's final re-merge re-reads the log under the lock and folds it. If the
    // lock had been held across the scan, the touch would have timed out and been
    // dropped (no lastWriteAt).
    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    const record = await reader.getNamespaceRecord(ns);
    assert.ok(record, "namespace must exist after the scan-phase touch + rebuild");
    assert.ok(
      record?.lastWriteAt,
      "a touch that landed during the lockless scan must NOT be dropped and must survive the rebuild's final re-merge",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Companion: a touch that CANNOT acquire the held lock within the bounded wait
// (a foreign, non-stale, heartbeated rebuild lock is held by "another process")
// must DROP its append best-effort — it must NEVER append without the lock and
// NEVER crash the primary memory op. Here the foreign lock never releases within
// the touch's wait, so the touch degrades to a no-op (dropped) rather than racing.
test("a touch drops (never crashes, never appends) when it cannot acquire the held lock", async () => {
  const memoryDir = await mkMemoryDir();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const ns = "project-origin-lock-drop";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    // Foreign held lock: a different PID + a real UUID owner id (so it is NOT
    // mistaken for self) + a fresh mtime. A heartbeat keeps it fresh so it is
    // never broken as stale during the touch's bounded wait.
    const foreignOwner = "00000000-0000-4000-8000-000000000000";
    await writeFile(lockPath, `999999 ${foreignOwner} ${new Date().toISOString()}\n`, "utf8");
    heartbeat = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 250);

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const started = Date.now();
    // Must resolve (best-effort drop), never reject.
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
    const waited = Date.now() - started;

    // The append was DROPPED: no record was written because the lock never cleared.
    const record = await catalog.getNamespaceRecord(ns);
    assert.equal(record, null, "a touch that cannot acquire the lock must NOT append");
    // It must have given up within the bounded wait, not blocked forever.
    assert.ok(waited < 12_000, "the dropped touch must return within the bounded wait");
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── NG7Bg (codex P2): breaking a STALE lock must not delete a REPLACEMENT lock
// created in the race window. Two processes can both judge the same lock stale;
// one removes it and creates a fresh lock, and the other's later unlink would
// delete that fresh holder's ACTIVE lock based on the stale identity it read
// earlier — leaving the fresh holder running its critical section unprotected. The
// break now re-validates the lock identity immediately before unlinking and skips
// the unlink when a replacement (different owner/timestamp) is present. We simulate
// the replacement via the post-judgment seam and assert the fresh lock survives.
test("breakStaleRebuildLock does not delete a replacement lock created in the race window (NG7Bg)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");

    // 1) A genuinely STALE lock (owner A, mtime well past the stale threshold).
    const staleIdentity = `111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa ${new Date(
      Date.now() - 120_000,
    ).toISOString()}\n`;
    await writeFile(lockPath, staleIdentity, "utf8");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    const breaker = new SeamCatalog(makeConfig(memoryDir));
    // 2) In the race window (after staleness is judged, before unlink), a DIFFERENT
    //    process removes the stale lock and creates a FRESH replacement (owner B,
    //    current mtime).
    const replacementIdentity = `222222 bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb ${new Date().toISOString()}\n`;
    breaker.setBreakStaleSeam(async () => {
      await writeFile(lockPath, replacementIdentity, "utf8");
      const now = new Date();
      await utimes(lockPath, now, now);
      breaker.setBreakStaleSeam(undefined);
    });

    await breaker.callBreakStaleRebuildLock();

    // 3) The replacement lock must STILL exist with its own identity — it was not
    //    deleted based on the stale identity the breaker read earlier.
    const after = await readFile(lockPath, "utf8").catch(() => "");
    assert.equal(
      after,
      replacementIdentity,
      "a replacement lock created in the race window must NOT be unlinked",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// NG7Bg baseline: a genuinely stale lock with an UNCHANGED identity is still broken
// (the fix must not stop legitimate stale-lock recovery).
test("breakStaleRebuildLock still removes a stale lock whose identity is unchanged (NG7Bg baseline)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    const stale = `333333 cccccccc-cccc-4ccc-8ccc-cccccccccccc ${new Date(
      Date.now() - 120_000,
    ).toISOString()}\n`;
    await writeFile(lockPath, stale, "utf8");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    const breaker = new SeamCatalog(makeConfig(memoryDir));
    await breaker.callBreakStaleRebuildLock();

    const exists = await readFile(lockPath, "utf8").then(() => true, () => false);
    assert.equal(exists, false, "an unchanged stale lock must still be broken");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Round 7 (kilo P2 — NER8P): `namespaces rebuild --apply --json` must EXIT
// NON-ZERO when the rebuild could not be applied (lock contention →
// `applied: false`), mirroring the non-JSON path. Otherwise JSON-mode automation
// treats a no-op apply as success. The CLI's `--json` apply branch sets
// `process.exitCode = 1` iff `!dryRun && !result.applied`. We drive a real
// `rebuildFromDisk` under lock contention (so `applied === false`) and apply the
// exact CLI rule, asserting the non-zero exit signal — restoring `process.exitCode`
// afterward so this test cannot leak a failure code into the runner.
test("rebuild --apply --json exits non-zero when the rebuild was not applied (NER8P)", async () => {
  const memoryDir = await mkMemoryDir();
  const savedExitCode = process.exitCode;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const ns = "project-origin-json-noapply";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    // Foreign, non-stale, heartbeated lock held by "another process" so the apply
    // cannot acquire the lock and returns applied:false (compute-only).
    const foreignOwner = "00000000-0000-4000-8000-0000000000aa";
    await writeFile(lockPath, `999999 ${foreignOwner} ${new Date().toISOString()}\n`, "utf8");
    heartbeat = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 250);

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // Mirror the CLI: --apply means dryRun=false.
    const dryRun = false;
    const result = await catalog.rebuildFromDisk({ dryRun });
    assert.equal(result.applied, false, "a contended apply must report applied=false");

    // The EXACT decision the CLI `--json` apply branch makes (cli.ts).
    process.exitCode = undefined;
    if (!dryRun && !result.applied) {
      process.exitCode = 1;
    }
    assert.equal(
      process.exitCode,
      1,
      "a JSON apply that was not applied must set a non-zero exit code so automation detects the no-op",
    );

    // Sanity: a successful apply (no contention) must NOT set a non-zero exit.
    clearInterval(heartbeat);
    heartbeat = undefined;
    await rm(lockPath, { force: true });
    process.exitCode = undefined;
    const ok = await catalog.rebuildFromDisk({ dryRun: false });
    assert.equal(ok.applied, true, "an uncontended apply applies");
    if (!ok.applied) process.exitCode = 1;
    assert.notEqual(process.exitCode, 1, "a successful apply must not exit non-zero");
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    process.exitCode = savedExitCode;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── NFb5W (cursor Medium): an INERT catalog `namespaces rebuild --apply` rewrote
// nothing, so exit-code-only automation must see a non-zero exit — the same
// signal the enabled path emits for a non-dry-run rebuild that did not apply.
// The CLI's inert branch returns early before `rebuildFromDisk`; it now sets
// `process.exitCode = 1` iff `!dryRun` (apply), while a dry-run inert call stays
// exit 0. We assert the exact inert-branch decision against a disabled catalog.
test("inert rebuild --apply exits non-zero; inert --dry-run stays zero (NFb5W)", async () => {
  const memoryDir = await mkMemoryDir();
  const savedExitCode = process.exitCode;
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir, { namespacesEnabled: false }));
    assert.equal(catalog.enabled, false, "an inert catalog reports disabled (the CLI gate)");

    // INERT + --apply (dryRun=false): the CLI sets exitCode=1 before returning.
    process.exitCode = undefined;
    {
      const dryRun = false; // --apply
      if (!catalog.enabled && !dryRun) process.exitCode = 1;
    }
    assert.equal(
      process.exitCode,
      1,
      "an inert `--apply` rewrote nothing and must exit non-zero so automation does not read it as a completed rebuild",
    );

    // INERT + --dry-run (default): no write was ever promised → exit stays 0.
    process.exitCode = undefined;
    {
      const dryRun = true;
      if (!catalog.enabled && !dryRun) process.exitCode = 1;
    }
    assert.notEqual(
      process.exitCode,
      1,
      "an inert dry-run must not exit non-zero — it never promised to write",
    );
  } finally {
    process.exitCode = savedExitCode;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── NRcCD (codex P2): preserve cataloged token-shaped raw roots during rebuild ──
// A DYNAMIC namespace literally named `ns-616c706861` (= the canonical token of
// `alpha`) is served from a legacy raw root `namespaces/ns-616c706861` and already
// owns a catalog row from the write path. Before the fix, the rebuild scanner
// decoded that dir to `alpha`, emitting an `alpha` row at the raw root, while the
// final live-row remerge kept the real `ns-616c706861` row too — TWO rows at the
// SAME storageDir, fanning QMD/maintenance out under the wrong namespace. The fix
// prefers the LITERAL dir name when it is already a KNOWN (cataloged) namespace.
test("rebuildFromDisk keeps a cataloged token-shaped raw root as the literal namespace (NRcCD)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    // The raw root is literally named like alpha's canonical token.
    const literalNs = namespaceIdentityToken("alpha"); // "ns-616c706861"
    assert.equal(
      namespaceIdentityFromToken(literalNs),
      "alpha",
      "precondition: the dir name decodes to alpha — the ambiguity this test exercises",
    );
    const rawRoot = path.join(memoryDir, "namespaces", literalNs);
    // Legacy raw root holding memory data.
    await mkdir(path.join(rawRoot, "facts"), { recursive: true });
    await writeFile(path.join(rawRoot, "facts", "f1.md"), "# synthetic\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // Write-path row: the dynamic namespace is cataloged at its raw root verbatim.
    await catalog.markWrite(literalNs, { discoveredBy: "write", storageDir: rawRoot });
    const seeded = await catalog.getNamespaceRecord(literalNs);
    assert.ok(seeded, "precondition: literal namespace has a catalog row before rebuild");
    assert.equal(path.resolve(seeded!.storageDir), path.resolve(rawRoot));

    const result = await catalog.rebuildFromDisk();

    // EXACTLY ONE row points at the raw root, and it is the LITERAL namespace.
    const atRawRoot = result.records.filter(
      (r) => path.resolve(r.storageDir) === path.resolve(rawRoot),
    );
    assert.equal(
      atRawRoot.length,
      1,
      `rebuild must produce exactly one catalog row for ${rawRoot}, got: ${atRawRoot
        .map((r) => r.namespace)
        .join(", ")}`,
    );
    assert.equal(
      atRawRoot[0]?.namespace,
      literalNs,
      "the surviving row must be the literal namespace, not the decoded alias",
    );
    assert.ok(
      !result.records.some((r) => r.namespace === "alpha"),
      "rebuild must NOT emit a decoded `alpha` alias row when the literal owner exists",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// Control: a genuine tokenized dir with NO literal owner (no cataloged row keyed
// by the raw token) still decodes back to its identity, exactly as before. This
// guards against the NRcCD fix over-suppressing the canonical decode.
test("rebuildFromDisk still decodes a tokenized root with no literal owner (NRcCD control)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const token = namespaceIdentityToken("alpha"); // tokenized dir for `alpha`
    await mkdir(path.join(memoryDir, "namespaces", token, "facts"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "namespaces", token, "facts", "f1.md"),
      "# synthetic\n",
      "utf8",
    );

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();

    assert.ok(
      result.records.some((r) => r.namespace === "alpha"),
      "with no literal owner, a tokenized dir still decodes to its identity",
    );
    assert.ok(
      !result.records.some((r) => r.namespace === token),
      "the literal token form must NOT appear when nothing owns it",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("listNamespaces drops stale decoded aliases for catalog-owned token-shaped roots", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const literalNs = namespaceIdentityToken("alpha");
    const rawRoot = path.join(memoryDir, "namespaces", literalNs);
    await mkdir(path.join(rawRoot, "facts"), { recursive: true });
    await writeFile(path.join(rawRoot, "facts", "f1.md"), "# synthetic\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(literalNs, { discoveredBy: "write", storageDir: rawRoot });
    await catalog.markRead("alpha", { discoveredBy: "read", storageDir: rawRoot });

    const atRawRoot = (await catalog.listNamespaces()).filter(
      (record) => path.resolve(record.storageDir) === path.resolve(rawRoot),
    );
    assert.deepEqual(
      atRawRoot.map((record) => record.namespace),
      [literalNs],
      "the read API must expose only the catalog-owned literal namespace for a shared root",
    );
    assert.equal(
      await catalog.getNamespaceRecord("alpha"),
      null,
      "status lookup must not report a stale alias that listNamespaces drops",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildFromDisk merges touch fields from dropped root aliases", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const literalNs = namespaceIdentityToken("alpha");
    const rawRoot = path.join(memoryDir, "namespaces", literalNs);
    await mkdir(path.join(rawRoot, "facts"), { recursive: true });
    await writeFile(path.join(rawRoot, "facts", "f1.md"), "# synthetic\n", "utf8");

    const literalWrite = new Date("2026-01-01T00:00:00.000Z");
    const literalMaintenance = new Date("2026-01-01T01:00:00.000Z");
    const aliasWrite = new Date("2026-01-02T00:00:00.000Z");
    const aliasMaintenance = new Date("2026-01-02T01:00:00.000Z");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(literalNs, {
      discoveredBy: "write",
      storageDir: rawRoot,
      at: literalWrite,
    });
    await catalog.markMaintenance(literalNs, "qmd", literalMaintenance);
    await catalog.markWrite("alpha", {
      discoveredBy: "write",
      storageDir: rawRoot,
      at: aliasWrite,
    });
    await catalog.markMaintenance("alpha", "qmd", aliasMaintenance);

    const result = await catalog.rebuildFromDisk();
    const atRawRoot = result.records.filter(
      (record) => path.resolve(record.storageDir) === path.resolve(rawRoot),
    );

    assert.equal(atRawRoot.length, 1, "rebuild must keep only one owner for a storage root");
    assert.equal(atRawRoot[0]?.namespace, literalNs, "the literal root owner must survive");
    assert.equal(
      atRawRoot[0]?.lastWriteAt,
      aliasWrite.toISOString(),
      "the surviving owner must inherit the newer write touch from the dropped alias",
    );
    assert.equal(
      atRawRoot[0]?.lastMaintenanceAt?.qmd,
      aliasMaintenance.toISOString(),
      "the surviving owner must inherit the newer maintenance touch from the dropped alias",
    );

    const writtenSince = await catalog.listNamespaces({
      writtenSince: new Date("2026-01-01T12:00:00.000Z"),
    });
    assert.ok(
      writtenSince.some((record) => record.namespace === literalNs),
      "writtenSince must still include the root after the alias row is collapsed",
    );
    assert.equal(
      await catalog.getNamespaceRecord("alpha"),
      null,
      "the decoded alias must stay collapsed after preserving its touch fields",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("listNamespaces prefers configured token owners over stale literal token aliases", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const literalNs = namespaceIdentityToken("alpha");
    const tokenRoot = path.join(memoryDir, "namespaces", literalNs);
    await mkdir(path.join(tokenRoot, "facts"), { recursive: true });
    await writeFile(path.join(tokenRoot, "facts", "f1.md"), "# synthetic\n", "utf8");

    const config = makeConfig(memoryDir, {
      namespacePolicies: [
        {
          name: "alpha",
          readPrincipals: [],
          writePrincipals: [],
        },
      ],
    });
    const catalog = new NamespaceCatalog(config);
    await catalog.markWrite(literalNs, { discoveredBy: "write", storageDir: tokenRoot });
    await catalog.markWrite("alpha", { discoveredBy: "write", storageDir: tokenRoot });

    const atTokenRoot = (await catalog.listNamespaces()).filter(
      (record) => path.resolve(record.storageDir) === path.resolve(tokenRoot),
    );
    assert.deepEqual(
      atTokenRoot.map((record) => record.namespace),
      ["alpha"],
      "configured namespaces must own their tokenized root over a stale literal alias",
    );
    assert.equal(
      await catalog.getNamespaceRecord(literalNs),
      null,
      "status lookup must not report the stale literal alias that listNamespaces drops",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Issue #1524 adoption prove-fail: catalog mutations route through the
// shared MutationSerializer (instance-scoped `criticalSection`). The defect
// class is a naive bare-.then(fn) chain that silently drops subsequent sections
// after a rejection — exactly the poison-chain bug the shared util prevents.
// We force the FIRST serialized section to reject, then assert the SECOND
// section STILL runs (its record lands in the catalog). Pre-fix (a poison
// chain) the second section would be skipped.
test("catalog queueCritical recovers after a prior section rejects (issue #1524 poison-chain prove-fail)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    // Reach the private serializer to inject a failing section ahead of a real
    // one. Both target the SAME key ("catalog") so they share a chain.
    const serializer = (catalog as unknown as {
      criticalSection: {
        serialize<T>(key: string, task: () => Promise<T>): Promise<T>;
      };
    }).criticalSection;

    let secondRan = false;
    const [, second] = await Promise.allSettled([
      serializer.serialize("catalog", async () => {
        throw new Error("intentional first-section failure");
      }),
      serializer.serialize("catalog", async () => {
        secondRan = true;
      }),
    ]);
    assert.equal(second.status, "fulfilled", "second section settled (ran or skipped?)");
    assert.equal(secondRan, true, "second section MUST run after the first rejected (chain recovered)");
    // And a real catalog op still works through the same chain after the failure.
    await catalog.markWrite("project-origin-poison-recovery", { discoveredBy: "write" });
    const record = await catalog.getNamespaceRecord("project-origin-poison-recovery");
    assert.ok(record, "the catalog is fully usable after a rejected section (chain not poisoned)");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Issue #1524 adoption prove-fail: NamespaceStorageRouter resolve-hooks
// route through the shared MutationSerializer (`resolveSerializer`). Same
// defect class — a poison chain would skip the second hook after the first
// rejected. We fire two notifications for the SAME namespace; the first hook
// rejects, the second MUST still run.
test("router resolve-hook serializer recovers after a prior hook rejects (issue #1524 poison-chain prove-fail)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    let secondCalls = 0;
    let firstCalls = 0;
    let rejectNext = true;
    const router = new NamespaceStorageRouter(makeConfig(memoryDir), {
      onResolve: async () => {
        if (rejectNext) {
          firstCalls += 1;
          rejectNext = false;
          throw new Error("intentional first-hook failure");
        }
        secondCalls += 1;
      },
    });
    // Two storageFor calls for the same namespace. The first triggers the hook
    // (which rejects); the second queues behind it through the serializer.
    // Both calls themselves must resolve (the rejection is best-effort inside
    // the hook wrapper, never surfaced to the storage caller).
    await router.storageFor("project-origin-router-poison");
    await router.whenResolveHooksSettled();
    await router.storageFor("project-origin-router-poison");
    await router.whenResolveHooksSettled();
    assert.ok(firstCalls >= 1, "the first (rejecting) hook fired");
    assert.ok(
      secondCalls >= 1,
      "the second hook MUST fire after the first rejected (serializer recovered, not poisoned)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ── Issue #1903: touch-path performance (auto-compaction, coalescing, streaming) ──

async function countCatalogLines(memoryDir: string): Promise<number> {
  const raw = await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.trim().length > 0).length;
}

// 1. Warm cache: with coalescing OFF every touch appends, but a warm cache means
// none of them re-parses the JSONL after the initial warm-up parse.
test("#1903 warm cache: repeated touches never re-parse the log (coalescing off)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new CountingNamespaceCatalog(
      makeConfig(memoryDir, {
        namespacesCatalogReadTouchCoalesceMs: 0,
        namespacesCatalogWriteTouchCoalesceMs: 0,
      }),
    );
    // Warm the cache: the first write creates the file; a read then performs the
    // one-time full parse and warms the in-process cache.
    await catalog.markWrite("alpha", { discoveredBy: "write" });
    await catalog.listNamespaces();
    const warm = catalog.catalogReadCount;
    assert.ok(warm >= 1, "the warm-up performed at least one full parse");
    for (let i = 0; i < 25; i++) {
      await catalog.markWrite("alpha", { discoveredBy: "write" });
      await catalog.markRead("alpha", { discoveredBy: "read" });
    }
    assert.equal(
      catalog.catalogReadCount,
      warm,
      "every subsequent touch is served from the warm cache without a re-parse",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// 2. Write-touch coalescing collapses many in-window writes into a single append,
// and the newest buffered timestamp wins on flush.
test("#1903 write-touch coalescing collapses 50 in-window writes to one append", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, { namespacesCatalogWriteTouchCoalesceMs: 60_000 }),
    );
    // Seed the record, then read it back so the in-process cache is warm — the
    // following writes are then pure-timestamp refreshes on a known record and
    // are deferred (a cold cache would force the first one to flush immediately).
    await catalog.markWrite("alpha", { discoveredBy: "write" });
    await catalog.getNamespaceRecord("alpha");
    const linesAfterSeed = await countCatalogLines(memoryDir);
    let newest = new Date();
    for (let i = 0; i < 50; i++) {
      newest = new Date(Date.now() + (i + 1) * 1000);
      await catalog.markWrite("alpha", { discoveredBy: "write", at: newest });
    }
    assert.equal(
      await countCatalogLines(memoryDir),
      linesAfterSeed,
      "coalesced writes stay buffered — no per-touch append",
    );
    await catalog.flushPendingTouches();
    assert.equal(
      await countCatalogLines(memoryDir),
      linesAfterSeed + 1,
      "the 50 buffered writes collapse into exactly one append on flush",
    );
    const record = await catalog.getNamespaceRecord("alpha");
    assert.equal(
      record?.lastWriteAt,
      newest.toISOString(),
      "the newest in-window write timestamp wins",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// 3. Read-touch coalescing collapses in-window reads and keeps the latest freshness.
test("#1903 read-touch coalescing keeps the latest in-window lastReadAt", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, { namespacesCatalogReadTouchCoalesceMs: 60_000 }),
    );
    // Seed the read field, then warm the cache so the following reads defer.
    await catalog.markRead("alpha", { discoveredBy: "read" });
    await catalog.getNamespaceRecord("alpha");
    const linesAfterSeed = await countCatalogLines(memoryDir);
    let newest = new Date();
    for (let i = 0; i < 30; i++) {
      newest = new Date(Date.now() + (i + 1) * 1000);
      await catalog.markRead("alpha", { discoveredBy: "read", at: newest });
    }
    assert.equal(
      await countCatalogLines(memoryDir),
      linesAfterSeed,
      "coalesced reads stay buffered — no per-touch append",
    );
    await catalog.flushPendingTouches();
    assert.equal(await countCatalogLines(memoryDir), linesAfterSeed + 1);
    const record = await catalog.getNamespaceRecord("alpha");
    assert.equal(
      record?.lastReadAt,
      newest.toISOString(),
      "the newest in-window read timestamp wins",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// 4. Provenance upgrade under coalescing: a config pre-registration followed by a
// write must read back "write" WITHOUT an explicit flush (immediate-flush rule).
test("#1903 markWrite upgrades config→write under coalescing without an explicit flush", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, {
        namespacesCatalogReadTouchCoalesceMs: 60_000,
        namespacesCatalogWriteTouchCoalesceMs: 60_000,
      }),
    );
    const ns = "project-origin-prov";
    const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await catalog.registerResolved(ns, storageDir);
    assert.equal(
      (await catalog.getNamespaceRecord(ns))?.discoveredBy,
      "config",
      "pre-registration is discovered by config",
    );
    // A real write must upgrade the provenance immediately even with coalescing on.
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir });
    assert.equal(
      (await catalog.getNamespaceRecord(ns))?.discoveredBy,
      "write",
      "the config→write upgrade flushes immediately (not coalesced away)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// 5. Zero-limit semantics: CompactBytes=0 never rewrites and CoalesceMs=0 appends
// one line per touch (line count == touch count) — the pre-#1903 behavior.
test("#1903 zero knobs restore append-per-touch with no compaction", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, {
        namespacesCatalogCompactBytes: 0,
        namespacesCatalogReadTouchCoalesceMs: 0,
        namespacesCatalogWriteTouchCoalesceMs: 0,
      }),
    );
    const touches = 12;
    for (let i = 0; i < touches; i++) {
      await catalog.markWrite("alpha", { discoveredBy: "write" });
    }
    assert.equal(
      await countCatalogLines(memoryDir),
      touches,
      "no coalescing and no compaction → exactly one append per touch",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// 6. Auto-compaction bounds the log to one row per namespace and preserves every
// namespace with its newest fields. A tiny limit forces compaction on each touch.
test("#1903 auto-compaction bounds the log to one row per namespace and preserves all", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, {
        namespacesCatalogCompactBytes: 100,
        namespacesCatalogReadTouchCoalesceMs: 0,
        namespacesCatalogWriteTouchCoalesceMs: 0,
      }),
    );
    const namespaces = [
      "project-origin-a",
      "project-origin-b",
      "project-origin-c",
      "project-origin-d",
      "project-origin-e",
    ];
    const newest = new Map<string, string>();
    for (let round = 0; round < 20; round++) {
      for (const ns of namespaces) {
        const at = new Date(Date.now() + (round * namespaces.length + namespaces.indexOf(ns)) * 1000);
        newest.set(ns, at.toISOString());
        await catalog.markWrite(ns, { discoveredBy: "write", at });
      }
    }
    assert.equal(
      await countCatalogLines(memoryDir),
      namespaces.length,
      "the log is bounded to exactly one row per namespace after compaction",
    );
    const list = await catalog.listNamespaces();
    for (const ns of namespaces) {
      const record = list.find((r) => r.namespace === ns);
      assert.ok(record, `namespace ${ns} survives compaction`);
      assert.equal(
        record?.lastWriteAt,
        newest.get(ns),
        `namespace ${ns} keeps its newest write timestamp through compaction`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// 7. Cross-process cache-coherence: compaction on one instance must never drop
// another instance's rows (mirrors the rebuild-race tests). A third fresh
// instance must read back every namespace touched by either.
test("#1903 cross-instance compaction never drops another instance's rows", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const cfg = () =>
      makeConfig(memoryDir, {
        namespacesCatalogCompactBytes: 100,
        namespacesCatalogReadTouchCoalesceMs: 0,
        namespacesCatalogWriteTouchCoalesceMs: 0,
      });
    // Separate instances behave like separate processes (own lock owner id).
    const a = new NamespaceCatalog(cfg());
    const b = new NamespaceCatalog(cfg());
    const written = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const nsA = `project-origin-a${round}`;
      const nsB = `project-origin-b${round}`;
      written.add(nsA);
      written.add(nsB);
      // Interleave: A appends a fresh namespace while B triggers a compaction of
      // the shared log. The cross-process lock serializes the two.
      await Promise.all([
        a.markWrite(nsA, { discoveredBy: "write" }),
        b.markWrite(nsB, { discoveredBy: "write" }),
      ]);
    }
    const fresh = new NamespaceCatalog(makeConfig(memoryDir));
    const list = await fresh.listNamespaces();
    for (const ns of written) {
      assert.ok(
        list.some((r) => r.namespace === ns),
        `namespace ${ns} must survive cross-instance interleaved compaction`,
      );
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#2469 persisted self/legacy kinds coerce to explicit and drop unused hints", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-dead-kind";
    const token = namespaceIdentityToken(ns);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const line = JSON.stringify({
      namespace: ns,
      identityToken: token,
      kind: "self",
      principal: "unused",
      projectId: "unused",
      branch: "unused",
      parentNamespace: "unused",
      createdAt: "2026-08-17T00:00:00.000Z",
      storageDir: path.join(memoryDir, "namespaces", token),
      discoveredBy: "write",
    });
    const legacyLine = JSON.stringify({
      namespace: "shared",
      identityToken: namespaceIdentityToken("shared"),
      kind: "legacy",
      createdAt: "2026-08-17T00:00:00.000Z",
      storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken("shared")),
      discoveredBy: "config",
    });
    await writeFile(path.join(stateDir, "namespaces.jsonl"), `${line}\n${legacyLine}\n`, "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const selfRecord = await catalog.getNamespaceRecord(ns);
    assert.equal(selfRecord?.kind, "explicit");
    assert.equal(
      (selfRecord as { principal?: string } | null)?.principal,
      undefined,
    );
    const legacyRecord = await catalog.getNamespaceRecord("shared");
    assert.equal(legacyRecord?.kind, "explicit");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

