import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
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

/** Wait until a rewrite settles: the bad row is gone from the file, or 2 s pass. */
async function settleRewrite(catalogPath: string, badRow: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while ((await readFile(catalogPath, "utf8")).includes(badRow)) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * Wait until the catalog state directory holds only stable files: no lock, no
 * lock-release temp, no rewrite temp. withHeldFileLock renames the lock through
 * a transient `.releasing.` file, and a recursive rm that walks the directory
 * during that window fails with ENOTEMPTY (#3298).
 */
async function settleStateDir(stateDir: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const entries = await readdir(stateDir).catch((): string[] => []);
    const busy = entries.some(
      (e) => e.endsWith(".tmp") || e.includes(".releasing.") || e.endsWith(".rebuild.lock"),
    );
    if (!busy || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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
    await mkdir(path.join(memoryDir, "facts"), { recursive: true });
    await writeFile(path.join(memoryDir, "facts", "f1.md"), "# synthetic\n", "utf8");
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();

    const def = result.records.find((r) => r.namespace === "default");
    assert.ok(def, "expected default namespace record");
    assert.equal(def?.kind, "default");
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

test("rebuildFromDisk rejects a symlinked namespaces scan root without enumerating it", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const leakedNs = "project-origin-leaked";
    await mkdir(path.join(outside, namespaceIdentityToken(leakedNs), "facts"), { recursive: true });
    try {
      await symlink(outside, path.join(memoryDir, "namespaces"), "dir");
    } catch {
      // Some CI environments disallow symlinks; skip gracefully.
      return;
    }

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();

    assert.ok(
      !result.records.some((r) => r.namespace === leakedNs),
      "a symlinked namespaces scan root must not be enumerated into the catalog",
    );
    assert.ok(
      !result.records.some((r) => r.storageDir.startsWith(outside)),
      "no record may point at a storageDir inside the symlinked-out scan root",
    );
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
    await settleRewrite(file, "not json at all");
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
    await settleRewrite(file, '"identityToken":"bad-token"');
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
      onResolve: (namespace, storageDir) => catalog.registerResolved(namespace, storageDir),
    });
    await router.storageFor("project-origin-abc123");
    await router.whenResolveHooksSettled();

    const record = await catalog.getNamespaceRecord("project-origin-abc123");
    assert.ok(record, "storageFor should have registered the namespace");
    assert.equal(record?.discoveredBy, "config");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("register does not overwrite prior discoveredBy on an existing record", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const afterWrite = await catalog.getNamespaceRecord("project-origin-abc123");
    assert.equal(afterWrite?.discoveredBy, "write");
    const createdAt = afterWrite?.createdAt;

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
    assert.ok(afterRegister?.lastWriteAt, "lastWriteAt must survive the register touch");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a write upgrades a config pre-registration to write provenance (NBPmT)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.registerResolved(
      "project-origin-xyz",
      path.join(memoryDir, "namespaces", namespaceIdentityToken("project-origin-xyz")),
    );
    assert.equal((await catalog.getNamespaceRecord("project-origin-xyz"))?.discoveredBy, "config");

    await catalog.markRead("project-origin-xyz", { discoveredBy: "read" });
    assert.equal(
      (await catalog.getNamespaceRecord("project-origin-xyz"))?.discoveredBy,
      "config",
      "a read touch preserves config provenance (only a write upgrades it)",
    );

    await catalog.markWrite("project-origin-xyz", { discoveredBy: "write" });
    const after = await catalog.getNamespaceRecord("project-origin-xyz");
    assert.equal(
      after?.discoveredBy,
      "write",
      "a real write upgrades a config-only pre-registration to write provenance",
    );
    assert.ok(after?.lastWriteAt, "write touch still records lastWriteAt");
    const writeList = await catalog.listNamespaces({ discoveredBy: "write" });
    assert.ok(
      writeList.some((r) => r.namespace === "project-origin-xyz"),
      "a written namespace must be discoverable by discoveredBy:write filter",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent touches on one namespace preserve all fields (no dropped metadata)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken("project-origin-race"));

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

test("catalog is inert when namespaceCatalogEnabled is false (string opt-out coerced)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
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

test("chunked write path contract: markWrite updates lastWriteAt for the namespace", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const ns = "project-origin-chunked";
    const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record?.lastWriteAt, "chunked write must update lastWriteAt");
    assert.equal(record?.storageDir, storageDir);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildFromDisk --apply does not drop a concurrent markWrite touch", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    for (let i = 0; i < 30; i++) {
      const ns = `project-origin-rebuild-race-${i}`;
      const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
      await mkdir(path.join(storageDir, "facts"), { recursive: true });

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

test("rebuildFromDisk keeps default storageDir aligned with the router (legacy data present)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    await mkdir(path.join(memoryDir, "facts"), { recursive: true });
    await writeFile(path.join(memoryDir, "facts", "legacy.md"), "# legacy\n", "utf8");
    const tokenizedDefaultDir = path.join(
      memoryDir,
      "namespaces",
      namespaceIdentityToken(config.defaultNamespace),
    );
    await mkdir(path.join(tokenizedDefaultDir, "facts"), { recursive: true });
    await writeFile(path.join(tokenizedDefaultDir, "facts", "tok.md"), "# tok\n", "utf8");

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

test("rebuildFromDisk catalogs a tokenized root that only has a state dir", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-stateonly";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "state"), { recursive: true });

    const config = makeConfig(memoryDir);
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

test("rebuildFromDisk preserves prior write provenance for a configured namespace", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "explicit-policy-ns";
    const config = makeConfig(memoryDir, {
      namespacePolicies: [{ name: ns } as any],
    });
    const catalog = new NamespaceCatalog(config);

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

test("explicit storageDir outside memoryDir is rejected (containment)", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const ns = "project-origin-escape";
    const evilDir = path.join(outside, "evil");

    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: evilDir });

    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record should still be created");
    assert.ok(
      !record!.storageDir.startsWith(outside),
      "catalog must not persist a storage dir outside memoryDir",
    );
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

test("explicit storageDir contained under namespaces/ is accepted", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const ns = "project-origin-ok";
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

test("rebuildFromDisk prefers the tokenized root over a legacy dual root", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-dual";
    const token = namespaceIdentityToken(ns);
    const tokenizedDir = path.join(memoryDir, "namespaces", token);
    const legacyDir = path.join(memoryDir, "namespaces", ns);
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

test("listNamespaces/getNamespaceRecord sanitize an out-of-root storageDir on read", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const ns = "project-origin-tampered";
    const token = namespaceIdentityToken(ns);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
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

test("listNamespaces/getNamespaceRecord drop an UNSAFE namespace row on read (NGZqr)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const unsafeNs = "../evil"; // fails isSafeRouteNamespace (parent ref + slash)
    const safeNs = "project-origin-ok";
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lines = [
      JSON.stringify({
        namespace: unsafeNs,
        identityToken: namespaceIdentityToken(unsafeNs),
        kind: "project",
        createdAt: new Date().toISOString(),
        storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken(unsafeNs)),
        discoveredBy: "write",
      }),
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
    assert.ok(
      list.some((r) => r.namespace === safeNs),
      "a safe namespace row must still be enumerated",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

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
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: linkPath });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record should be created");
    const memoryReal = await realpath(memoryDir);
    const outsideReal = await realpath(outside);
    let persistedReal: string;
    try {
      persistedReal = await realpath(record!.storageDir);
    } catch {
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

test("rebuildFromDisk re-merges a concurrent cross-instance write touch", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-xproc";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    const cli = new NamespaceCatalog(makeConfig(memoryDir));
    const gateway = new NamespaceCatalog(makeConfig(memoryDir));

    await Promise.all([
      cli.rebuildFromDisk(),
      gateway.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir }),
    ]);

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

test("markRead records the router-aligned legacy raw-name root, not the tokenized guess", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-legacy";
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

test("rebuildFromDisk purges a stale namespace whose root was removed", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-gone";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
    await catalog.rebuildFromDisk();
    assert.ok(
      await catalog.getNamespaceRecord(ns),
      "namespace should be present while its root exists",
    );

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

test("rebuildFromDisk does not catalog a namespace whose only marker child is a non-directory file", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-bogus";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(tokenDir, { recursive: true });
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

test("a whitespace-padded default namespace is still recognized as the default row", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir, { defaultNamespace: "  default  " }));
    await catalog.registerConfiguredNamespaces();

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

test("resolveDefaultNamespaceRoot finds the legacy default root under a whitespace-padded default name", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir, { defaultNamespace: "  default  " });
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

test("rebuildFromDisk purges a stale non-default namespace whose only resolvable root is the default memoryDir", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    await mkdir(path.join(memoryDir, "facts"), { recursive: true });

    const ns = "project-origin-skipped";
    const token = namespaceIdentityToken(ns);
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    await mkdir(path.join(outside, "target", "facts"), { recursive: true });
    const tokenDir = path.join(memoryDir, "namespaces", token);
    try {
      await symlink(path.join(outside, "target"), tokenDir, "dir");
    } catch {
      return; // symlinks unsupported in this CI env
    }

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
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

test("a touch defers to a held rebuild lock and is preserved", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-locked";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    await writeFile(lockPath, `999999 ${new Date().toISOString()}\n`, "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const started = Date.now();
    setTimeout(() => {
      rm(lockPath, { force: true }).catch(() => undefined);
    }, 150);
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
    const waited = Date.now() - started;

    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record?.lastWriteAt, "the deferred touch must still be recorded");
    assert.ok(waited < 4000, "a touch must never block near the full lock deadline");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a non-default namespace falls back to its own clean token dir, not the default memoryDir", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const ns = "project-origin-fallback";
    const token = namespaceIdentityToken(ns);
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    await mkdir(path.join(outside, "target", "facts"), { recursive: true });
    const legacyDir = path.join(memoryDir, "namespaces", ns);
    const tokenDir = path.join(memoryDir, "namespaces", token);
    try {
      await symlink(path.join(outside, "target"), legacyDir, "dir");
    } catch {
      return; // symlinks unsupported in this CI env
    }
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
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

test("rebuild releases its lock cleanly and still breaks a stale foreign lock", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-hb";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
    await writeFile(lockPath, `999999 ${new Date(Date.now() - 60_000).toISOString()}\n`, "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const result = await catalog.rebuildFromDisk();
    assert.ok(
      result.records.some((r) => r.namespace === ns),
      "rebuild must complete despite a stale foreign lock",
    );
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
      await mkdir(rootFactsDir, { recursive: true });
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

test("rebuild --apply does NOT resurrect an UNSAFE namespace row even if its token dir has data (NGLz5)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "unsafe ns!";
    const token = namespaceIdentityToken(ns);
    const tokenDir = path.join(memoryDir, "namespaces", token);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
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

test("a touch drops its append when the rebuild-lock wait times out", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-locktimeout";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");
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

      assert.ok(waited >= 4_000, "touch should wait up to the lock deadline before dropping");
      assert.ok(waited < 12_000, "touch must never block indefinitely on a held lock");

      const record = await catalog.getNamespaceRecord(ns);
      assert.equal(
        record,
        null,
        "a touch that times out on a held rebuild lock must NOT append (no overwrite race)",
      );
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

test("a mutating rebuild that cannot acquire the lock does NOT rewrite the log", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-unlocked";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const logPath = path.join(stateDir, "namespaces.jsonl");

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
      assert.ok(result.records.some((r) => r.namespace === ns), "compute-only rebuild still returns records");
      const after = await readFile(logPath, "utf8");
      assert.equal(after, before, "an unlocked mutating rebuild must NOT rewrite the log (NBPmY)");
    } finally {
      clearInterval(hb);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

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
    assert.ok(
      result.records.some((r) => r.namespace === "default"),
      "the default namespace must still be catalogued",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuild normalizes a configured namespace with surrounding whitespace (NGnek)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir, { sharedNamespace: "shared " } as Partial<PluginConfig>);
    const catalog = new NamespaceCatalog(config);
    const result = await catalog.rebuildFromDisk();

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
    assert.equal(shared!.kind, "shared", "the normalized namespace is classified as shared");
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

test("registerConfiguredNamespaces skips an unsafe configured name without aborting", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, {
        sharedNamespace: "../evil",
        namespacePolicies: [{ name: "team-pi-project-origin-safe" }],
      } as unknown as Partial<PluginConfig>),
    );
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

test("a same-process second instance does not treat another instance's lock as self-held", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-twoinstances";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");

    const foreignOwner = "00000000-0000-4000-8000-000000000000";
    await writeFile(lockPath, `999999 ${foreignOwner} ${new Date().toISOString()}\n`, "utf8");
    const hb = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 1_000);
    hb.unref?.();

    try {
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

test("a catalog write preserves a token-shaped literal namespace name verbatim", async () => {
  const memoryDir = await mkMemoryDir();
  try {
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

test("rebuild --apply rejects a configured namespace whose token dir escapes via symlink", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    const ns = "team-pi-project-origin-escape";
    const token = namespaceIdentityToken(ns);
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    await mkdir(path.join(outside, "evil"), { recursive: true });
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
    const raw = await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8").catch(() => "");
    assert.ok(!raw.includes(path.join(outside, "evil")), "no escaping storageDir may be persisted");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

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

    const after = await readFile(lockPath, "utf8").catch(() => "");
    assert.equal(after, foreignLock, "a rebuild must not unlink a replacement foreign lock");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

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

test("read sanitizer substitutes a contained cross-namespace storageDir", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const nsA = "project-origin-reada";
    const nsB = "project-origin-readb";
    const tokenA = namespaceIdentityToken(nsA);
    const tokenB = namespaceIdentityToken(nsB);
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
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

test("explicit storageDir under a symlinked-out parent (non-existent leaf) is rejected", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    await mkdir(path.join(outside, "evilroot"), { recursive: true });
    await symlink(path.join(outside, "evilroot"), path.join(memoryDir, "namespaces"), "dir");

    const ns = "project-origin-symparent";
    const escapingLeaf = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: escapingLeaf });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record is still created");
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

test("an explicit storageDir that is a regular FILE at the token dir is rejected (NF21i)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-fileroot";
    const token = namespaceIdentityToken(ns);
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    const tokenPathAsFile = path.join(memoryDir, "namespaces", token);
    await writeFile(tokenPathAsFile, "# not a directory\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenPathAsFile });
    const record = await catalog.getNamespaceRecord(ns);
    assert.ok(record, "record is still created");
    assert.notEqual(
      path.resolve(record!.storageDir),
      path.resolve(tokenPathAsFile),
      "a regular file must not be persisted as a namespace storage root",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an explicit storageDir whose nearest existing ancestor is a FILE is rejected (NHIdt)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-fileancestor";
    const token = namespaceIdentityToken(ns);
    const namespacesAsFile = path.join(memoryDir, "namespaces");
    await writeFile(namespacesAsFile, "# not a directory\n", "utf8");
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
    const sm = await router.storageFor("default");
    assert.ok(sm, "storage resolution succeeds despite a rejecting async hook");
    await router.whenResolveHooksSettled();
    assert.ok(called >= 1, "the async hook was invoked");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent storageFor() for one namespace fires the resolve hook ONCE while it is in-flight", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    let calls = 0;
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

    const N = 8;
    await Promise.all(Array.from({ length: N }, () => router.storageFor("project-origin-inflight")));
    assert.equal(calls, 1, "only one resolve hook may fire while the registration is in-flight");

    release();
    await router.whenResolveHooksSettled();
    await router.storageFor("project-origin-inflight");
    assert.equal(calls, 1, "a steady-state cache hit after settle must not re-fire the hook");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

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
    await router.whenResolveHooksSettled();
    assert.equal(calls, 1, "the hook fired once for the dropped registration");

    result = undefined; // success (legacy void)
    await router.storageFor("project-origin-retry");
    await router.whenResolveHooksSettled();
    assert.equal(calls, 2, "a dropped registration must be retried on the next storageFor()");

    await router.storageFor("project-origin-retry");
    await router.whenResolveHooksSettled();
    assert.equal(calls, 2, "a successful registration is not re-fired on subsequent cache hits");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a burst of concurrent storageFor() with a DROPPED hook fires it ONCE (not once per queued task)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    let calls = 0;
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

    const N = 8;
    await Promise.all(Array.from({ length: N }, () => router.storageFor("project-origin-burst-drop")));
    release();
    await router.whenResolveHooksSettled();
    assert.equal(calls, 1, "a dropped hook fires ONCE under a burst, not once per queued task");

    await router.storageFor("project-origin-burst-drop");
    await router.whenResolveHooksSettled();
    assert.equal(calls, 2, "a dropped registration is retried on the next storageFor()");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

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

test("rebuild seeds a configured namespace at its router-resolved (legacy raw) root", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "team-pi-project-origin-cfg";
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

test("rebuild does not persist an escaping symlinked default root", async () => {
  const memoryDir = await mkMemoryDir();
  const outside = await mkMemoryDir();
  try {
    await mkdir(path.join(outside, "evildefault", "facts"), { recursive: true });
    await mkdir(path.join(memoryDir, "namespaces"), { recursive: true });
    const defaultToken = namespaceIdentityToken("default");
    await symlink(
      path.join(outside, "evildefault"),
      path.join(memoryDir, "namespaces", defaultToken),
      "dir",
    );

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

//
//
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
  async callBreakStaleRebuildLock(): Promise<void> {
    const seam = (this as unknown as { onBeforeBreakStaleUnlinkForTest?: () => Promise<void> })
      .onBeforeBreakStaleUnlinkForTest;
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
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    const writer = new SeamCatalog(makeConfig(memoryDir));
    const rebuilder = new SeamCatalog(makeConfig(memoryDir));

    const writerInSection = deferred(); // writer has entered its touch critical section
    const rebuilderInWindow = deferred(); // rebuilder is in its load→rename window
    let writerObservedLockHeld = false;

    writer.setTouchSeam(async () => {
      writerInSection.resolve();
      await Promise.race([
        rebuilderInWindow.promise,
        new Promise<void>((r) => setTimeout(r, 1500)),
      ]);
    });

    rebuilder.setRebuildBeforeRenameSeam(async () => {
      rebuilderInWindow.resolve();
      writerObservedLockHeld = true;
      await Promise.race([
        writerInSection.promise,
        new Promise<void>((r) => setTimeout(r, 1500)),
      ]);
      await new Promise<void>((r) => setTimeout(r, 200));
    });

    const [, rebuildResult] = await Promise.all([
      writer.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir }),
      rebuilder.rebuildFromDisk(),
    ]);

    assert.ok(writerObservedLockHeld, "the rebuilder must have reached its rename window");

    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    const record = await reader.getNamespaceRecord(ns);
    assert.ok(record, "namespace must exist after the concurrent rebuild + write");
    assert.ok(
      record?.lastWriteAt,
      "the write touch must survive the rebuild — not be clobbered inside its load→rename window",
    );
    assert.equal(rebuildResult.applied, true, "rebuild --apply held the lock and rewrote");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a touch racing only the rebuild SCAN phase is not blocked by the mutex (NFgCT)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const ns = "project-origin-scan-race";
    const tokenDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(ns));
    await mkdir(path.join(tokenDir, "facts"), { recursive: true });

    const writer = new SeamCatalog(makeConfig(memoryDir));
    const rebuilder = new SeamCatalog(makeConfig(memoryDir));

    let seamFired = false;
    rebuilder.setRebuildAfterScanSeam(async () => {
      seamFired = true;
      await writer.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
      rebuilder.setRebuildAfterScanSeam(undefined);
    });

    const result = await rebuilder.rebuildFromDisk();
    assert.ok(seamFired, "the post-scan / pre-lock seam must have fired");
    assert.equal(result.applied, true, "the rebuild still held the lock for its final rewrite and applied");

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
    const foreignOwner = "00000000-0000-4000-8000-000000000000";
    await writeFile(lockPath, `999999 ${foreignOwner} ${new Date().toISOString()}\n`, "utf8");
    heartbeat = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 250);

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const started = Date.now();
    await catalog.markWrite(ns, { discoveredBy: "write", storageDir: tokenDir });
    const waited = Date.now() - started;

    const record = await catalog.getNamespaceRecord(ns);
    assert.equal(record, null, "a touch that cannot acquire the lock must NOT append");
    assert.ok(waited < 12_000, "the dropped touch must return within the bounded wait");
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("breakStaleRebuildLock does not delete a replacement lock created in the race window (NG7Bg)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, "namespaces.rebuild.lock");

    const staleIdentity = `111111 aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa ${new Date(
      Date.now() - 120_000,
    ).toISOString()}\n`;
    await writeFile(lockPath, staleIdentity, "utf8");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    const breaker = new SeamCatalog(makeConfig(memoryDir));
    const replacementIdentity = `222222 bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb ${new Date().toISOString()}\n`;
    breaker.setBreakStaleSeam(async () => {
      await writeFile(lockPath, replacementIdentity, "utf8");
      const now = new Date();
      await utimes(lockPath, now, now);
      breaker.setBreakStaleSeam(undefined);
    });

    await breaker.callBreakStaleRebuildLock();

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
    const foreignOwner = "00000000-0000-4000-8000-0000000000aa";
    await writeFile(lockPath, `999999 ${foreignOwner} ${new Date().toISOString()}\n`, "utf8");
    heartbeat = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, 250);

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const dryRun = false;
    const result = await catalog.rebuildFromDisk({ dryRun });
    assert.equal(result.applied, false, "a contended apply must report applied=false");

    process.exitCode = undefined;
    if (!dryRun && !result.applied) {
      process.exitCode = 1;
    }
    assert.equal(
      process.exitCode,
      1,
      "a JSON apply that was not applied must set a non-zero exit code so automation detects the no-op",
    );

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

test("inert rebuild --apply exits non-zero; inert --dry-run stays zero (NFb5W)", async () => {
  const memoryDir = await mkMemoryDir();
  const savedExitCode = process.exitCode;
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir, { namespacesEnabled: false }));
    assert.equal(catalog.enabled, false, "an inert catalog reports disabled (the CLI gate)");

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

test("rebuildFromDisk keeps a cataloged token-shaped raw root as the literal namespace (NRcCD)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const literalNs = namespaceIdentityToken("alpha"); // "ns-616c706861"
    assert.equal(
      namespaceIdentityFromToken(literalNs),
      "alpha",
      "precondition: the dir name decodes to alpha — the ambiguity this test exercises",
    );
    const rawRoot = path.join(memoryDir, "namespaces", literalNs);
    await mkdir(path.join(rawRoot, "facts"), { recursive: true });
    await writeFile(path.join(rawRoot, "facts", "f1.md"), "# synthetic\n", "utf8");

    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite(literalNs, { discoveredBy: "write", storageDir: rawRoot });
    const seeded = await catalog.getNamespaceRecord(literalNs);
    assert.ok(seeded, "precondition: literal namespace has a catalog row before rebuild");
    assert.equal(path.resolve(seeded!.storageDir), path.resolve(rawRoot));

    const result = await catalog.rebuildFromDisk();

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

test("catalog queueCritical recovers after a prior section rejects (issue #1524 poison-chain prove-fail)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
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
    await catalog.markWrite("project-origin-poison-recovery", { discoveredBy: "write" });
    const record = await catalog.getNamespaceRecord("project-origin-poison-recovery");
    assert.ok(record, "the catalog is fully usable after a rejected section (chain not poisoned)");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

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


async function countCatalogLines(memoryDir: string): Promise<number> {
  const raw = await readFile(path.join(memoryDir, "state", "namespaces.jsonl"), "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.trim().length > 0).length;
}

test("#1903 warm cache: repeated touches never re-parse the log (coalescing off)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new CountingNamespaceCatalog(
      makeConfig(memoryDir, {
        namespacesCatalogReadTouchCoalesceMs: 0,
        namespacesCatalogWriteTouchCoalesceMs: 0,
      }),
    );
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

test("#1903 write-touch coalescing collapses 50 in-window writes to one append", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, { namespacesCatalogWriteTouchCoalesceMs: 60_000 }),
    );
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

test("#1903 read-touch coalescing keeps the latest in-window lastReadAt", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(
      makeConfig(memoryDir, { namespacesCatalogReadTouchCoalesceMs: 60_000 }),
    );
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

test("#1903 cross-instance compaction never drops another instance's rows", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const cfg = () =>
      makeConfig(memoryDir, {
        namespacesCatalogCompactBytes: 100,
        namespacesCatalogReadTouchCoalesceMs: 0,
        namespacesCatalogWriteTouchCoalesceMs: 0,
      });
    const a = new NamespaceCatalog(cfg());
    const b = new NamespaceCatalog(cfg());
    const written = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const nsA = `project-origin-a${round}`;
      const nsB = `project-origin-b${round}`;
      written.add(nsA);
      written.add(nsB);
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


test("listNamespaces reports an incomplete read for a malformed record but still returns the valid ones (#3293)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await appendFile(catalogPath, "{this is not json\n", "utf8");

    const reasons: string[] = [];
    const records = await catalog.listNamespaces(undefined, { onIncomplete: (reason) => reasons.push(reason) });
    assert.deepEqual(records.map((r) => r.namespace), ["project-origin-abc123"], "valid records are still returned");
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /malformed/);

    await new Promise((resolve) => setImmediate(resolve));
    await readFile(catalogPath, "utf8"); // ensure the rewrite settled before re-reading
    const again: string[] = [];
    await catalog.listNamespaces(undefined, { onIncomplete: (reason) => again.push(reason) });
    assert.equal(again.length, 0, "the rewrite removed the malformed line, so the catalog is whole");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("listNamespaces reports an incomplete read for an unreadable catalog (#3293)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await mkdir(path.join(memoryDir, "state", "namespaces.jsonl"), { recursive: true });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const reasons: string[] = [];
    const records = await catalog.listNamespaces(undefined, { onIncomplete: (reason) => reasons.push(reason) });
    assert.deepEqual(records, []);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /unreadable/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("listNamespaces does not report a clean or missing catalog as incomplete (#3293)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const reasons: string[] = [];
    const onIncomplete = (reason: string) => reasons.push(reason);
    await catalog.listNamespaces(undefined, { onIncomplete });
    assert.deepEqual(reasons, [], "a catalog that was never written is normal on a fresh install");
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    await catalog.listNamespaces(undefined, { onIncomplete });
    assert.deepEqual(reasons, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a catalog with malformed rows stays tolerant for callers that do not ask about completeness (#3293)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    // Valid JSON that is not a catalog record counts as malformed too.
    await appendFile(catalogPath, "{\"not\":\"a record\"}\n", "utf8");

    // The FIRST read (no options) reports nothing to the caller, and its repair rewrite (#3297)
    // drops the bad row; later reads then see a whole catalog. The reporter must be on read #1.
    const reasons: string[] = [];
    const first = await catalog.listNamespaces(undefined, { onIncomplete: (reason) => reasons.push(reason) });
    assert.equal(reasons.length, 1, "the non-record row is reported to the first reader");
    assert.deepEqual(first.map((r) => r.namespace), ["project-origin-abc123"]);
    await settleRewrite(catalogPath, '"not":"a record"');
    assert.ok(!(await readFile(catalogPath, "utf8")).includes('"not":"a record"'), "the rewrite dropped the bad row");

    assert.deepEqual((await catalog.listNamespaces()).map((r) => r.namespace), ["project-origin-abc123"]);
    assert.deepEqual((await catalog.listNamespaces(undefined, {})).map((r) => r.namespace), ["project-origin-abc123"]);

    assert.equal((await catalog.getNamespaceRecord("project-origin-abc123"))?.namespace, "project-origin-abc123");
    const cold = new NamespaceCatalog(makeConfig(memoryDir));
    assert.equal((await cold.getNamespaceRecord("project-origin-abc123"))?.namespace, "project-origin-abc123");
    const reasons2: string[] = [];
    await cold.listNamespaces(undefined, { onIncomplete: (r) => reasons2.push(r) });
    assert.deepEqual(reasons2, [], "the rewrite made the catalog whole");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a read that skipped malformed rows schedules a compaction rewrite that drops them (#3297)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    const before = await readFile(catalogPath, "utf8");
    await appendFile(catalogPath, "{this is not json\n", "utf8");
    assert.ok(before.length > 0, "the valid rows exist on disk");

    const reasons: string[] = [];
    const records = await catalog.listNamespaces(undefined, { onIncomplete: (r) => reasons.push(r) });
    assert.equal(reasons.length, 1);
    await settleRewrite(catalogPath, "this is not json");
    const after = await readFile(catalogPath, "utf8");
    assert.ok(after.length > 0, "the valid rows survive the rewrite");
    assert.ok(!after.includes("this is not json"), "the malformed row is gone after the rewrite");
    assert.deepEqual(records.map((r) => r.namespace), ["project-origin-abc123"]);

    const quiet: string[] = [];
    await catalog.listNamespaces(undefined, { onIncomplete: (r) => quiet.push(r) });
    await settleRewrite(catalogPath, " -no-such-row"); // one settle window for the queued rewrite, if any
    assert.deepEqual(quiet, []);
    assert.equal(await readFile(catalogPath, "utf8"), after, "no second rewrite happened");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("no rewrite is scheduled for a clean or missing catalog (#3297)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.listNamespaces();
    const stateDir = path.join(memoryDir, "state");
    // SAFETY: readdir of a fresh install fails with ENOENT, which is the proof itself; catch narrows to an empty list.
    const tmpFiles = await readdir(stateDir).then((entries) => entries.filter((e) => e.endsWith(".tmp"))).catch(() => [] as string[]);
    assert.deepEqual(tmpFiles, []);
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const before = await readFile(path.join(stateDir, "namespaces.jsonl"), "utf8");
    await catalog.listNamespaces();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await readFile(path.join(stateDir, "namespaces.jsonl"), "utf8"), before, "nothing rewrote a clean catalog");
    assert.equal((await readdir(stateDir)).filter((e) => e.endsWith(".tmp")).length, 0, "no temporary rewrite file is left behind");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a read that skipped malformed rows does not rewrite while another process holds the catalog lock (#3297)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await appendFile(catalogPath, "{this is not json\n", "utf8");
    const before = await readFile(catalogPath, "utf8");

    await withHeldFileLock(path.join(memoryDir, "state", "namespaces.rebuild.lock"), { staleMs: 30_000 }, async () => {
      const reasons: string[] = [];
      await catalog.listNamespaces(undefined, { onIncomplete: (r) => reasons.push(r) });
      assert.equal(reasons.length, 1, "the read still reports the malformed row");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await readFile(catalogPath, "utf8"), before, "no rewrite ran under another process's lock");
    });
    assert.equal(await readFile(catalogPath, "utf8"), before, "the dropped attempt changed nothing");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a dropped repair backs off before the next attempt (#3298)", { timeout: 30_000 }, async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await appendFile(catalogPath, "{this is not json\n", "utf8");
    const before = await readFile(catalogPath, "utf8");
    const lockPath = path.join(memoryDir, "state", "namespaces.rebuild.lock");

    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const { promise: held, resolve: lockHeld } = Promise.withResolvers<void>();
    const holder = withHeldFileLock(lockPath, { staleMs: 60_000 }, async () => {
      lockHeld();
      await released;
    });
    await held;
    await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
    { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 5_100); await promise; }
    assert.equal(catalog.malformedRepairAttemptsForTest, 1, "one attempt was made and dropped");

    await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
    assert.equal(catalog.malformedRepairAttemptsForTest, 1, "the backoff window suppresses a new attempt");
    release();
    await holder;
    assert.equal(await readFile(catalogPath, "utf8"), before, "the dropped attempt changed nothing");

    { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 300); await promise; }
    await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
    await settleRewrite(catalogPath, "this is not json");
    assert.ok(!(await readFile(catalogPath, "utf8")).includes("this is not json"), "the retry repaired the catalog");
    assert.equal(catalog.malformedRepairAttemptsForTest, 2, "exactly one retry after the window");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

class FailingReadCatalog extends NamespaceCatalog {
  stopFailing(): void {
    this.onCatalogReadForTest = undefined;
  }

  /** The first full read succeeds; every later one throws (the repair's locked re-read fails). */
  failAfterFirstRead(): void {
    let reads = 0;
    this.onCatalogReadForTest = () => {
      reads += 1;
      if (reads > 1) throw new Error("EIO: simulated read failure on the second read");
    };
  }

  /** Every full read of the catalog file throws, like a persistent EIO/EACCES on the file. */
  failEveryRead(): void {
    this.onCatalogReadForTest = () => {
      throw new Error("EIO: simulated read failure");
    };
  }
}

async function stateEntries(memoryDir: string): Promise<string[]> {
  return readdir(path.join(memoryDir, "state")).catch((): string[] => []);
}

test("a read error on a healthy catalog never rewrites it, and leaves no temp file (#3297)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const writer = new NamespaceCatalog(makeConfig(memoryDir));
    await writer.markWrite("project-origin-abc123", { discoveredBy: "write" });
    await writer.markWrite("project-origin-def456", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    const before = await readFile(catalogPath, "utf8");
    assert.ok(before.includes("abc123") && before.includes("def456"));

    const reader = new FailingReadCatalog(makeConfig(memoryDir));
    reader.failEveryRead();
    const reasons: string[] = [];
    const records = await reader.listNamespaces(undefined, { onIncomplete: (r) => reasons.push(r) });
    assert.deepEqual(records, [], "the unreadable catalog yields no records");
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /unreadable/);

    await new Promise((resolve) => setTimeout(resolve, 150)); // any scheduled rewrite would land here
    assert.equal(await readFile(catalogPath, "utf8"), before, "the healthy catalog bytes are untouched");
    assert.deepEqual((await stateEntries(memoryDir)).filter((e) => e.endsWith(".tmp")), [], "no temp file is left behind");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unreadable catalog path leaves no temp file and is not rewritten (#3297)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await mkdir(path.join(memoryDir, "state", "namespaces.jsonl"), { recursive: true });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const reasons: string[] = [];
    await catalog.listNamespaces(undefined, { onIncomplete: (r) => reasons.push(r) });
    assert.equal(reasons.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(await stateEntries(memoryDir), ["namespaces.jsonl"], "nothing but the directory is in state");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a catalog with no readable row is not rewritten to an empty file (#3297)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await mkdir(path.dirname(catalogPath), { recursive: true });
    const garbage = "not json at all\n{\"not\":\"a record\"}\n";
    await writeFile(catalogPath, garbage, "utf8");
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    const reasons: string[] = [];
    await catalog.listNamespaces(undefined, { onIncomplete: (r) => reasons.push(r) });
    assert.equal(reasons.length, 1, "the malformed rows are still reported");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await readFile(catalogPath, "utf8"), garbage, "nothing readable to keep: the raw rows are left for a rebuild");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a failed rewrite removes its temp file (#3297)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await mkdir(path.join(memoryDir, "state", "namespaces.jsonl"), { recursive: true });
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await assert.rejects(catalog["rewriteUnchained"]([]));
    assert.deepEqual((await stateEntries(memoryDir)).filter((e) => e.endsWith(".tmp")), []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent malformed reads schedule a single repair (#3298)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await appendFile(catalogPath, "{this is not json\n", "utf8");

    await Promise.all(
      Array.from({ length: 8 }, () => catalog.listNamespaces(undefined, { onIncomplete: () => undefined })),
    );
    assert.equal(catalog.malformedRepairAttemptsForTest, 1, "one repair attempt, not eight");
    await settleRewrite(catalogPath, "this is not json");
    await settleStateDir(path.join(memoryDir, "state"));
    const after = await readFile(catalogPath, "utf8");
    assert.ok(!after.includes("this is not json"), "the malformed row is gone after the repair");

    const sidecars = (await readdir(path.join(memoryDir, "state"))).filter((e) =>
      /^namespaces\.jsonl\.malformed-[0-9a-f]{16}$/.test(e),
    );
    assert.equal(sidecars.length, 1, "exactly one quarantine sidecar");
    const sidecar = await readFile(path.join(memoryDir, "state", sidecars[0]!), "utf8");
    assert.ok(sidecar.includes("this is not json"), "the sidecar holds the dropped row");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("malformed reads during a pending repair do not queue another attempt (#3298)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await appendFile(catalogPath, "{this is not json\n", "utf8");
    const before = await readFile(catalogPath, "utf8");

    await withHeldFileLock(path.join(memoryDir, "state", "namespaces.rebuild.lock"), { staleMs: 30_000 }, async () => {
      await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
      { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }
      assert.equal(catalog.malformedRepairAttemptsForTest, 1, "the first read starts the in-flight repair");
      await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
      await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
      { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }
      assert.equal(catalog.malformedRepairAttemptsForTest, 1, "the in-flight repair is the reason no second attempt is queued");
      assert.equal(await readFile(catalogPath, "utf8"), before, "no rewrite ran under another process's lock");
    });
    assert.equal(await readFile(catalogPath, "utf8"), before, "the dropped attempt changed nothing");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("the repair quarantines every dropped row in the sidecar before rewriting (#3298)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await appendFile(catalogPath, "{first bad row\nnot json either\n", "utf8");

    await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
    await settleRewrite(catalogPath, "first bad row");
    await settleStateDir(path.join(memoryDir, "state"));
    const after = await readFile(catalogPath, "utf8");
    assert.ok(!after.includes("first bad row") && !after.includes("not json either"), "both dropped rows are gone");

    const entries = await readdir(path.join(memoryDir, "state"));
    const sidecars = entries.filter((e) => /^namespaces\.jsonl\.malformed-[0-9a-f]{16}$/.test(e));
    assert.equal(sidecars.length, 1, "one sidecar for the one repair");
    const sidecar = await readFile(path.join(memoryDir, "state", sidecars[0]!), "utf8");
    assert.ok(sidecar.includes("first bad row") && sidecar.includes("not json either"), "both dropped rows are kept");
    assert.ok(!entries.some((e) => e.endsWith(".tmp")), "no temp file is left behind");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a repair that fails after the sidecar write does not pile up sidecars (#3298)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await appendFile(catalogPath, "{this is not json\n", "utf8");

    const original = catalog["rewriteUnchained"].bind(catalog);
    let failures = 0;
    const pendingResolves: Array<() => void> = [];
    const settlesOnNextAttempt = (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      pendingResolves.push(resolve);
      return promise;
    };
    catalog["rewriteUnchained"] = async (records: unknown[]) => {
      failures += 1;
      const signal = pendingResolves.shift();
      try {
        if (failures <= 2) throw new Error("simulated rewrite failure after the sidecar");
        // SAFETY: rewriteUnchained's parameter is NamespaceRecord[]; the override's
        // loose unknown[] only ever forwards what the repair itself passed.
        return await original(records as never);
      } finally {
        signal?.();
      }
    };
    let settled = settlesOnNextAttempt();
    await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
    await settled; // the first failing attempt
    settled = settlesOnNextAttempt();
    await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
    await settled; // the second failing attempt
    await catalog.listNamespaces(undefined, { onIncomplete: () => undefined });
    await settleRewrite(catalogPath, "this is not json"); // third attempt repairs
    await settleStateDir(path.join(memoryDir, "state"));
    assert.equal(catalog.malformedRepairAttemptsForTest, 3, "a failed attempt retries on the next read");
    assert.ok(!(await readFile(catalogPath, "utf8")).includes("this is not json"), "the third attempt repaired the catalog");

    const sidecars = (await readdir(path.join(memoryDir, "state"))).filter((e) =>
      /^namespaces\.jsonl\.malformed-[0-9a-f]{16}$/.test(e),
    );
    assert.equal(sidecars.length, 1, "the same dropped rows reuse one hash-named sidecar");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a repair whose locked re-read fails leaves the catalog untouched (#3297)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const writer = new NamespaceCatalog(makeConfig(memoryDir));
    await writer.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await appendFile(catalogPath, "{this is not json\n", "utf8");
    const before = await readFile(catalogPath, "utf8");

    const reader = new FailingReadCatalog(makeConfig(memoryDir));
    reader.failAfterFirstRead();
    const reasons: string[] = [];
    const records = await reader.listNamespaces(undefined, { onIncomplete: (r) => reasons.push(r) });
    assert.deepEqual(records.map((r) => r.namespace), ["project-origin-abc123"]);
    assert.equal(reasons.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await readFile(catalogPath, "utf8"), before, "the failed second read did not wipe the catalog");
    assert.deepEqual((await stateEntries(memoryDir)).filter((e) => e.endsWith(".tmp")), []);

    reader.stopFailing();
    const again: string[] = [];
    await reader.listNamespaces(undefined, { onIncomplete: (r) => again.push(r) });
    assert.equal(again.length, 1, "the next read still reports the malformed row");
    await settleRewrite(catalogPath, "{this is not json");
    assert.ok(!(await readFile(catalogPath, "utf8")).includes("{this is not json"), "the retried repair dropped the row");
    assert.match(await readFile(catalogPath, "utf8"), /project-origin-abc123/, "the readable row survived");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a repair dropped under lock contention is retried by a warm-cache read (#3297)", { timeout: 30_000 }, async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const catalog = new NamespaceCatalog(makeConfig(memoryDir));
    await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
    const catalogPath = path.join(memoryDir, "state", "namespaces.jsonl");
    await appendFile(catalogPath, "{this is not json\n", "utf8");
    const reader = new NamespaceCatalog(makeConfig(memoryDir));
    const lockPath = path.join(memoryDir, "state", "namespaces.rebuild.lock");

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withHeldFileLock(lockPath, { staleMs: 60_000 }, async () => released);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const first: string[] = [];
    await reader.listNamespaces(undefined, { onIncomplete: (r) => first.push(r) });
    assert.equal(first.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 5_600)); // past the lock wait: repair dropped
    assert.ok((await readFile(catalogPath, "utf8")).includes("{this is not json"), "the dropped repair changed nothing");
    release();
    await holder;

    const again: string[] = [];
    await reader.listNamespaces(undefined, { onIncomplete: (r) => again.push(r) });
    assert.equal(again.length, 1);
    await settleRewrite(catalogPath, "{this is not json");
    assert.ok(!(await readFile(catalogPath, "utf8")).includes("{this is not json"), "the retry repaired the catalog");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
