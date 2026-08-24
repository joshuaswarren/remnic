import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";

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
      if (discoveryCalls === 2) resolveBothDiscoveriesStarted?.();
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
