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
