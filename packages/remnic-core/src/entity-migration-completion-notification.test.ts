import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { StorageManager } from "./storage.js";

// #3240 follow-up: the host's onEntityMigrationComplete slot must fire once
// per actual migration pass (never on ensure() no-ops), fail open on a
// throwing hook, reach router-created storages independent of auto-embed, and
// be inert after Orchestrator.destroy(). No direct QMD calls; the re-arm is
// observed through a requestQmdMaintenance spy.

test("real storage fires the completion slot once per actual pass and fails open on a throwing hook", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-migration-complete-"));
  try {
    const storage = new StorageManager(dir);
    let completions = 0;
    storage.onEntityMigrationComplete = () => {
      completions += 1;
    };
    await storage.ensureDirectories();
    assert.equal(completions, 1, "the first real migration pass must fire the completion slot");
    await storage.ensureDirectories();
    assert.equal(completions, 1, "a second ensureDirectories must not re-fire the slot");

    const throwing = new StorageManager(path.join(dir, "throwing-hook"));
    let hookCalls = 0;
    throwing.onEntityMigrationComplete = () => {
      hookCalls += 1;
      throw new Error("consumer hook exploded");
    };
    await throwing.ensureDirectories();
    assert.equal(hookCalls, 1, "the throwing hook must still be invoked");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestrator wires completion with auto-embed off and blocks it from teardown admission", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-migration-complete-orch-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir: dir,
      workspaceDir: path.join(dir, "workspace"),
      qmdEnabled: false,
      qmdAutoEmbedEnabled: false,
      namespacesEnabled: true,
      namespaceCatalogEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
      embeddingFallbackEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
      knowledgeIndexEnabled: false,
    }),
  );
  // Test-only access to orchestrator internals (private wiring surfaces),
  // mirroring the sibling orchestrator tests' as-any convention.
  const internals = orchestrator as unknown as {
    storage: StorageManager;
    storageRouter: { storageFor(namespace: string): Promise<StorageManager> };
    requestQmdMaintenance: () => void;
    maintenanceScheduler: { dispose: () => Promise<void> };
  };
  try {
    // Wiring must exist independent of auto-embed.
    const onMigrationComplete = internals.storage.onEntityMigrationComplete;
    assert.equal(
      typeof onMigrationComplete,
      "function",
      "the default storage must carry the migration completion slot without auto-embed",
    );
    const namespaceStorage = await internals.storageRouter.storageFor("proj-a");
    const onNamespaceMigrationComplete = namespaceStorage.onEntityMigrationComplete;
    assert.equal(
      typeof onNamespaceMigrationComplete,
      "function",
      "a router-created namespace storage must carry the slot without auto-embed",
    );

    const rearmRequests: string[] = [];
    internals.requestQmdMaintenance = () => {
      rearmRequests.push("rearm");
    };
    assert.ok(onMigrationComplete);
    onMigrationComplete();
    assert.ok(onNamespaceMigrationComplete);
    onNamespaceMigrationComplete();
    assert.deepEqual(rearmRequests, ["rearm", "rearm"], "a completion must re-arm QMD maintenance");

    const { promise: disposeGate, resolve: releaseDispose } = Promise.withResolvers<void>();
    const { promise: disposing, resolve: signalDispose } = Promise.withResolvers<void>();
    const originalDispose = internals.maintenanceScheduler.dispose.bind(internals.maintenanceScheduler);
    internals.maintenanceScheduler.dispose = async () => {
      signalDispose();
      await disposeGate;
      await originalDispose();
    };
    const teardown = orchestrator.destroy();
    try {
      await disposing;
      onMigrationComplete();
      onNamespaceMigrationComplete();
      assert.deepEqual(rearmRequests, ["rearm", "rearm"], "teardown admission must stop completion re-arms before drains");
    } finally {
      releaseDispose();
      await teardown;
    }
    onMigrationComplete();
    onNamespaceMigrationComplete();
    assert.deepEqual(
      rearmRequests,
      ["rearm", "rearm"],
      "a completion after destroy must not re-arm maintenance",
    );
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
