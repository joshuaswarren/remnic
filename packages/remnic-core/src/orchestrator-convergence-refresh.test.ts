import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readProjectedMemoryBrowse } from "./memory-projection-store.js";
import { Orchestrator } from "./orchestrator.js";
import { StorageManager } from "./storage.js";

test("refreshNamespacesAfterConvergence runs one strict QMD batch and rebuilds each namespace projection once", async () => {
  const teamDir = await mkdtemp(path.join(os.tmpdir(), "remnic-convergence-team-"));
  const sharedDir = await mkdtemp(path.join(os.tmpdir(), "remnic-convergence-shared-"));
  try {
    const teamStorage = new StorageManager(teamDir);
    const sharedStorage = new StorageManager(sharedDir);
    const teamMemory = await teamStorage.writeMemory("fact", "A received team fact.", {
      source: "test",
    });
    const sharedMemory = await sharedStorage.writeMemory("fact", "A received shared fact.", {
      source: "test",
    });
    const qmdCalls: Array<{
      namespaces: string[];
      options: { strict?: boolean } | undefined;
    }> = [];
    const storageCalls: string[] = [];
    const orchestrator = Object.create(Orchestrator.prototype) as Orchestrator;
    const internals = orchestrator as unknown as {
      config: { defaultNamespace: string };
      namespaceSearchRouter: {
        updateNamespacesDetailed(
          namespaces: string[],
          execution?: unknown,
          options?: { strict?: boolean }
        ): Promise<{ backendCount: number; eligibleNamespaces: string[] }>;
      };
      getStorage(namespace: string): Promise<StorageManager>;
    };
    internals.config = { defaultNamespace: "default" };
    internals.namespaceSearchRouter = {
      async updateNamespacesDetailed(namespaces, _execution, options) {
        qmdCalls.push({ namespaces, options });
        return { backendCount: 1, eligibleNamespaces: namespaces };
      },
    };
    const storageByNamespace = new Map([
      ["team", teamStorage],
      ["shared", sharedStorage],
    ]);
    internals.getStorage = async (namespace) => {
      storageCalls.push(namespace);
      const storage = storageByNamespace.get(namespace);
      assert.ok(storage);
      return storage;
    };
    const refreshSurface = orchestrator as unknown as {
      refreshNamespacesAfterConvergence(namespaces: readonly string[]): Promise<void>;
    };

    await refreshSurface.refreshNamespacesAfterConvergence(["team", "shared", "team"]);

    assert.deepEqual(qmdCalls, [
      {
        namespaces: ["team", "shared"],
        options: { strict: true },
      },
    ]);
    assert.deepEqual(storageCalls, ["team", "shared"]);
    const teamProjection = readProjectedMemoryBrowse(teamDir, { limit: 10, offset: 0 });
    const sharedProjection = readProjectedMemoryBrowse(sharedDir, { limit: 10, offset: 0 });
    assert.equal(teamProjection?.memories[0]?.id, teamMemory.id);
    assert.equal(sharedProjection?.memories[0]?.id, sharedMemory.id);
  } finally {
    await Promise.all([rm(teamDir, { recursive: true, force: true }), rm(sharedDir, { recursive: true, force: true })]);
  }
});

test("refreshNamespacesAfterConvergence fails before projection when QMD cannot index every namespace", async () => {
  let storageRequested = false;
  const orchestrator = Object.create(Orchestrator.prototype) as Orchestrator;
  const internals = orchestrator as unknown as {
    namespaceSearchRouter: {
      updateNamespacesDetailed(
        namespaces: string[],
        execution?: unknown,
        options?: { strict?: boolean }
      ): Promise<{ backendCount: number; eligibleNamespaces: string[] }>;
    };
    getStorage(namespace: string): Promise<StorageManager>;
  };
  internals.namespaceSearchRouter = {
    async updateNamespacesDetailed() {
      return { backendCount: 1, eligibleNamespaces: ["team"] };
    },
  };
  internals.getStorage = async () => {
    storageRequested = true;
    throw new Error("projection should not run");
  };
  const refreshSurface = orchestrator as unknown as {
    refreshNamespacesAfterConvergence(namespaces: readonly string[]): Promise<void>;
  };

  await assert.rejects(
    () => refreshSurface.refreshNamespacesAfterConvergence(["team", "shared"]),
    /QMD backend ineligible for convergence namespaces \(1\)/
  );
  assert.equal(storageRequested, false);
});
