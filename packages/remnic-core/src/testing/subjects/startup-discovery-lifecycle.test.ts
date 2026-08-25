import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../../config.js";
import { Orchestrator } from "../../orchestrator.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";

interface DynamicNamespaceRecord {
  namespace: string;
  identityToken: string;
  kind: "project";
  createdAt: string;
  storageDir: string;
  discoveredBy: "write";
}

interface StartupDiscoveryLifecycleState {
  readonly memoryDir: string;
  readonly configuredNamespaces: string[];
  readonly dynamicRecord: DynamicNamespaceRecord;
  readonly firstChecks: string[];
  readonly secondChecks: string[];
  readonly orchestrators: Orchestrator[];
  readonly originalTimeout: string | undefined;
  readonly firstQmd: object;
  releaseFirstDiscovery: ((records: unknown[]) => void) | undefined;
  firstInitSettled?: boolean;
  firstInitGateSettled?: boolean;
  firstDiscoveryTimedOut?: boolean;
  firstWasFailOpen?: boolean;
  secondInitSettled?: boolean;
  secondInitGateSettled?: boolean;
  secondWasFailOpen?: boolean;
  firstChecksBeforeRelease?: string[];
  secondChecksBeforeRelease?: string[];
}

async function withTestDeadline<T>(
  promise: Promise<T>,
  timeoutMs = 1_500,
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

function startupDiscoveryConfig(memoryDir: string) {
  return parseConfig({
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: true,
    qmdMaintenanceEnabled: false,
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
  });
}

function enabledQmd(): object {
  return {
    probe: async () => true,
    debugStatus: () => "startup-discovery-lifecycle-qmd",
    isAvailable: () => true,
    search: async () => [],
  };
}

function installCollectionCheckRecorder(orchestrator: Orchestrator, checks: string[]): void {
  const internal = orchestrator as any;
  internal.namespaceSearchRouter.clearCache = () => undefined;
  internal.namespaceSearchRouter.ensureNamespaceCollection = async (namespace: string) => {
    checks.push(namespace);
    return "present";
  };
}

async function initializeWithGate(orchestrator: Orchestrator): Promise<{
  initialize: "settled" | "deadline";
  initGate: "settled" | "deadline";
}> {
  const initPromise = (orchestrator as any).initPromise as Promise<void>;
  const [initialize, initGate] = await Promise.all([
    withTestDeadline(orchestrator.initialize().then(() => "settled" as const)),
    withTestDeadline(initPromise.then(() => "settled" as const)),
  ]);
  return { initialize, initGate };
}

const subject: LifecycleSubject<StartupDiscoveryLifecycleState> = {
  appliesTo(row: MatrixRow): boolean | string {
    switch (row.id) {
      case "restart-reload-recovery":
        return true;
      case "explicit-provider-identity":
        return "startup discovery accepts configured/catalog namespaces, not a session/provider identity";
      case "sparse-metadata-with-binding":
        return "startup discovery has no session metadata or remembered provider/session binding contract";
      case "sparse-metadata-without-binding":
        return "startup discovery has no sparse session metadata resolution surface";
      case "provider-rebinding":
        return "startup discovery neither owns nor mutates a provider binding";
      case "compaction-flush":
        return "startup discovery has no compaction or flush operation";
      case "before-reset":
        return "startup timeout is a readiness boundary, not a buffer before_reset flush";
      case "session-end":
        return "startup discovery has no session-end transition or shutdown-drain contract";
      case "dedupe-replay":
        return "ignoring a late discovery result is a stale-startup boundary, not a dedupe or replay contract";
    }
  },

  async setup(): Promise<StartupDiscoveryLifecycleState> {
    const originalTimeout = process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-startup-discovery-lifecycle-"));
    const orchestrators: Orchestrator[] = [];
    const firstChecks: string[] = [];
    const secondChecks: string[] = [];
    const dynamicRecord: DynamicNamespaceRecord = {
      namespace: "dynamic",
      identityToken: "dynamic",
      kind: "project",
      createdAt: new Date(0).toISOString(),
      storageDir: path.join(memoryDir, "namespaces", "dynamic"),
      discoveredBy: "write",
    };
    let releaseFirstDiscovery: ((records: unknown[]) => void) | undefined;

    try {
      process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = "1000";
      const first = new Orchestrator(startupDiscoveryConfig(memoryDir));
      orchestrators.push(first);
      const firstQmd = enabledQmd();
      (first as any).qmd = firstQmd;
      await mkdir(path.join(dynamicRecord.storageDir, "state"), { recursive: true });
      (first as any).passiveCorrectionService = () => ({
        recoverStaleApplyingPlans: async () => 0,
      });
      let firstCatalogCalls = 0;
      const firstDiscovery = new Promise<unknown[]>((resolve) => {
        releaseFirstDiscovery = resolve;
      });
      (first as any).namespaceCatalog.listNamespaces = () => {
        firstCatalogCalls += 1;
        return firstCatalogCalls === 1 ? Promise.resolve([dynamicRecord]) : firstDiscovery;
      };
      installCollectionCheckRecorder(first, firstChecks);
      const configuredNamespaces = (first as any).configuredNamespaceList() as string[];

      return {
        memoryDir,
        configuredNamespaces,
        dynamicRecord,
        firstChecks,
        secondChecks,
        orchestrators,
        originalTimeout,
        firstQmd,
        releaseFirstDiscovery,
      };
    } catch (error) {
      releaseFirstDiscovery?.([dynamicRecord]);
      if (originalTimeout === undefined) delete process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
      else process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = originalTimeout;
      await Promise.all(orchestrators.map((orchestrator) => orchestrator.destroy().catch(() => undefined)));
      await rm(memoryDir, { recursive: true, force: true });
      throw error;
    }
  },

  async exercise(state: StartupDiscoveryLifecycleState): Promise<void> {
    const first = state.orchestrators[0];
    assert.ok(first, "the first startup epoch must exist");
    const firstResult = await initializeWithGate(first);
    state.firstInitSettled = firstResult.initialize === "settled";
    state.firstInitGateSettled = firstResult.initGate === "settled";
    state.firstDiscoveryTimedOut = state.firstChecks.length === state.configuredNamespaces.length;
    state.firstWasFailOpen = (first as any).qmd === state.firstQmd;

    assert.equal(firstResult.initialize, "settled", "initial startup must not wait forever for catalog discovery");
    assert.equal(firstResult.initGate, "settled", "the real initPromise gate must settle after fallback discovery");
    assert.deepEqual(
      state.firstChecks,
      state.configuredNamespaces,
      "the timed-out first epoch must check only configured namespaces",
    );
    assert.equal(state.firstWasFailOpen, true, "an unknown startup check must keep QMD enabled fail-open");

    await first.destroy();

    const second = new Orchestrator(startupDiscoveryConfig(state.memoryDir));
    state.orchestrators.push(second);
    const secondQmd = enabledQmd();
    (second as any).qmd = secondQmd;
    (second as any).passiveCorrectionService = () => ({
      recoverStaleApplyingPlans: async () => 0,
    });
    (second as any).namespaceCatalog.listNamespaces = () => Promise.resolve([state.dynamicRecord]);
    installCollectionCheckRecorder(second, state.secondChecks);

    const secondResult = await initializeWithGate(second);
    state.secondInitSettled = secondResult.initialize === "settled";
    state.secondInitGateSettled = secondResult.initGate === "settled";
    state.secondWasFailOpen = (second as any).qmd === secondQmd;
    const completeNamespaces = [...state.configuredNamespaces, state.dynamicRecord.namespace];

    assert.equal(secondResult.initialize, "settled", "a fresh reload must initialize after complete discovery");
    assert.equal(secondResult.initGate, "settled", "the fresh instance's init gate must settle");
    assert.deepEqual(
      state.secondChecks,
      completeNamespaces,
      "the fresh epoch must discover and check the dynamic namespace",
    );
    assert.equal(state.secondWasFailOpen, true, "the fresh instance must retain its enabled QMD facade");

    state.firstChecksBeforeRelease = [...state.firstChecks];
    state.secondChecksBeforeRelease = [...state.secondChecks];
    state.releaseFirstDiscovery?.([state.dynamicRecord]);
    await Promise.resolve();
    await Promise.resolve();
  },

  async invariants(state: StartupDiscoveryLifecycleState): Promise<void> {
    assert.equal(state.firstInitSettled, true);
    assert.equal(state.firstInitGateSettled, true);
    assert.equal(state.firstDiscoveryTimedOut, true);
    assert.equal(state.firstWasFailOpen, true);
    assert.deepEqual(state.firstChecksBeforeRelease, state.configuredNamespaces);
    assert.deepEqual(
      state.firstChecks,
      state.firstChecksBeforeRelease,
      "the old catalog promise must not stage a stale dynamic check after its epoch is destroyed",
    );

    const completeNamespaces = [...state.configuredNamespaces, state.dynamicRecord.namespace];
    assert.equal(state.secondInitSettled, true);
    assert.equal(state.secondInitGateSettled, true);
    assert.equal(state.secondWasFailOpen, true);
    assert.deepEqual(state.secondChecksBeforeRelease, completeNamespaces);
    assert.deepEqual(
      state.secondChecks,
      state.secondChecksBeforeRelease,
      "releasing the old epoch must not schedule collection work on the fresh instance",
    );
  },

  async teardown(state: StartupDiscoveryLifecycleState): Promise<void> {
    state.releaseFirstDiscovery?.([state.dynamicRecord]);
    if (state.originalTimeout === undefined) delete process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
    else process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = state.originalTimeout;
    await Promise.all(state.orchestrators.map((orchestrator) => orchestrator.destroy().catch(() => undefined)));
    await rm(state.memoryDir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("startup-discovery-lifecycle", subject);
