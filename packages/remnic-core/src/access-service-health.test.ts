import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import { namespaceCollectionName } from "./namespaces/search.js";
import type { Orchestrator } from "./orchestrator.js";
import type { SearchBackend } from "./search/port.js";

function makeQmd(overrides: Partial<SearchBackend> & Record<string, unknown>): SearchBackend {
  return {
    async probe() {
      return false;
    },
    isAvailable() {
      return false;
    },
    debugStatus() {
      return "backend=noop";
    },
    async search() {
      return [];
    },
    async searchGlobal() {
      return [];
    },
    async bm25Search() {
      return [];
    },
    async vectorSearch() {
      return [];
    },
    async hybridSearch() {
      return [];
    },
    async update() {},
    async updateCollection() {},
    async embed() {},
    async embedCollection() {},
    async ensureCollection() {
      return "skipped";
    },
    ...overrides,
  } as SearchBackend;
}

test("health reports active QMD version and collection state", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-qmd-"));
  try {
    const config = parseConfig({
      memoryDir,
      searchBackend: "qmd",
      qmdEnabled: true,
      qmdCollection: "remnic-memory",
    });
    const qmd = makeQmd({
      probe: async () => true,
      isAvailable: () => true,
      debugStatus: () => "cli=true daemon=false cliPath=qmd cliVersion=qmd 2.5.3",
      checkCollection: async (collection, execution) => {
        assert.equal(collection, "remnic-memory");
        assert.ok(execution?.signal instanceof AbortSignal);
        return "present";
      },
      getVersionStatus: () => ({
        installedVersion: "qmd 2.5.3",
        supportedVersion: "2.5.3",
        supported: true,
        newerThanSupported: false,
        upgradeAvailable: false,
        capabilities: { doctor: true },
      }),
      isDaemonMode: () => false,
    });
    const service = new EngramAccessService({
      config,
      qmd,
      async getStorage() {
        return { dir: memoryDir };
      },
    } as unknown as Orchestrator);

    const health = await service.health();

    assert.equal(health.qmdEnabled, true);
    assert.deepEqual(health.qmd, {
      enabled: true,
      active: true,
      degraded: false,
      mode: "cli",
      collection: "remnic-memory",
      collectionState: "present",
      installedVersion: "qmd 2.5.3",
      supportedVersion: "2.5.3",
      supported: true,
      upgradeAvailable: false,
      doctorAvailable: true,
      debugStatus: "cli=true daemon=false cliPath=qmd cliVersion=qmd 2.5.3",
      pendingEmbeddings: null,
      oldestPendingAgeMs: null,
      embeddingBacklogThreshold: 1000,
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health treats qmdEmbeddingBacklogThreshold 0 as backlog degradation disabled", async () => {
  const config = parseConfig({ qmdEnabled: true, qmdEmbeddingBacklogThreshold: 0 });
  const qmd = makeQmd({
    probe: async () => true,
    isAvailable: () => true,
    checkCollection: async () => "present",
    status: async () => ({ pendingEmbeddings: 42, oldestPendingAgeMs: 90_000, totalFiles: 100, embeddedFiles: 58 }),
  });
  const service = new EngramAccessService({
    config,
    qmd,
    async getStorage() {
      return { dir: path.join(os.tmpdir(), "remnic-health-mock") };
    },
  } as unknown as Orchestrator);

  const health = await service.health();
  assert.equal(health.qmd?.degraded, false);
  assert.equal(health.qmd?.degradedReason, undefined);
  assert.equal(health.qmd?.pendingEmbeddings, 42);
  assert.equal(health.qmd?.embeddingBacklogThreshold, 0);
});

test("health marks QMD degraded when pending embeddings exceed a positive threshold", async () => {
  const config = parseConfig({ qmdEnabled: true, qmdEmbeddingBacklogThreshold: 10 });
  const qmd = makeQmd({
    probe: async () => true,
    isAvailable: () => true,
    checkCollection: async () => "present",
    status: async () => ({ pendingEmbeddings: 42, oldestPendingAgeMs: 90_000, totalFiles: 100, embeddedFiles: 58 }),
  });
  const service = new EngramAccessService({
    config,
    qmd,
    async getStorage() {
      return { dir: path.join(os.tmpdir(), "remnic-health-mock") };
    },
  } as unknown as Orchestrator);

  const health = await service.health();
  assert.equal(health.qmd?.degraded, true);
  assert.match(health.qmd?.degradedReason ?? "", /embedding-backlog/);
  assert.equal(health.qmd?.pendingEmbeddings, 42);
  assert.equal(health.qmd?.embeddingBacklogThreshold, 10);
});

test("health marks QMD as degraded when configured search falls back to noop", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-qmd-degraded-"));
  try {
    const config = parseConfig({
      memoryDir,
      searchBackend: "qmd",
      qmdEnabled: true,
      qmdCollection: "remnic-memory",
    });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({}),
      async getStorage() {
        return { dir: memoryDir };
      },
    } as unknown as Orchestrator);

    const health = await service.health();

    assert.equal(health.qmd.active, false);
    assert.equal(health.qmd.degraded, true);
    assert.equal(health.qmd.mode, "fallback");
    assert.equal(health.qmd.collectionState, "unknown");
    assert.equal(health.qmd.debugStatus, "backend=noop");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health marks QMD as degraded when the checked collection is missing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-qmd-missing-"));
  try {
    const config = parseConfig({
      memoryDir,
      searchBackend: "qmd",
      qmdEnabled: true,
      qmdCollection: "remnic-memory",
    });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({
        probe: async () => true,
        isAvailable: () => true,
        debugStatus: () => "cli=true daemon=false cliPath=qmd cliVersion=qmd 2.5.3",
        checkCollection: async () => "missing",
        isDaemonMode: () => false,
      }),
      async getStorage() {
        return { dir: memoryDir };
      },
    } as unknown as Orchestrator);

    const health = await service.health();

    assert.equal(health.qmd.collectionState, "missing");
    assert.equal(health.qmd.active, false);
    assert.equal(health.qmd.degraded, true);
    assert.equal(health.qmd.mode, "fallback");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health reports degraded diagnostics when read-only root QMD probe fails", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-qmd-stale-probe-"));
  try {
    const config = parseConfig({
      memoryDir,
      searchBackend: "qmd",
      qmdEnabled: true,
      qmdCollection: "remnic-memory",
    });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({
        probe: async () => false,
        isAvailable: () => true,
        debugStatus: () => "cli=true daemon=false cliPath=qmd cliVersion=qmd 2.5.3",
        checkCollection: async () => "present",
        isDaemonMode: () => false,
      }),
      async getStorage() {
        return { dir: memoryDir };
      },
    } as unknown as Orchestrator);

    const health = await service.health();

    assert.equal(health.qmd.active, true);
    assert.equal(health.qmd.degraded, true);
    assert.equal(health.qmd.mode, "cli");
    assert.equal(health.qmd.collectionState, "unknown");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health uses read-only root QMD availability checks", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-qmd-readonly-"));
  try {
    const config = parseConfig({
      memoryDir,
      searchBackend: "qmd",
      qmdEnabled: true,
      qmdCollection: "remnic-memory",
    });
    let checkAvailabilityCalled = false;
    let probeCalled = false;
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({
        probe: async () => {
          probeCalled = true;
          return true;
        },
        checkAvailability: async (execution) => {
          checkAvailabilityCalled = true;
          assert.ok(execution?.signal instanceof AbortSignal);
          return true;
        },
        isAvailable: () => true,
        debugStatus: () => "cli=true daemon=false cliPath=qmd cliVersion=qmd 2.5.3",
        checkCollection: async () => "present",
        isDaemonMode: () => false,
      }),
      async getStorage() {
        return { dir: memoryDir };
      },
    } as unknown as Orchestrator);

    const health = await service.health();

    assert.equal(checkAvailabilityCalled, true);
    assert.equal(probeCalled, false);
    assert.equal(health.qmd.active, true);
    assert.equal(health.qmd.degraded, false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health reports namespace-scoped QMD backend state", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-qmd-ns-"));
  try {
    const teamDir = path.join(rootDir, "namespaces", "team");
    const config = parseConfig({
      memoryDir: rootDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      searchBackend: "qmd",
      qmdEnabled: true,
      qmdCollection: "remnic-memory",
      namespacePolicies: [{ name: "team", readPrincipals: [], writePrincipals: [] }],
    });
    const expectedCollection = namespaceCollectionName("remnic-memory", "team", {
      defaultNamespace: "default",
    });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({}),
      async getStorage(namespace: string) {
        return { dir: namespace === "team" ? teamDir : rootDir };
      },
      async searchHealthForNamespace(namespace: string, execution?: { signal?: AbortSignal }) {
        assert.equal(namespace, "team");
        assert.ok(execution?.signal instanceof AbortSignal);
        return {
          collection: expectedCollection,
          available: true,
          collectionState: "present",
          debugStatus: "cli=true daemon=false cliPath=qmd cliVersion=qmd 2.5.3",
          installedVersion: "qmd 2.5.3",
          supportedVersion: "2.5.3",
          supported: true,
          upgradeAvailable: false,
          doctorAvailable: true,
          daemonMode: false,
        };
      },
    } as unknown as Orchestrator);

    const health = await service.health("team");

    assert.equal(health.memoryDir, teamDir);
    assert.equal(health.qmd.active, true);
    assert.equal(health.qmd.degraded, false);
    assert.equal(health.qmd.collection, expectedCollection);
    assert.equal(health.qmd.collectionState, "present");
    assert.equal(health.qmd.installedVersion, "qmd 2.5.3");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("health marks namespace QMD unknown collection state degraded", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-qmd-ns-unknown-"));
  try {
    const teamDir = path.join(rootDir, "namespaces", "team");
    const config = parseConfig({
      memoryDir: rootDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      searchBackend: "qmd",
      qmdEnabled: true,
      qmdCollection: "remnic-memory",
      namespacePolicies: [{ name: "team", readPrincipals: [], writePrincipals: [] }],
    });
    const expectedCollection = namespaceCollectionName("remnic-memory", "team", {
      defaultNamespace: "default",
    });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({}),
      async getStorage(namespace: string) {
        return { dir: namespace === "team" ? teamDir : rootDir };
      },
      async searchHealthForNamespace(namespace: string, execution?: { signal?: AbortSignal }) {
        assert.equal(namespace, "team");
        assert.ok(execution?.signal instanceof AbortSignal);
        return {
          collection: expectedCollection,
          available: true,
          collectionState: "unknown",
          debugStatus: "cli=true collection=unknown",
          installedVersion: "qmd 2.5.3",
          supportedVersion: "2.5.3",
          supported: true,
          upgradeAvailable: false,
          doctorAvailable: true,
          daemonMode: false,
        };
      },
    } as unknown as Orchestrator);

    const health = await service.health("team");

    assert.equal(health.memoryDir, teamDir);
    assert.equal(health.qmd.active, true);
    assert.equal(health.qmd.degraded, true);
    assert.equal(health.qmd.collection, expectedCollection);
    assert.equal(health.qmd.collectionState, "unknown");
    assert.equal(health.qmd.mode, "cli");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("health keeps namespace QMD failures scoped to the namespace", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-qmd-ns-fail-"));
  try {
    const teamDir = path.join(rootDir, "namespaces", "team");
    const config = parseConfig({
      memoryDir: rootDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      searchBackend: "qmd",
      qmdEnabled: true,
      qmdCollection: "remnic-memory",
      namespacePolicies: [{ name: "team", readPrincipals: [], writePrincipals: [] }],
    });
    const expectedCollection = namespaceCollectionName("remnic-memory", "team", {
      defaultNamespace: "default",
    });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({
        probe: async () => true,
        isAvailable: () => true,
        debugStatus: () => "root-qmd-should-not-leak",
        checkCollection: async () => "present",
      }),
      async getStorage(namespace: string) {
        return { dir: namespace === "team" ? teamDir : rootDir };
      },
      async searchHealthForNamespace() {
        throw new Error(`namespace probe timed out at ${teamDir}/qmd/index.sqlite`);
      },
    } as unknown as Orchestrator);

    const health = await service.health("team");

    assert.equal(health.memoryDir, teamDir);
    assert.equal(health.qmd.collection, expectedCollection);
    assert.equal(health.qmd.active, false);
    assert.equal(health.qmd.degraded, true);
    assert.equal(health.qmd.collectionState, "unknown");
    assert.equal(health.qmd.mode, "fallback");
    assert.equal(health.qmd.debugStatus, "backend=namespace-unavailable error=Error");
    assert.doesNotMatch(health.qmd.debugStatus, /root-qmd-should-not-leak/);
    assert.doesNotMatch(health.qmd.debugStatus, /index\.sqlite/);
    assert.doesNotMatch(health.qmd.debugStatus, /remnic-health-qmd-ns-fail/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("health surfaces extraction liveness as degraded when the buffer is non-empty and the watermark is stale", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-liveness-"));
  try {
    const oldTs = new Date(Date.now() - 10_000).toISOString();
    const config = parseConfig({ memoryDir, qmdEnabled: false, extractionLiveness: { staleWindowMs: 1000 } });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({}),
      buffer: {
        getBufferSnapshot: async () => ({ bufferedSessionCount: 3, pendingTurnCount: 12, oldestTurnTimestamp: oldTs }),
      },
      // The extraction watermark is read from the daemon-global root store,
      // not the per-namespace store (issue #2151).
      storage: {
        loadMeta: async () => ({
          lastExtractionAt: oldTs,
          extractionCount: 4,
          lastConsolidationAt: null,
          totalMemories: 0,
          totalEntities: 0,
        }),
      },
      async getStorage() {
        return { dir: memoryDir };
      },
    } as unknown as Orchestrator);

    const health = await service.health();
    assert.equal(health.extraction.degraded, true);
    assert.equal(health.extraction.bufferedSessionCount, 3);
    assert.equal(health.extraction.pendingTurnCount, 12);
    assert.equal(health.extraction.lastExtractionAt, oldTs);
    assert.ok((health.extraction.oldestBufferedTurnAgeMs ?? -1) >= 0, "oldest buffered turn age is computed");
    assert.ok(
      health.extraction.degradedReason !== null && health.extraction.degradedReason.length > 0,
      "degraded reason is populated",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health reports extraction liveness ok when the buffer is empty (nothing to extract)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-liveness-ok-"));
  try {
    const oldTs = new Date(Date.now() - 10_000).toISOString();
    const config = parseConfig({ memoryDir, qmdEnabled: false, extractionLiveness: { staleWindowMs: 1000 } });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({}),
      buffer: {
        getBufferSnapshot: async () => ({ bufferedSessionCount: 0, pendingTurnCount: 0, oldestTurnTimestamp: null }),
      },
      storage: {
        loadMeta: async () => ({
          lastExtractionAt: oldTs,
          extractionCount: 4,
          lastConsolidationAt: null,
          totalMemories: 0,
          totalEntities: 0,
        }),
      },
      async getStorage() {
        return { dir: memoryDir };
      },
    } as unknown as Orchestrator);

    const health = await service.health();
    assert.equal(health.extraction.degraded, false);
    assert.equal(health.extraction.bufferedSessionCount, 0);
    assert.equal(health.extraction.lastExtractionAt, oldTs);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health returns the same daemon-global extraction verdict for every namespace (issue #2151)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-liveness-ns-"));
  try {
    const rootTs = new Date().toISOString(); // fresh daemon-global watermark
    const staleTs = new Date(Date.now() - 7_200_000).toISOString(); // 2h old
    const config = parseConfig({
      memoryDir,
      qmdEnabled: false,
      namespacesEnabled: true,
      defaultNamespace: "default",
      extractionLiveness: { staleWindowMs: 3_600_000 },
    });
    // Per-namespace stores return DIVERGING watermarks (fresh vs 2h stale vs
    // never), but the global buffer is shared and the watermark must be sourced
    // from the root store. Pre-fix, the extraction verdict tracked the
    // namespace argument; post-fix it is identical for every namespace.
    const perNamespaceMeta: Record<string, string | null> = { fresh: rootTs, stale: staleTs };
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({}),
      buffer: {
        getBufferSnapshot: async () => ({ bufferedSessionCount: 3, pendingTurnCount: 12, oldestTurnTimestamp: staleTs }),
      },
      storage: {
        loadMeta: async () => ({
          lastExtractionAt: rootTs,
          extractionCount: 4,
          lastConsolidationAt: null,
          totalMemories: 0,
          totalEntities: 0,
        }),
      },
      async getStorage(namespace?: string) {
        return {
          dir: memoryDir,
          loadMeta: async () => ({
            lastExtractionAt: namespace ? perNamespaceMeta[namespace] ?? null : staleTs,
            extractionCount: 4,
            lastConsolidationAt: null,
            totalMemories: 0,
            totalEntities: 0,
          }),
        };
      },
    } as unknown as Orchestrator);

    const fresh = (await service.health("fresh")).extraction;
    const stale = (await service.health("stale")).extraction;
    const def = (await service.health()).extraction;
    // The namespace-governed fields must not vary with the namespace argument
    // (oldestBufferedTurnAgeMs is time-derived and intentionally excluded).
    assert.equal(stale.degraded, fresh.degraded, "degraded must not vary by namespace");
    assert.equal(def.degraded, fresh.degraded, "default health matches namespaced health");
    assert.equal(stale.lastExtractionAt, fresh.lastExtractionAt, "watermark must not vary by namespace");
    assert.equal(def.lastExtractionAt, fresh.lastExtractionAt);
    assert.equal(stale.degradedReason, fresh.degradedReason);
    // Sourced from the fresh root watermark → healthy despite stale per-namespace stores.
    assert.equal(fresh.degraded, false);
    assert.equal(fresh.lastExtractionAt, rootTs);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health reports extraction liveness degraded when the buffer read fails (§22)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-health-liveness-readfail-"));
  try {
    const freshTs = new Date().toISOString();
    const config = parseConfig({ memoryDir, qmdEnabled: false, extractionLiveness: { staleWindowMs: 3_600_000 } });
    const service = new EngramAccessService({
      config,
      qmd: makeQmd({}),
      buffer: {
        getBufferSnapshot: async () => {
          throw new Error("buffer file corrupt");
        },
      },
      // Fresh watermark → the ONLY fault is the unreadable buffer, proving the
      // read failure (not staleness) drives the degradation.
      storage: {
        loadMeta: async () => ({
          lastExtractionAt: freshTs,
          extractionCount: 4,
          lastConsolidationAt: null,
          totalMemories: 0,
          totalEntities: 0,
        }),
      },
      async getStorage() {
        return { dir: memoryDir };
      },
    } as unknown as Orchestrator);

    const health = await service.health();
    assert.equal(health.extraction.degraded, true, "an unreadable buffer must not report a healthy pipeline");
    assert.match(health.extraction.degradedReason ?? "", /unreadable/);
    assert.match(health.extraction.degradedReason ?? "", /buffer file corrupt/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
