import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PluginConfig } from "../src/types.js";
import { parseConfig } from "../src/config.js";
import {
  listNamespaces,
  runNamespaceMigration,
  verifyNamespaces,
} from "../src/namespaces/migrate.js";
import { NamespaceStorageRouter } from "../src/namespaces/storage.js";

function tmpDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

function baseConfig(memoryDir: string): PluginConfig {
  return parseConfig({
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "team-alpha", readPrincipals: ["*"], writePrincipals: ["*"], includeInRecallByDefault: false },
    ],
    defaultRecallNamespaces: ["self"],
  });
}

test("listNamespaces reports legacy-root default namespace before migration", async () => {
  const memoryDir = tmpDir("engram-namespace-list");
  await mkdir(memoryDir, { recursive: true });
  const namespaces = await listNamespaces({ config: baseConfig(memoryDir) });
  const defaultEntry = namespaces.find((entry) => entry.namespace === "default");
  assert.ok(defaultEntry);
  assert.equal(defaultEntry.usesLegacyRoot, true);
  assert.equal(defaultEntry.rootDir, memoryDir);
});

test("verifyNamespaces reports legacy data before migration", async () => {
  const memoryDir = tmpDir("engram-namespace-plan");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeFile(path.join(memoryDir, "profile.md"), "# Profile\n", "utf-8");

  const config = baseConfig(memoryDir);
  const report = await verifyNamespaces({ config });
  const defaultEntry = report.namespaces.find((entry) => entry.namespace === "default");
  assert.ok(defaultEntry);
  assert.equal(report.ok, true);
  assert.equal(defaultEntry.hasMemoryData, true);
  assert.equal(defaultEntry.usesLegacyRoot, true);
  assert.deepEqual(report.problems, []);
});

test("verifyNamespaces flags missing and empty namespace roots", async () => {
  const memoryDir = tmpDir("engram-namespace-verify-missing");
  await Promise.all([mkdir(path.join(memoryDir, "namespaces", "ns-64656661756c74", "facts"), { recursive: true }), mkdir(path.join(memoryDir, "namespaces", "ns-736861726564"), { recursive: true })]);

  const report = await verifyNamespaces({ config: baseConfig(memoryDir) });
  assert.equal(report.ok, false);
  assert.match(report.problems.join("\n"), /shared: root exists but contains no Engram data/);
  assert.doesNotMatch(report.problems.join("\n"), /team-alpha: missing root/);
});

test("runNamespaceMigration moves legacy entries into target namespace", async () => {
  const memoryDir = tmpDir("engram-namespace-migrate");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeFile(path.join(memoryDir, "profile.md"), "# Profile\n", "utf-8");

  const config = baseConfig(memoryDir);
  const report = await runNamespaceMigration({ config, to: "default" });
  assert.equal(report.dryRun, false);
  assert.equal(report.moved.length, 2);

  const rootEntries = await readdir(memoryDir);
  assert.deepEqual(rootEntries.sort(), ["namespaces"]);

  const migratedEntries = await readdir(path.join(memoryDir, "namespaces", "ns-64656661756c74"));
  assert.deepEqual(migratedEntries.sort(), ["facts", "profile.md"]);
});

test("runNamespaceMigration rolls back completed moves when a later move fails", async () => {
  const memoryDir = tmpDir("engram-namespace-migrate-rollback");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeFile(path.join(memoryDir, "facts", "a.md"), "Fact A\n", "utf-8");
  await mkdir(path.join(memoryDir, "entities"), { recursive: true });
  await writeFile(path.join(memoryDir, "entities", "b.md"), "Entity B\n", "utf-8");

  const config = baseConfig(memoryDir);
  await assert.rejects(
    () =>
      runNamespaceMigration({
        config,
        to: "default",
        async renameFn(from, to) {
          if (typeof from === "string" && from.endsWith(`${path.sep}entities`)) {
            throw new Error("synthetic rename failure");
          }
          const fs = await import("node:fs/promises");
          await fs.rename(from, to);
        },
      }),
    /rolled back.*synthetic rename failure/,
  );

  assert.equal(await readFile(path.join(memoryDir, "facts", "a.md"), "utf-8"), "Fact A\n");
  assert.equal(await readFile(path.join(memoryDir, "entities", "b.md"), "utf-8"), "Entity B\n");
});

test("runNamespaceMigration rejects symlinked namespace reservation paths", async () => {
  const memoryDir = tmpDir("engram-namespace-migrate-symlink");
  const outside = tmpDir("engram-namespace-outside");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(memoryDir, "namespaces"));

  await assert.rejects(
    () => runNamespaceMigration({ config: baseConfig(memoryDir), to: "default" }),
    /symlinked namespaces directory/,
  );
});

test("default namespace router keeps legacy root when partial migrated root exists", async () => {
  const memoryDir = tmpDir("engram-namespace-partial-default");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeFile(path.join(memoryDir, "facts", "legacy.md"), "Legacy fact\n", "utf-8");
  await mkdir(path.join(memoryDir, "namespaces", "default", "entities"), { recursive: true });

  const router = new NamespaceStorageRouter(baseConfig(memoryDir));
  const storage = await router.storageFor("default");
  assert.equal(storage.dir, memoryDir);
});

test("default namespace router ignores empty bootstrap directories after tokenized migration", async () => {
  const memoryDir = tmpDir("engram-namespace-tokenized-default-with-empty-bootstrap");
  const tokenizedDefault = path.join(memoryDir, "namespaces", "ns-64656661756c74");
  await mkdir(path.join(tokenizedDefault, "facts"), { recursive: true });
  await writeFile(path.join(tokenizedDefault, "facts", "migrated.md"), "Migrated default fact\n", "utf-8");
  await mkdir(path.join(memoryDir, "facts", "2026-05-31"), { recursive: true });
  await mkdir(path.join(memoryDir, "config"), { recursive: true });
  await mkdir(path.join(memoryDir, "identity", "incidents"), { recursive: true });

  const router = new NamespaceStorageRouter(baseConfig(memoryDir));
  const storage = await router.storageFor("default");
  assert.equal(storage.dir, tokenizedDefault);
});

test("default namespace router ignores top-level runtime state after tokenized migration", async () => {
  const memoryDir = tmpDir("engram-namespace-tokenized-default-with-state");
  const tokenizedDefault = path.join(memoryDir, "namespaces", "ns-64656661756c74");
  await mkdir(path.join(tokenizedDefault, "facts"), { recursive: true });
  await writeFile(path.join(tokenizedDefault, "facts", "migrated.md"), "Migrated default fact\n", "utf-8");
  await mkdir(path.join(memoryDir, "state", "graphs"), { recursive: true });

  const router = new NamespaceStorageRouter(baseConfig(memoryDir));
  const storage = await router.storageFor("default");
  assert.equal(storage.dir, tokenizedDefault);
});
