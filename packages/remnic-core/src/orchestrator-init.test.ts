import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { NoopSearchBackend } from "./search/noop-backend.js";

async function withTestDeadline<T>(
  promise: Promise<T>,
  timeoutMs = 1_250,
): Promise<T | "deadline"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("initialize and its init gate survive an enabled catalog planner timeout", async () => {
  const originalTimeout = process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-init-deadline-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: true,
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
  const enabledQmd = {
    probe: async () => true,
    debugStatus: () => "synthetic-qmd",
    isAvailable: () => true,
    search: async () => [],
  };
  let releasePlannerNamespaces: ((records: unknown[]) => void) | undefined;
  const stalledPlannerNamespaces = new Promise<unknown[]>((resolve) => {
    releasePlannerNamespaces = resolve;
  });
  const configuredNamespaces = (orchestrator as any).configuredNamespaceList();
  const ensuredNamespaces: string[] = [];
  const updatedNamespaces: string[][] = [];
  const recoveredPlanNamespaces: string[][] = [];
  let listNamespacesCalls = 0;
  let secondPlannerCallStarted = false;
  const dynamicRecord = {
    namespace: "dynamic",
    identityToken: "dynamic",
    kind: "project" as const,
    createdAt: new Date(0).toISOString(),
    storageDir: path.join(memoryDir, "namespaces", "dynamic"),
    discoveredBy: "write" as const,
  };

  try {
    process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = "1000";
    (orchestrator as any).qmd = enabledQmd;
    await mkdir(path.join(dynamicRecord.storageDir, "state"), { recursive: true });
    (orchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async (namespaces: string[]) => {
        recoveredPlanNamespaces.push([...namespaces]);
        return 0;
      },
    });
    (orchestrator as any).namespaceCatalog.listNamespaces = () => {
      listNamespacesCalls += 1;
      if (listNamespacesCalls === 1) return Promise.resolve([dynamicRecord]);
      if (listNamespacesCalls === 2) secondPlannerCallStarted = true;
      return stalledPlannerNamespaces;
    };
    (orchestrator as any).namespaceSearchRouter.clearCache = () => undefined;
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async (namespace: string) => {
      ensuredNamespaces.push(namespace);
      return "present";
    };
    (orchestrator as any).namespaceSearchRouter.updateNamespaces = async (namespaces: string[]) => {
      updatedNamespaces.push([...namespaces]);
      return namespaces.length;
    };

    const initPromise = (orchestrator as any).initPromise as Promise<void>;
    const initializeResult = withTestDeadline(
      orchestrator.initialize().then(() => "settled" as const),
    );
    const initGateResult = withTestDeadline(
      initPromise.then(() => "settled" as const),
    );
    const [result, initGate] = await Promise.all([initializeResult, initGateResult]);

    assert.equal(
      result,
      "settled",
      "init must not remain pending behind namespace-maintenance discovery",
    );
    assert.equal(initGate, "settled", "the real initPromise gate must not remain pending");
    assert.deepEqual(
      recoveredPlanNamespaces,
      [[...configuredNamespaces, "dynamic"]],
      "the first catalog read must feed stale-plan recovery before QMD planning",
    );
    assert.equal(secondPlannerCallStarted, true, "the second catalog read must be the stalled QMD planner discovery");
    assert.equal((orchestrator as any).qmd, enabledQmd, "unknown startup state must keep QMD enabled fail-open");
    assert.deepEqual(
      ensuredNamespaces,
      configuredNamespaces,
      "late namespace discovery must not launch collection checks after the startup deadline",
    );

    const deferredResult = await withTestDeadline(
      (orchestrator as any).deferredReady.then(() => "settled" as const),
    );
    assert.equal(deferredResult, "settled", "deferred initialization must settle after incomplete discovery");
    assert.deepEqual(updatedNamespaces, [configuredNamespaces]);
    assert.equal((orchestrator as any).deferredSyncSucceeded, false);

    const retryResult = await withTestDeadline(orchestrator.startupSearchSync());
    assert.equal(retryResult, false, "incomplete discovery must leave startup retry armed");
    assert.deepEqual(updatedNamespaces, [configuredNamespaces, configuredNamespaces]);
    const fallbackEnsureCalls = [...configuredNamespaces, ...configuredNamespaces];
    assert.deepEqual(ensuredNamespaces, fallbackEnsureCalls);

    releasePlannerNamespaces?.([dynamicRecord]);
    await Promise.resolve();
    assert.deepEqual(
      ensuredNamespaces,
      fallbackEnsureCalls,
      "a late maintenance result must not launch a stale collection-check batch",
    );
    const recovered = await orchestrator.startupSearchSync();
    assert.equal(recovered, true);
    const completeNamespaces = [...configuredNamespaces, "dynamic"];
    assert.deepEqual(
      ensuredNamespaces,
      [...fallbackEnsureCalls, ...completeNamespaces],
      "a later complete retry must re-stage dynamic collection checks",
    );
    assert.deepEqual(updatedNamespaces, [
      configuredNamespaces,
      configuredNamespaces,
      completeNamespaces,
    ]);
  } finally {
    releasePlannerNamespaces?.([dynamicRecord]);
    if (originalTimeout === undefined) delete process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
    else process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = originalTimeout;
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("aborted deferred and retry discovery do not start QMD work after the source deadline", async () => {
  const originalTimeout = process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-abort-discovery-"));
  const orchestrator = new Orchestrator(
    parseConfig({
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
    }),
  );
  let releaseDiscovery: (() => void) | undefined;
  const stalledDiscovery = new Promise<string[]>((resolve) => {
    releaseDiscovery = () => resolve([]);
  });
  let resolveBothDiscoveriesStarted: (() => void) | undefined;
  const bothDiscoveriesStarted = new Promise<void>((resolve) => {
    resolveBothDiscoveriesStarted = resolve;
  });
  let discoveryCalls = 0;
  let ensureStarts = 0;
  let updateStarts = 0;
  const deferredAbort = new AbortController();
  const retryAbort = new AbortController();

  try {
    process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = "1000";
    (orchestrator as any).qmd = {
      probe: async () => true,
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => [],
    };
    (orchestrator as any).maintenanceNamespaces = () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) resolveBothDiscoveriesStarted?.();
      return stalledDiscovery;
    };
    (orchestrator as any).namespaceSearchRouter.clearCache = () => undefined;
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async () => {
      ensureStarts += 1;
      return "present";
    };
    (orchestrator as any).namespaceSearchRouter.updateNamespaces = async () => {
      updateStarts += 1;
      return 1;
    };

    const deferred = (orchestrator as any).deferredInitialize(deferredAbort.signal);
    const retry = orchestrator.startupSearchSync(retryAbort.signal);
    const started = await withTestDeadline(bothDiscoveriesStarted);
    assert.notEqual(started, "deadline", "both callers must be stalled in source discovery");

    deferredAbort.abort();
    retryAbort.abort();

    const settled = await withTestDeadline(Promise.all([deferred, retry]));
    if (settled === "deadline") {
      assert.fail("both callers must return once the source discovery deadline resolves");
    }
    assert.equal(settled[1], false, "the aborted retry must report no successful sync");
    assert.deepEqual(
      { ensureStarts, updateStarts },
      { ensureStarts: 0, updateStarts: 0 },
      "aborted callers must not dispatch QMD ensure or update after stalled discovery resolves",
    );
  } finally {
    releaseDiscovery?.();
    if (originalTimeout === undefined) delete process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
    else process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = originalTimeout;
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a late correction catalog result recovers a dynamic stale plan once without starting QMD work", async () => {
  const originalTimeout = process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-correction-late-catalog-"));
  const orchestrator = new Orchestrator(
    parseConfig({
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
    }),
  );
  const configuredNamespaces = (orchestrator as any).configuredNamespaceList() as string[];
  const dynamicRecord = {
    namespace: "dynamic",
    identityToken: "dynamic",
    kind: "project" as const,
    createdAt: new Date(0).toISOString(),
    storageDir: path.join(memoryDir, "namespaces", "dynamic"),
    discoveredBy: "write" as const,
  };
  const recoveredPlanNamespaces: string[][] = [];
  const ensuredNamespaces: string[] = [];
  const updatedNamespaces: string[][] = [];
  let warmupStarts = 0;
  let releaseRawCatalog: ((records: unknown[]) => void) | undefined;
  const rawCatalog = new Promise<unknown[]>((resolve) => {
    releaseRawCatalog = resolve;
  });
  let catalogCalls = 0;

  try {
    process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = "1000";
    await mkdir(path.join(dynamicRecord.storageDir, "state"), { recursive: true });
    (orchestrator as any).qmd = {
      probe: async () => true,
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => {
        warmupStarts += 1;
        return [];
      },
    };
    (orchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async (namespaces: string[]) => {
        recoveredPlanNamespaces.push([...namespaces]);
        return namespaces.includes(dynamicRecord.namespace) ? 1 : 0;
      },
    });
    (orchestrator as any).namespaceCatalog.listNamespaces = () => {
      catalogCalls += 1;
      return catalogCalls === 1 ? rawCatalog : Promise.resolve([]);
    };
    (orchestrator as any).namespaceSearchRouter.clearCache = () => undefined;
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async (namespace: string) => {
      ensuredNamespaces.push(namespace);
      return "present";
    };
    (orchestrator as any).namespaceSearchRouter.updateNamespaces = async (namespaces: string[]) => {
      updatedNamespaces.push([...namespaces]);
      return namespaces.length;
    };

    const initialized = await withTestDeadline(orchestrator.initialize().then(() => "settled" as const));
    assert.equal(initialized, "settled", "the correction catalog timeout must keep initialization bounded");
    const deferred = await withTestDeadline((orchestrator as any).deferredReady.then(() => "settled" as const));
    assert.equal(deferred, "settled", "the fallback deferred pass must settle");
    assert.deepEqual(
      recoveredPlanNamespaces,
      [configuredNamespaces],
      "the timed-out correction sweep must immediately recover configured namespaces",
    );

    const qmdStartsBeforeLateCatalog = {
      ensuredNamespaces: [...ensuredNamespaces],
      updatedNamespaces: updatedNamespaces.map((namespaces) => [...namespaces]),
      warmupStarts,
    };
    releaseRawCatalog?.([dynamicRecord]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(
      recoveredPlanNamespaces,
      [configuredNamespaces, [dynamicRecord.namespace]],
      "the same late raw catalog result must recover the dynamic namespace exactly once",
    );
    assert.deepEqual(
      {
        ensuredNamespaces,
        updatedNamespaces,
        warmupStarts,
      },
      qmdStartsBeforeLateCatalog,
      "late correction recovery must not dispatch collection, update, or warmup work",
    );
  } finally {
    releaseRawCatalog?.([dynamicRecord]);
    if (originalTimeout === undefined) delete process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
    else process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = originalTimeout;
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("destroy retires a timed-out correction catalog epoch while a fresh epoch recovers and checks its dynamic namespace", async () => {
  const originalTimeout = process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-destroyed-correction-catalog-"));
  const firstOrchestrator = new Orchestrator(
    parseConfig({
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
    }),
  );
  let freshOrchestrator: Orchestrator | undefined;
  const firstConfiguredNamespaces = (firstOrchestrator as any).configuredNamespaceList() as string[];
  const dynamicRecord = {
    namespace: "dynamic",
    identityToken: "dynamic",
    kind: "project" as const,
    createdAt: new Date(0).toISOString(),
    storageDir: path.join(memoryDir, "namespaces", "dynamic"),
    discoveredBy: "write" as const,
  };
  const firstRecoveredPlanNamespaces: string[][] = [];
  const firstEnsuredNamespaces: string[] = [];
  const firstUpdatedNamespaces: string[][] = [];
  let firstWarmupStarts = 0;
  let firstCatalogCalls = 0;
  let releaseRawCatalog: ((records: unknown[]) => void) | undefined;
  const rawCatalog = new Promise<unknown[]>((resolve) => {
    releaseRawCatalog = resolve;
  });

  try {
    process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = "1000";
    await mkdir(path.join(dynamicRecord.storageDir, "state"), { recursive: true });
    (firstOrchestrator as any).qmd = {
      probe: async () => true,
      debugStatus: () => "synthetic-first-qmd",
      isAvailable: () => true,
      search: async () => {
        firstWarmupStarts += 1;
        return [];
      },
    };
    (firstOrchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async (namespaces: string[]) => {
        firstRecoveredPlanNamespaces.push([...namespaces]);
        return namespaces.includes(dynamicRecord.namespace) ? 1 : 0;
      },
    });
    (firstOrchestrator as any).namespaceCatalog.listNamespaces = () => {
      firstCatalogCalls += 1;
      return rawCatalog;
    };
    (firstOrchestrator as any).maintenanceNamespaces = () => Promise.resolve(firstConfiguredNamespaces);
    (firstOrchestrator as any).namespaceSearchRouter.clearCache = () => undefined;
    (firstOrchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async (namespace: string) => {
      firstEnsuredNamespaces.push(namespace);
      return "present";
    };
    (firstOrchestrator as any).namespaceSearchRouter.updateNamespaces = async (namespaces: string[]) => {
      firstUpdatedNamespaces.push([...namespaces]);
      return namespaces.length;
    };

    const firstInitialized = await withTestDeadline(firstOrchestrator.initialize().then(() => "settled" as const));
    assert.equal(firstInitialized, "settled", "a raw correction catalog timeout must keep the first startup bounded");
    const firstDeferred = await withTestDeadline(
      (firstOrchestrator as any).deferredReady.then(() => "settled" as const),
    );
    assert.equal(firstDeferred, "settled", "the first fallback startup must settle");
    assert.equal(firstCatalogCalls, 1, "the first epoch must retain one raw correction catalog flight");
    assert.deepEqual(
      firstRecoveredPlanNamespaces,
      [firstConfiguredNamespaces],
      "the first timed-out correction sweep must recover only configured namespaces",
    );

    await firstOrchestrator.destroy();
    const firstWorkBeforeOldCatalogResolution = {
      ensuredNamespaces: [...firstEnsuredNamespaces],
      updatedNamespaces: firstUpdatedNamespaces.map((namespaces) => [...namespaces]),
      warmupStarts: firstWarmupStarts,
    };
    releaseRawCatalog?.([dynamicRecord]);
    await rawCatalog;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(
      firstRecoveredPlanNamespaces,
      [firstConfiguredNamespaces],
      "a raw catalog result from the destroyed epoch must not trigger late dynamic correction recovery",
    );
    assert.deepEqual(
      {
        ensuredNamespaces: firstEnsuredNamespaces,
        updatedNamespaces: firstUpdatedNamespaces,
        warmupStarts: firstWarmupStarts,
      },
      firstWorkBeforeOldCatalogResolution,
      "a raw catalog result from the destroyed epoch must not start ensure, update, or warmup work",
    );

    freshOrchestrator = new Orchestrator(
      parseConfig({
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
      }),
    );
    const freshConfiguredNamespaces = (freshOrchestrator as any).configuredNamespaceList() as string[];
    const freshRecoveredPlanNamespaces: string[][] = [];
    const freshEnsuredNamespaces: string[] = [];
    let freshCatalogCalls = 0;
    (freshOrchestrator as any).qmd = {
      probe: async () => true,
      debugStatus: () => "synthetic-fresh-qmd",
      isAvailable: () => true,
      search: async () => [],
    };
    (freshOrchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async (namespaces: string[]) => {
        freshRecoveredPlanNamespaces.push([...namespaces]);
        return namespaces.includes(dynamicRecord.namespace) ? 1 : 0;
      },
    });
    (freshOrchestrator as any).namespaceCatalog.listNamespaces = () => {
      freshCatalogCalls += 1;
      return Promise.resolve([dynamicRecord]);
    };
    (freshOrchestrator as any).maintenanceNamespaces = () => Promise.resolve([
      ...freshConfiguredNamespaces,
      dynamicRecord.namespace,
    ]);
    (freshOrchestrator as any).namespaceSearchRouter.clearCache = () => undefined;
    (freshOrchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async (namespace: string) => {
      freshEnsuredNamespaces.push(namespace);
      return "present";
    };
    (freshOrchestrator as any).namespaceSearchRouter.updateNamespaces = async (namespaces: string[]) => namespaces.length;

    const freshInitialized = await withTestDeadline(freshOrchestrator.initialize().then(() => "settled" as const));
    assert.equal(freshInitialized, "settled", "a fresh orchestrator must start a new epoch");
    const freshDeferred = await withTestDeadline(
      (freshOrchestrator as any).deferredReady.then(() => "settled" as const),
    );
    assert.equal(freshDeferred, "settled", "the fresh epoch deferred startup must settle");
    assert.equal(freshCatalogCalls, 1, "the fresh epoch must use its ready dynamic catalog result");
    assert.deepEqual(
      freshRecoveredPlanNamespaces,
      [[...freshConfiguredNamespaces, dynamicRecord.namespace]],
      "the fresh epoch must recover its dynamic namespace normally",
    );
    assert.deepEqual(
      freshEnsuredNamespaces,
      [...freshConfiguredNamespaces, dynamicRecord.namespace],
      "the fresh epoch must check its dynamic namespace normally",
    );
  } finally {
    await freshOrchestrator?.destroy().catch(() => undefined);
    await firstOrchestrator.destroy().catch(() => undefined);
    releaseRawCatalog?.([dynamicRecord]);
    await rawCatalog;
    if (originalTimeout === undefined) delete process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
    else process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = originalTimeout;
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("startup retries share one pending maintenance discovery and only a later retry consumes its snapshot", async () => {
  const originalTimeout = process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-startup-single-flight-"));
  const orchestrator = new Orchestrator(
    parseConfig({
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
    }),
  );
  const configuredNamespaces = (orchestrator as any).configuredNamespaceList() as string[];
  const dynamicNamespace = "dynamic";
  const ensuredNamespaces: string[] = [];
  const updatedNamespaces: string[][] = [];
  let warmupStarts = 0;
  let maintenanceCalls = 0;
  let releaseMaintenance: ((namespaces: string[]) => void) | undefined;
  const pendingMaintenance = new Promise<string[]>((resolve) => {
    releaseMaintenance = resolve;
  });

  try {
    process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = "1000";
    (orchestrator as any).qmd = {
      probe: async () => true,
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => {
        warmupStarts += 1;
        return [];
      },
    };
    (orchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async () => 0,
    });
    (orchestrator as any).namespaceCatalog.listNamespaces = () => Promise.resolve([]);
    (orchestrator as any).maintenanceNamespaces = () => {
      maintenanceCalls += 1;
      return pendingMaintenance;
    };
    (orchestrator as any).namespaceSearchRouter.clearCache = () => undefined;
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async (namespace: string) => {
      ensuredNamespaces.push(namespace);
      return "present";
    };
    (orchestrator as any).namespaceSearchRouter.updateNamespaces = async (namespaces: string[]) => {
      updatedNamespaces.push([...namespaces]);
      return namespaces.length;
    };

    const initialized = await withTestDeadline(orchestrator.initialize().then(() => "settled" as const));
    assert.equal(initialized, "settled", "a pending maintenance source must not block initialization");
    const deferred = await withTestDeadline((orchestrator as any).deferredReady.then(() => "settled" as const));
    assert.equal(deferred, "settled", "the deferred fallback pass must settle");

    const retries = [
      await withTestDeadline(orchestrator.startupSearchSync()),
      await withTestDeadline(orchestrator.startupSearchSync()),
      await withTestDeadline(orchestrator.startupSearchSync()),
    ];
    assert.deepEqual(retries, [false, false, false]);
    assert.equal(
      maintenanceCalls,
      1,
      "initial, deferred, and sequential retry callers must share one pending maintenance source in an epoch",
    );
    assert.deepEqual(
      ensuredNamespaces,
      [...configuredNamespaces, ...configuredNamespaces, ...configuredNamespaces, ...configuredNamespaces],
      "initial and retry fallback callers must retain configured namespace collection behavior",
    );

    const qmdStartsBeforeLateMaintenance = {
      ensuredNamespaces: [...ensuredNamespaces],
      updatedNamespaces: updatedNamespaces.map((namespaces) => [...namespaces]),
      warmupStarts,
    };
    releaseMaintenance?.([...configuredNamespaces, dynamicNamespace]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(
      {
        ensuredNamespaces,
        updatedNamespaces,
        warmupStarts,
      },
      qmdStartsBeforeLateMaintenance,
      "a late maintenance result must not automatically dispatch QMD work",
    );

    const completeRetry = await withTestDeadline(orchestrator.startupSearchSync());
    assert.equal(completeRetry, true, "a new explicit retry must consume the completed shared snapshot");
    assert.deepEqual(
      ensuredNamespaces.slice(-configuredNamespaces.length - 1),
      [...configuredNamespaces, dynamicNamespace],
      "the explicit complete retry must stage the dynamic namespace",
    );
  } finally {
    releaseMaintenance?.([...configuredNamespaces, dynamicNamespace]);
    if (originalTimeout === undefined) delete process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
    else process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = originalTimeout;
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("destroying a paused initializer prevents its later raw catalog and maintenance discovery", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-destroy-before-discovery-"));
  const orchestrator = new Orchestrator(
    parseConfig({
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
    }),
  );
  const configuredNamespaces = (orchestrator as any).configuredNamespaceList() as string[];
  const originalLoadAliases = (orchestrator as any).storage.loadAliases.bind((orchestrator as any).storage);
  let storageLoadCalls = 0;
  let releaseFirstStorageLoad: (() => void) | undefined;
  const firstStorageLoadReleased = new Promise<void>((resolve) => {
    releaseFirstStorageLoad = resolve;
  });
  let markFirstStorageLoad: (() => void) | undefined;
  const firstStorageLoadReached = new Promise<void>((resolve) => {
    markFirstStorageLoad = resolve;
  });
  let catalogCalls = 0;
  let maintenanceCalls = 0;

  try {
    (orchestrator as any).storage.loadAliases = async () => {
      storageLoadCalls += 1;
      if (storageLoadCalls === 1) {
        markFirstStorageLoad?.();
        await firstStorageLoadReleased;
      }
      return originalLoadAliases();
    };
    (orchestrator as any).qmd = {
      probe: async () => true,
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => [],
    };
    (orchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async () => 0,
    });
    (orchestrator as any).namespaceCatalog.listNamespaces = () => {
      catalogCalls += 1;
      return Promise.resolve([]);
    };
    (orchestrator as any).maintenanceNamespaces = () => {
      maintenanceCalls += 1;
      return Promise.resolve(configuredNamespaces);
    };

    const firstInitGate = (orchestrator as any).initPromise as Promise<void>;
    const firstInitialize = orchestrator.initialize();
    const firstDeferredReady = (orchestrator as any).deferredReady as Promise<void>;
    const paused = await withTestDeadline(firstStorageLoadReached);
    assert.notEqual(paused, "deadline", "the first initializer must pause before discovery");

    await orchestrator.destroy();
    releaseFirstStorageLoad?.();

    const firstResult = await withTestDeadline(firstInitialize.then(() => "settled" as const), 2_500);
    assert.equal(firstResult, "settled", "the destroyed initializer must settle safely after release");
    const initGateResult = await withTestDeadline(firstInitGate.then(() => "settled" as const), 2_500);
    assert.equal(initGateResult, "settled", "the destroyed initializer must not orphan its init gate");
    const deferredResult = await withTestDeadline(firstDeferredReady.then(() => "settled" as const), 2_500);
    assert.equal(deferredResult, "settled", "the destroyed initializer must not orphan its deferred gate");
    assert.equal(catalogCalls, 0, "the destroyed initializer must not start raw catalog discovery after retirement");
    assert.equal(maintenanceCalls, 0, "the destroyed initializer must not start raw maintenance discovery after retirement");
  } finally {
    releaseFirstStorageLoad?.();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a superseded paused initializer cannot admit discovery or resolve the newer deferred gate", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-superseded-before-discovery-"));
  const orchestrator = new Orchestrator(
    parseConfig({
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
    }),
  );
  const configuredNamespaces = (orchestrator as any).configuredNamespaceList() as string[];
  const originalLoadAliases = (orchestrator as any).storage.loadAliases.bind((orchestrator as any).storage);
  let storageLoadCalls = 0;
  let releaseFirstStorageLoad: (() => void) | undefined;
  const firstStorageLoadReleased = new Promise<void>((resolve) => {
    releaseFirstStorageLoad = resolve;
  });
  let markFirstStorageLoad: (() => void) | undefined;
  const firstStorageLoadReached = new Promise<void>((resolve) => {
    markFirstStorageLoad = resolve;
  });
  let releaseActiveProbe: (() => void) | undefined;
  const activeProbeReleased = new Promise<void>((resolve) => {
    releaseActiveProbe = resolve;
  });
  let markActiveProbe: (() => void) | undefined;
  const activeProbeReached = new Promise<void>((resolve) => {
    markActiveProbe = resolve;
  });
  let catalogCalls = 0;
  let maintenanceCalls = 0;
  let probeCalls = 0;

  try {
    (orchestrator as any).storage.loadAliases = async () => {
      storageLoadCalls += 1;
      if (storageLoadCalls === 1) {
        markFirstStorageLoad?.();
        await firstStorageLoadReleased;
      }
      return originalLoadAliases();
    };
    (orchestrator as any).qmd = {
      probe: async () => {
        probeCalls += 1;
        if (probeCalls === 1) {
          markActiveProbe?.();
          await activeProbeReleased;
        }
        return true;
      },
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => [],
    };
    (orchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async () => 0,
    });
    (orchestrator as any).namespaceCatalog.listNamespaces = () => {
      catalogCalls += 1;
      return Promise.resolve([]);
    };
    (orchestrator as any).maintenanceNamespaces = () => {
      maintenanceCalls += 1;
      return Promise.resolve(configuredNamespaces);
    };
    (orchestrator as any).namespaceSearchRouter.clearCache = () => undefined;
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async () => "present";
    (orchestrator as any).namespaceSearchRouter.updateNamespaces = async (namespaces: string[]) => namespaces.length;

    const initGate = (orchestrator as any).initPromise as Promise<void>;
    let initGateSettled = false;
    void initGate.then(() => {
      initGateSettled = true;
    });
    const firstInitialize = orchestrator.initialize();
    const firstDeferredReady = (orchestrator as any).deferredReady as Promise<void>;
    const paused = await withTestDeadline(firstStorageLoadReached);
    assert.notEqual(paused, "deadline", "the first initializer must pause before discovery");

    const secondInitialize = orchestrator.initialize();
    const secondDeferredReady = (orchestrator as any).deferredReady as Promise<void>;
    let secondDeferredSettled = false;
    void secondDeferredReady.then(() => {
      secondDeferredSettled = true;
    });
    const activeProbe = await withTestDeadline(activeProbeReached, 2_500);
    assert.notEqual(activeProbe, "deadline", "the replacement initializer must reach its probe");
    assert.equal(catalogCalls, 1, "only the replacement initializer may start the catalog flight");

    releaseFirstStorageLoad?.();
    const firstResult = await withTestDeadline(firstInitialize.then(() => "settled" as const), 2_500);
    assert.equal(firstResult, "settled", "the superseded initializer must settle safely after release");
    const firstDeferredResult = await withTestDeadline(firstDeferredReady.then(() => "settled" as const), 2_500);
    assert.equal(firstDeferredResult, "settled", "the superseded initializer must resolve its own deferred gate");
    await Promise.resolve();
    assert.equal(catalogCalls, 1, "the superseded initializer must not admit a second raw catalog flight");
    assert.equal(maintenanceCalls, 0, "the superseded initializer must not admit maintenance before the replacement reaches it");
    assert.equal(initGateSettled, false, "the superseded initializer must not resolve the replacement init gate");
    assert.equal(secondDeferredSettled, false, "the superseded initializer must not resolve the replacement deferred gate");

    releaseActiveProbe?.();
    const secondResult = await withTestDeadline(secondInitialize.then(() => "settled" as const), 2_500);
    assert.equal(secondResult, "settled", "the replacement initializer must complete normally");
    const initGateResult = await withTestDeadline(initGate.then(() => "settled" as const), 2_500);
    assert.equal(initGateResult, "settled", "the replacement initializer must resolve the shared init gate");
    const secondDeferredResult = await withTestDeadline(secondDeferredReady.then(() => "settled" as const), 2_500);
    assert.equal(secondDeferredResult, "settled", "the replacement deferred gate must settle with its own lifecycle");
    assert.equal(catalogCalls, 1, "the active lifecycle must retain exactly one catalog flight");
    assert.equal(maintenanceCalls, 1, "the active lifecycle must retain exactly one maintenance flight");
  } finally {
    releaseFirstStorageLoad?.();
    releaseActiveProbe?.();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("retiring an epoch before queued discovery admission starts no raw sources", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-retired-queued-discovery-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: true,
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
  let catalogCalls = 0;
  let maintenanceCalls = 0;

  try {
    (orchestrator as any).namespaceCatalog.listNamespaces = () => {
      catalogCalls += 1;
      return Promise.resolve([]);
    };
    (orchestrator as any).maintenanceNamespaces = () => {
      maintenanceCalls += 1;
      return Promise.resolve([]);
    };
    const coordinator = (orchestrator as any).orchestratorInitCoordinator;
    const epoch = coordinator.beginStartupEpoch();
    const catalogFlight = coordinator.correctionCatalogFlightFor(epoch);
    const maintenanceFlight = coordinator.maintenanceNamespacesFlightFor(epoch);
    coordinator.retireStartupEpoch();

    await Promise.all([catalogFlight, maintenanceFlight]);
    assert.deepEqual(
      { catalogCalls, maintenanceCalls },
      { catalogCalls: 0, maintenanceCalls: 0 },
      "retirement between raw-flight queueing and callback execution must suppress both non-cancellable source admissions",
    );
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a stale collection-check batch cannot replace the newer QMD backend", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-stale-collection-qmd-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: true,
      qmdMaintenanceEnabled: false,
      namespacesEnabled: true,
      namespaceCatalogEnabled: false,
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
  let releaseOldDefaultCheck: (() => void) | undefined;
  const oldDefaultCheckReleased = new Promise<void>((resolve) => {
    releaseOldDefaultCheck = resolve;
  });
  let markOldDefaultCheck: (() => void) | undefined;
  const oldDefaultCheckReached = new Promise<void>((resolve) => {
    markOldDefaultCheck = resolve;
  });
  let markNewDefaultCheck: (() => void) | undefined;
  const newDefaultCheckReached = new Promise<void>((resolve) => {
    markNewDefaultCheck = resolve;
  });
  let defaultCheckCalls = 0;
  let disposeCalls = 0;
  const newerQmd = {
    probe: async () => true,
    debugStatus: () => "newer-qmd",
    isAvailable: () => true,
    search: async () => [],
  };

  try {
    (orchestrator as any).qmd = {
      probe: async () => true,
      debugStatus: () => "old-qmd",
      isAvailable: () => true,
      search: async () => [],
    };
    (orchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async () => 0,
    });
    (orchestrator as any).maintenanceNamespaces = () =>
      Promise.resolve((orchestrator as any).configuredNamespaceList());
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async (namespace: string) => {
      if (namespace !== "default") return "present";
      defaultCheckCalls += 1;
      if (defaultCheckCalls === 1) {
        markOldDefaultCheck?.();
        await oldDefaultCheckReleased;
        return "missing";
      }
      markNewDefaultCheck?.();
      return "present";
    };
    (orchestrator as any).disposeSearchBackendIfNeeded = async () => {
      disposeCalls += 1;
    };

    const oldInitialize = orchestrator.initialize();
    const oldCheck = await withTestDeadline(oldDefaultCheckReached);
    assert.notEqual(oldCheck, "deadline", "the first epoch must pause in its collection-check batch");

    const newerInitialize = orchestrator.initialize();
    (orchestrator as any).qmd = newerQmd;
    const newCheck = await withTestDeadline(newDefaultCheckReached);
    assert.notEqual(newCheck, "deadline", "the replacement epoch must reach its collection check");
    const newerResult = await withTestDeadline(newerInitialize.then(() => "settled" as const), 2_500);
    assert.equal(newerResult, "settled", "the replacement epoch must finalize its QMD state");

    releaseOldDefaultCheck?.();
    const oldResult = await withTestDeadline(oldInitialize.then(() => "settled" as const), 2_500);
    assert.equal(oldResult, "settled", "the stale initializer must settle after its collection check releases");
    assert.equal(disposeCalls, 0, "a retired collection-check batch must not dispose the active backend");
    assert.equal(
      (orchestrator as any).qmd,
      newerQmd,
      "a retired collection-check batch must not replace the newer QMD backend with NoopSearchBackend",
    );
  } finally {
    releaseOldDefaultCheck?.();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a disposal that becomes stale cannot replace the newer QMD backend", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-stale-disposal-qmd-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: true,
      qmdMaintenanceEnabled: false,
      namespacesEnabled: true,
      namespaceCatalogEnabled: false,
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
  let releaseOldDisposal: (() => void) | undefined;
  const oldDisposalReleased = new Promise<void>((resolve) => {
    releaseOldDisposal = resolve;
  });
  let markOldDisposal: (() => void) | undefined;
  const oldDisposalReached = new Promise<void>((resolve) => {
    markOldDisposal = resolve;
  });
  let defaultCheckCalls = 0;
  const newerQmd = {
    probe: async () => true,
    debugStatus: () => "newer-qmd",
    isAvailable: () => true,
    search: async () => [],
  };

  try {
    (orchestrator as any).qmd = {
      probe: async () => true,
      debugStatus: () => "old-qmd",
      isAvailable: () => true,
      search: async () => [],
    };
    (orchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async () => 0,
    });
    (orchestrator as any).maintenanceNamespaces = () =>
      Promise.resolve((orchestrator as any).configuredNamespaceList());
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async (namespace: string) => {
      if (namespace !== "default") return "present";
      defaultCheckCalls += 1;
      return defaultCheckCalls === 1 ? "missing" : "present";
    };
    (orchestrator as any).disposeSearchBackendIfNeeded = async () => {
      markOldDisposal?.();
      await oldDisposalReleased;
    };

    const oldInitialize = orchestrator.initialize();
    const disposal = await withTestDeadline(oldDisposalReached);
    assert.notEqual(disposal, "deadline", "the first epoch must pause while disposing its missing backend");

    const newerInitialize = orchestrator.initialize();
    (orchestrator as any).qmd = newerQmd;
    const newerResult = await withTestDeadline(newerInitialize.then(() => "settled" as const), 2_500);
    assert.equal(newerResult, "settled", "the replacement epoch must finalize before stale disposal releases");

    releaseOldDisposal?.();
    const oldResult = await withTestDeadline(oldInitialize.then(() => "settled" as const), 2_500);
    assert.equal(oldResult, "settled", "the stale initializer must settle after disposal releases");
    assert.equal(
      (orchestrator as any).qmd,
      newerQmd,
      "a disposal completed by a retired epoch must not replace the newer QMD backend with NoopSearchBackend",
    );
  } finally {
    releaseOldDisposal?.();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a stale startup-search-sync disposal cannot replace the newer QMD backend", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-stale-retry-disposal-qmd-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: true,
      qmdMaintenanceEnabled: false,
      namespacesEnabled: true,
      namespaceCatalogEnabled: false,
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
  let releaseOldDisposal: (() => void) | undefined;
  const oldDisposalReleased = new Promise<void>((resolve) => {
    releaseOldDisposal = resolve;
  });
  let markOldDisposal: (() => void) | undefined;
  const oldDisposalReached = new Promise<void>((resolve) => {
    markOldDisposal = resolve;
  });
  let defaultCheckCalls = 0;
  const newerQmd = {
    available: true,
    probe: async () => true,
    debugStatus: () => "newer-qmd",
    isAvailable: () => true,
    search: async () => [],
  };

  try {
    (orchestrator as any).qmd = {
      available: true,
      probe: async () => true,
      debugStatus: () => "old-qmd",
      isAvailable: () => true,
      search: async () => [],
    };
    (orchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async () => 0,
    });
    (orchestrator as any).maintenanceNamespaces = () =>
      Promise.resolve((orchestrator as any).configuredNamespaceList());
    (orchestrator as any).namespaceSearchRouter.clearCache = () => undefined;
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async (namespace: string) => {
      if (namespace !== "default") return "present";
      defaultCheckCalls += 1;
      return defaultCheckCalls === 1 ? "missing" : "present";
    };
    (orchestrator as any).disposeSearchBackendIfNeeded = async () => {
      markOldDisposal?.();
      await oldDisposalReleased;
    };

    const oldSync = orchestrator.startupSearchSync();
    const disposal = await withTestDeadline(oldDisposalReached);
    assert.notEqual(disposal, "deadline", "the first retry must pause while disposing its missing backend");

    const newerInitialize = orchestrator.initialize();
    (orchestrator as any).qmd = newerQmd;
    const newerResult = await withTestDeadline(newerInitialize.then(() => "settled" as const), 2_500);
    assert.equal(newerResult, "settled", "the replacement epoch must finalize before stale retry disposal releases");

    releaseOldDisposal?.();
    const oldResult = await withTestDeadline(oldSync, 2_500);
    assert.equal(oldResult, false, "a stale retry must report no successful sync");
    assert.equal(
      (orchestrator as any).qmd,
      newerQmd,
      "a disposal completed by a retired retry must not replace the newer QMD backend with NoopSearchBackend",
    );
    assert.equal(newerQmd.available, true, "a stale retry must not disable the newer backend availability flag");
  } finally {
    releaseOldDisposal?.();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a newer epoch aborts a paused deferred warmup before cache cron or timer work", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-stale-deferred-warmup-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: true,
      qmdMaintenanceEnabled: false,
      namespacesEnabled: true,
      namespaceCatalogEnabled: false,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
      embeddingFallbackEnabled: false,
      identityContinuityEnabled: false,
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      compoundingEnabled: false,
      knowledgeIndexEnabled: false,
      wearables: {
        enabled: true,
        sources: { synthetic: { enabled: true } },
      },
    }),
  );
  let releaseOldWarmup: (() => void) | undefined;
  const oldWarmupReleased = new Promise<void>((resolve) => {
    releaseOldWarmup = resolve;
  });
  let markOldWarmup: (() => void) | undefined;
  const oldWarmupReached = new Promise<void>((resolve) => {
    markOldWarmup = resolve;
  });
  let releaseNewWarmup: (() => void) | undefined;
  const newWarmupReleased = new Promise<void>((resolve) => {
    releaseNewWarmup = resolve;
  });
  let markNewPrimary: (() => void) | undefined;
  const newPrimaryReached = new Promise<void>((resolve) => {
    markNewPrimary = resolve;
  });
  let releaseNewPrimary: (() => void) | undefined;
  const newPrimaryReleased = new Promise<void>((resolve) => {
    releaseNewPrimary = resolve;
  });
  let searchCalls = 0;
  let oldWarmupSignal: AbortSignal | undefined;
  let cacheCalls = 0;
  let cronCalls = 0;
  const originalLoadAliases = (orchestrator as any).storage.loadAliases.bind((orchestrator as any).storage);

  try {
    (orchestrator as any).qmd = {
      probe: async () => true,
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async (...args: any[]) => {
        searchCalls += 1;
        if (searchCalls === 1) {
          oldWarmupSignal = args[4]?.signal as AbortSignal | undefined;
          markOldWarmup?.();
          await oldWarmupReleased;
          return [];
        }
        await newWarmupReleased;
        return [];
      },
    };
    (orchestrator as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async () => 0,
    });
    (orchestrator as any).maintenanceNamespaces = () =>
      Promise.resolve((orchestrator as any).configuredNamespaceList());
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async () => "present";
    (orchestrator as any).storage.readAllMemories = async () => {
      cacheCalls += 1;
      return [];
    };
    (orchestrator as any).storage.readAllEntityFiles = async () => {
      cacheCalls += 1;
      return [];
    };
    (orchestrator as any).maintenanceScheduler.autoRegisterCrons = async () => {
      cronCalls += 1;
    };

    const oldInitialize = orchestrator.initialize();
    const oldDeferredReady = (orchestrator as any).deferredReady as Promise<void>;
    const oldWarmup = await withTestDeadline(oldWarmupReached);
    assert.notEqual(oldWarmup, "deadline", "the first deferred epoch must pause in warmup");
    assert.equal((orchestrator as any).deferredSyncSucceeded, true, "the old epoch must have recorded its successful sync before warmup");
    const cacheCallsBeforeReplacement = cacheCalls;

    (orchestrator as any).storage.loadAliases = async () => {
      markNewPrimary?.();
      await newPrimaryReleased;
      return originalLoadAliases();
    };
    const newerInitialize = orchestrator.initialize();
    const newerDeferredReady = (orchestrator as any).deferredReady as Promise<void>;
    const newPrimary = await withTestDeadline(newPrimaryReached);
    assert.notEqual(newPrimary, "deadline", "the replacement initializer must start a newer epoch");
    assert.equal(oldWarmupSignal?.aborted, true, "starting a newer epoch must abort the old deferred controller");
    assert.equal((orchestrator as any).deferredSyncSucceeded, false, "a newer epoch must not retain the old sync-success state");

    releaseOldWarmup?.();
    const oldDeferredResult = await withTestDeadline(oldDeferredReady.then(() => "settled" as const), 2_500);
    assert.equal(oldDeferredResult, "settled", "the retired deferred resolver must settle after its warmup releases");
    assert.deepEqual(
      {
        cacheCalls,
        cronCalls,
        wearablesAutoSyncHandle: (orchestrator as any).wearablesAutoSyncHandle,
        deferredSyncSucceeded: (orchestrator as any).deferredSyncSucceeded,
      },
      {
        cacheCalls: cacheCallsBeforeReplacement,
        cronCalls: 0,
        wearablesAutoSyncHandle: null,
        deferredSyncSucceeded: false,
      },
      "a retired warmup must not dispatch cache, cron, timer, or stale sync-status work",
    );

    releaseNewPrimary?.();
    const newerResult = await withTestDeadline(newerInitialize.then(() => "settled" as const), 2_500);
    assert.equal(newerResult, "settled", "the replacement initializer must settle after its primary pause releases");
    releaseNewWarmup?.();
    const newerDeferredResult = await withTestDeadline(newerDeferredReady.then(() => "settled" as const), 2_500);
    assert.equal(newerDeferredResult, "settled", "the replacement deferred lifecycle must finish before cleanup");
  } finally {
    releaseOldWarmup?.();
    releaseNewPrimary?.();
    releaseNewWarmup?.();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("real orchestrator missing collection disposes the backend and returns false on retry", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-real-noop-disposition-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: true,
      qmdMaintenanceEnabled: false,
      namespacesEnabled: true,
      namespaceCatalogEnabled: false,
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
  let disposeCalls = 0;
  const makeBackend = () => ({
    probe: async () => true,
    debugStatus: () => "synthetic-qmd",
    isAvailable: () => true,
    search: async () => [],
    dispose: async () => { disposeCalls += 1; },
  });

  try {
    (orchestrator as any).qmd = makeBackend();
    (orchestrator as any).passiveCorrectionService = () => ({ recoverStaleApplyingPlans: async () => 0 });
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async () => "missing";

    const initialized = await withTestDeadline(orchestrator.initialize().then(() => "settled" as const));
    assert.equal(initialized, "settled", "missing collection must remain a non-fatal initialization outcome");
    await withTestDeadline((orchestrator as any).deferredReady.then(() => "settled" as const));
    assert.equal(disposeCalls, 1, "the real Orchestrator disposer must dispose the missing backend");
    assert.ok((orchestrator as any).qmd instanceof NoopSearchBackend);
    assert.equal((orchestrator as any).qmd.isAvailable(), false);

    (orchestrator as any).qmd = makeBackend();
    const retry = await withTestDeadline(orchestrator.startupSearchSync());
    assert.equal(retry, false, "missing collection retry must return false rather than reject");
    assert.equal(disposeCalls, 2, "retry must use the same real disposer");
    assert.ok((orchestrator as any).qmd instanceof NoopSearchBackend);
  } finally {
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("retiring an epoch aborts its in-flight probe and primary collection check", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-epoch-qmd-abort-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: true,
      namespacesEnabled: true,
      namespaceCatalogEnabled: false,
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
  let releaseProbe: (() => void) | undefined;
  const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let markProbe: (() => void) | undefined;
  const probeReached = new Promise<void>((resolve) => { markProbe = resolve; });
  let probeSignal: AbortSignal | undefined;
  let releaseCollection: (() => void) | undefined;
  const collectionReleased = new Promise<void>((resolve) => { releaseCollection = resolve; });
  let markCollection: (() => void) | undefined;
  const collectionReached = new Promise<void>((resolve) => { markCollection = resolve; });
  let collectionSignal: AbortSignal | undefined;
  let probeCalls = 0;

  try {
    (orchestrator as any).qmd = {
      probe: async (execution?: { signal?: AbortSignal }) => {
        probeCalls += 1;
        if (probeCalls === 1) {
          probeSignal = execution?.signal;
          markProbe?.();
          await probeReleased;
        }
        return true;
      },
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => [],
    };
    (orchestrator as any).passiveCorrectionService = () => ({ recoverStaleApplyingPlans: async () => 0 });
    (orchestrator as any).namespaceSearchRouter.ensureNamespaceCollection = async (
      _namespace: string,
      execution?: { signal?: AbortSignal },
    ) => {
      collectionSignal = execution?.signal;
      markCollection?.();
      await collectionReleased;
      return "present";
    };

    const initialization = orchestrator.initialize();
    assert.notEqual(await withTestDeadline(probeReached), "deadline");
    const destroy = orchestrator.destroy();
    assert.equal(probeSignal?.aborted, true, "destroy must abort an in-flight primary QMD probe");
    releaseProbe?.();
    assert.equal(await withTestDeadline(initialization.then(() => "settled" as const)), "settled");
    assert.equal(await withTestDeadline(destroy.then(() => "settled" as const)), "settled");

    // Fresh lifecycle uses a new epoch controller; retirement during collection
    // must abort the controller forwarded to the real namespace-check seam.
    const freshInitialization = orchestrator.initialize();
    assert.notEqual(await withTestDeadline(collectionReached), "deadline");
    const freshDestroy = orchestrator.destroy();
    assert.equal(collectionSignal?.aborted, true, "destroy must abort an in-flight primary collection check");
    releaseCollection?.();
    assert.equal(await withTestDeadline(freshInitialization.then(() => "settled" as const)), "settled");
    assert.equal(await withTestDeadline(freshDestroy.then(() => "settled" as const)), "settled");
  } finally {
    releaseProbe?.();
    releaseCollection?.();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("startupSearchSync composes its caller abort into the QMD probe", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-retry-probe-abort-"));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: true,
      namespacesEnabled: true,
      namespaceCatalogEnabled: false,
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
  const callerAbort = new AbortController();
  let probeSignal: AbortSignal | undefined;
  let releaseProbe: (() => void) | undefined;
  const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let markProbe: (() => void) | undefined;
  const probeReached = new Promise<void>((resolve) => { markProbe = resolve; });

  try {
    (orchestrator as any).qmd = {
      probe: async (execution?: { signal?: AbortSignal }) => {
        probeSignal = execution?.signal;
        markProbe?.();
        await probeReleased;
        return true;
      },
      debugStatus: () => "synthetic-qmd",
      isAvailable: () => true,
      search: async () => [],
    };
    const retry = orchestrator.startupSearchSync(callerAbort.signal);
    assert.notEqual(await withTestDeadline(probeReached), "deadline");
    callerAbort.abort();
    assert.equal(probeSignal?.aborted, true, "caller abort must reach the in-flight retry QMD probe");
    releaseProbe?.();
    assert.equal(await withTestDeadline(retry), false, "aborted retry must return false after the probe releases");
  } finally {
    releaseProbe?.();
    await orchestrator.destroy().catch(() => undefined);
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
