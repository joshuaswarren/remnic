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

test("startupSearchReadySync joins an in-flight full sync's backend phase and resolves before its corpus update (#3518 second read)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ready-path-"));
  const orchestrator = new Orchestrator(readyPathConfig(memoryDir));
  const probeCalls: number[] = [];
  const ensureEntries: string[] = [];
  const updateCalls: number[] = [];
  const ensureGate = Promise.withResolvers<void>();
  const updateGate = Promise.withResolvers<void>();
  const deps = asDeps(orchestrator);
  try {
    deps.qmd = {
      probe: async () => {
        probeCalls.push(1);
        return true;
      },
      debugStatus: () => "synthetic-qmd",
      // The real backend flips isAvailable() inside probe(), before ensure
      // finishes (qmd.ts recordProbeSuccess) — the window the warm-up gate
      // used to trust.
      isAvailable: () => probeCalls.length > 0,
      search: async () => [],
      update: async () => {},
      lastUpdateRanAtMs: 1,
      lastUpdateFailedAtMs: null,
    };
    deps.namespaceSearchRouter.clearCache = () => undefined;
    deps.namespaceSearchRouter.ensureNamespaceCollection = async (ns: string) => {
      ensureEntries.push(ns);
      await ensureGate.promise;
      return "present";
    };
    deps.namespaceSearchRouter.updateNamespaces = async (ns: string[]) => {
      updateCalls.push(1);
      await updateGate.promise;
      return ns.length;
    };

    const signal = new AbortController().signal;
    const full = orchestrator.startupSearchSync(signal);
    for (let i = 0; i < 200 && ensureEntries.length === 0; i += 1) await sleep(5);
    assert.ok(ensureEntries.length > 0, "the full sync reaches its collection ensure");

    const ready = orchestrator.startupSearchReadySync(signal);
    await sleep(50);
    assert.equal(
      probeCalls.length,
      1,
      "the ready sync must join the in-flight backend run, not start a second probe",
    );
    assert.equal(
      new Set(ensureEntries).size,
      ensureEntries.length,
      "each namespace is ensured once across joined callers",
    );
    assert.equal(
      await Promise.race([ready.then(() => "settled" as const), sleep(50).then(() => "pending" as const)]),
      "pending",
      "the joined ready sync must wait for the shared ensure to finish",
    );

    ensureGate.resolve();
    assert.equal(
      await Promise.race([ready, sleep(2_000).then(() => "hung" as const)]),
      true,
      "the joined ready sync resolves once the shared ensure completes",
    );
    assert.equal(
      await Promise.race([full.then(() => "synced" as const), sleep(50).then(() => "pending" as const)]),
      "pending",
      "the full sync keeps running its corpus update after the ready sync resolves",
    );

    updateGate.resolve();
    assert.equal(await full, true);
    assert.equal(updateCalls.length, 1);
  } finally {
    ensureGate.resolve();
    updateGate.resolve();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an unknown collection state keeps the readiness and full syncs unready (wAQ third read)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ready-path-"));
  const orchestrator = new Orchestrator(readyPathConfig(memoryDir));
  const updateCalls: number[] = [];
  const deps = asDeps(orchestrator);
  try {
    deps.qmd = {
      probe: async () => true,
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => [],
      update: async () => {
        updateCalls.push(1);
      },
      lastUpdateRanAtMs: 1,
      lastUpdateFailedAtMs: null,
    };
    deps.namespaceSearchRouter.clearCache = () => undefined;
    // The collection check could not determine the state (timeout, cancelled
    // auto-create, recheck failure): retrieval stays fail-open, but the
    // startup syncs must not claim readiness off an unverified ensure. A
    // zero-result healthy warm-up on top must not open the gate as warmed.
    deps.namespaceSearchRouter.ensureNamespaceCollection = async () => "unknown";
    deps.namespaceSearchRouter.updateNamespaces = async (ns: string[]) => {
      updateCalls.push(1);
      return ns.length;
    };

    const signal = new AbortController().signal;
    assert.equal(
      await orchestrator.startupSearchReadySync(signal),
      false,
      "an unverified collection state must not open strict readiness",
    );
    assert.equal(
      await orchestrator.startupSearchSync(signal),
      false,
      "the full sync must not claim success off an unverified ensure",
    );
    assert.equal(updateCalls.length, 0, "the corpus update does not run while the ensure is unverified");
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an explicitly skipped collection ensure still counts as ready (wAQ third read)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ready-path-"));
  const orchestrator = new Orchestrator(readyPathConfig(memoryDir));
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
    deps.namespaceSearchRouter.clearCache = () => undefined;
    // Remote or daemon-only modes intentionally run no local collection check;
    // "skipped" is a supported explicit answer, unlike "unknown".
    deps.namespaceSearchRouter.ensureNamespaceCollection = async () => "skipped";

    assert.equal(
      await orchestrator.startupSearchReadySync(new AbortController().signal),
      true,
      "explicit skipped support must be preserved",
    );
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a caller after an epoch transition runs its own backend ensure instead of joining the retired flight", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ready-path-"));
  const orchestrator = new Orchestrator(readyPathConfig(memoryDir));
  const probeCalls: number[] = [];
  const ensureGate = Promise.withResolvers<void>();
  let gateFirstEnsure = true;
  const deps = asDeps(orchestrator);
  try {
    deps.qmd = {
      probe: async () => {
        probeCalls.push(1);
        return true;
      },
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => [],
      update: async () => {},
      lastUpdateRanAtMs: 1,
      lastUpdateFailedAtMs: null,
    };
    deps.namespaceSearchRouter.clearCache = () => undefined;
    deps.namespaceSearchRouter.ensureNamespaceCollection = async () => {
      if (gateFirstEnsure) {
        gateFirstEnsure = false;
        await ensureGate.promise;
      }
      return "present";
    };

    const signal = new AbortController().signal;
    const first = orchestrator.startupSearchReadySync(signal);
    for (let i = 0; i < 200 && gateFirstEnsure; i += 1) await sleep(5);
    assert.equal(probeCalls.length, 1, "epoch A's readiness run reached its ensure");

    // A same-instance lifecycle restart retires epoch A and opens epoch B
    // while A's shared ensure is still in flight.
    deps.orchestratorInitCoordinator.beginStartupEpoch();

    const second = orchestrator.startupSearchReadySync(signal);
    ensureGate.resolve();
    assert.equal(
      await second,
      true,
      "the epoch-B caller must run its own ensure, not inherit epoch A's retired flight",
    );
    assert.equal(
      probeCalls.length,
      2,
      "the epoch-B caller re-probes instead of joining the retired run",
    );
    assert.equal(
      await first,
      false,
      "epoch A's joined run reports retired once its epoch is replaced",
    );
  } finally {
    ensureGate.resolve();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a caller abort does not cancel the shared backend ensure for joined callers", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ready-path-"));
  const orchestrator = new Orchestrator(readyPathConfig(memoryDir));
  const ensureGate = Promise.withResolvers<void>();
  let firstEnsureSeen = false;
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
    deps.namespaceSearchRouter.clearCache = () => undefined;
    deps.namespaceSearchRouter.ensureNamespaceCollection = async () => {
      if (!firstEnsureSeen) {
        firstEnsureSeen = true;
        await ensureGate.promise;
      }
      return "present";
    };

    // The first caller aborts mid-ensure — the readiness gate's per-attempt
    // timeout. The shared backend run is epoch-owned, so the abort must not
    // kill it for the full-sync caller that joined it.
    const firstController = new AbortController();
    const first = orchestrator.startupSearchReadySync(firstController.signal);
    for (let i = 0; i < 200 && !firstEnsureSeen; i += 1) await sleep(5);
    assert.ok(firstEnsureSeen, "the shared run reached its ensure");

    const second = orchestrator.startupSearchReadySync(new AbortController().signal);
    firstController.abort();
    ensureGate.resolve();

    assert.equal(
      await Promise.race([second, sleep(2_000).then(() => "hung" as const)]),
      true,
      "the joined caller keeps the shared run's result after the first caller's abort",
    );
    await first;
  } finally {
    ensureGate.resolve();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});
