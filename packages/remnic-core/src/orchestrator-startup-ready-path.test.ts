import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { namespaceIdentityToken } from "./namespaces/identity.js";
import { Orchestrator } from "./orchestrator.js";

/**
 * Issue #3518: the corpus-wide QMD update must not sit in the awaited ready
 * path. `deferredReady` settles after the probe, collection ensure and model
 * warm-up; the update runs afterward under the server retry loop, which sees
 * `deferredSyncSucceeded === false` and calls `startupSearchSync`. The
 * readiness-level entry point (`startupSearchReadySync`) repeats only the
 * probe + collection ensure so warm-up attempts never block on a reindex.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// SAFETY: tests stub private orchestrator deps through the self-deps seam, as the neighbouring init tests do.
const asDeps = (orchestrator: Orchestrator) => orchestrator as any;

function readyPathConfig(memoryDir: string) {
  return parseConfig({
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdMaintenanceEnabled: true,
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
    wearables: { enabled: false, sources: {} },
  });
}

function blockingUpdateQmd(updateCalls: number[]) {
  return {
    probe: async () => true,
    debugStatus: () => "synthetic-qmd",
    isAvailable: () => true,
    search: async () => [],
    async update() {
      updateCalls.push(1);
      await new Promise<void>(() => {});
    },
  };
}

function stubWarmupDeps(orchestrator: any) {
  orchestrator.storage.readAllMemories = async () => [];
  orchestrator.storage.readAllEntityFiles = async () => [];
  orchestrator.storage.buildKnowledgeIndex = async () => [];
  orchestrator.maintenanceScheduler.autoRegisterCrons = async () => {};
}

test("deferredInitialize resolves without the corpus update and leaves the retry flag armed", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ready-path-"));
  const orchestrator = new Orchestrator(readyPathConfig(memoryDir));
  const updateCalls: number[] = [];
  const deps = asDeps(orchestrator);
  try {
    deps.qmd = blockingUpdateQmd(updateCalls);
    deps.namespaceSearchRouter.updateNamespaces = async () => {
      updateCalls.push(1);
      await new Promise<void>(() => {});
      return 0;
    };
    stubWarmupDeps(deps);

    const outcome = await Promise.race([
      deps.deferredInitialize(new AbortController().signal).then(() => "settled" as const),
      sleep(2_000).then(() => "hung" as const),
    ]);

    assert.equal(outcome, "settled", "deferred init must not wait on the corpus update");
    assert.equal(updateCalls.length, 0, "the corpus update must not run in the deferred path");
    assert.equal(
      deps.deferredSyncSucceeded,
      false,
      "the owed update must leave the retry flag armed",
    );
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("startupSearchReadySync probes and ensures collections without running the corpus update", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ready-path-"));
  const orchestrator = new Orchestrator(readyPathConfig(memoryDir));
  const updateCalls: number[] = [];
  const ensured: string[] = [];
  const deps = asDeps(orchestrator);
  try {
    deps.qmd = blockingUpdateQmd(updateCalls);
    deps.namespaceSearchRouter.clearCache = () => undefined;
    deps.namespaceSearchRouter.ensureNamespaceCollection = async (ns: string) => {
      ensured.push(ns);
      return "present";
    };
    deps.namespaceSearchRouter.updateNamespaces = async () => {
      updateCalls.push(1);
      await new Promise<void>(() => {});
      return 0;
    };

    const ready = await Promise.race([
      orchestrator.startupSearchReadySync(new AbortController().signal),
      sleep(2_000).then(() => "hung" as const),
    ]);

    assert.equal(ready, true, "a probed backend with ensured collections reports ready");
    assert.ok(ensured.length > 0, "the readiness sync still ensures collections");
    assert.equal(updateCalls.length, 0, "the readiness sync must not run the corpus update");
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("startupSearchSync still runs the corpus update over the catalog union for the post-ready retry loop", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ready-path-"));
  const orchestrator = new Orchestrator(readyPathConfig(memoryDir));
  const updates: string[][] = [];
  const dynamicNamespace = "ready-path-dynamic";
  const dynamicStorageDir = path.join(
    memoryDir,
    "namespaces",
    namespaceIdentityToken(dynamicNamespace),
  );
  await mkdir(path.join(dynamicStorageDir, "state"), { recursive: true });
  const deps = asDeps(orchestrator);
  try {
    deps.qmd = {
      probe: async () => true,
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => [],
      update: async () => {},
      lastUpdateRanAtMs: 1,
      lastUpdateFailedAtMs: null,
    };
    deps.namespaceCatalog.listNamespaces = async () => [
      { namespace: "default" },
      {
        namespace: dynamicNamespace,
        identityToken: namespaceIdentityToken(dynamicNamespace),
        kind: "project",
        createdAt: new Date(0).toISOString(),
        storageDir: dynamicStorageDir,
        discoveredBy: "write",
      },
    ];
    deps.namespaceSearchRouter.clearCache = () => undefined;
    deps.namespaceSearchRouter.ensureNamespaceCollection = async () => "present";
    deps.namespaceSearchRouter.updateNamespaces = async (ns: string[]) => {
      updates.push([...ns]);
      return ns.length;
    };

    const synced = await orchestrator.startupSearchSync(new AbortController().signal);

    assert.equal(synced, true);
    assert.equal(updates.length, 1, "the retry entry point must run the corpus update");
    for (const expected of ["default", "shared", dynamicNamespace]) {
      assert.ok(updates[0].includes(expected), `update must cover ${expected}`);
    }
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});
