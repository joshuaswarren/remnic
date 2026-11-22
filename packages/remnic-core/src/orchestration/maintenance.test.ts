import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readProjectionRebuiltAt } from "../maintenance/projection-support.js";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setImmediate, setTimeout as delay } from "node:timers/promises";

import { MaintenanceScheduler } from "./maintenance.js";
import { EmbedHelper } from "../search/embed-helper.js";
import { OramaBackend } from "../search/orama-backend.js";
import {
  createProjectionRebuildScheduleState,
  maybeRebuildMemoryProjectionScheduled,
  type ProjectionRebuildScheduleState,
} from "./projection-rebuild-schedule.js";
import { rebuildMemoryProjection } from "../maintenance/rebuild-memory-projection.js";
import {
  probeProjectionHealth,
  readProjectedMemoryBrowse,
  
} from "../memory-projection-store.js";
import type { PluginConfig } from "../types.js";
import type { SearchBackend } from "../search/port.js";
import type {
  NamespaceSearchRouter,
  NamespaceUpdateResult,
} from "../namespaces/search.js";
import { NamespaceCatalog, type NamespaceRecord } from "../namespaces/catalog.js";
import { namespaceIdentityFromToken, namespaceIdentityToken } from "../namespaces/identity.js";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { readNamespaceMaintenanceStatuses } from "../maintenance/namespace-planner.js";
import { StorageManager } from "../storage.js";
import {
  decryptFileBody,
  encryptFileBody,
  filePathAad,
  isEncryptedFile,
  SECURE_STORE_ENVELOPE_OVERHEAD_BYTES,
} from "../secure-store/secure-fs.js";
import { pendingLifecycleLedgerDir } from "../storage/memory-lifecycle-ledger-access.js";
import { listContainedSpillFiles } from "../utils/path-containment.js";
import { rebuildMemoryLifecycleLedger } from "../maintenance/rebuild-memory-lifecycle-ledger.js";
import { resolveNamespaceStorageRoot } from "../namespaces/storage.js";

function fixtureConfig(overrides: Record<string, unknown>): PluginConfig {
  return {
    // Arm the debounced QMD maintenance gate the way the orchestrator does.
    qmdMaintenanceEnabled: true,
    // Keep the debounce timer from firing during the synchronous test pass;
    // dispose() clears it in finally.
    qmdMaintenanceDebounceMs: 60_000,
    ...overrides,
  } as unknown as PluginConfig;
}

function stubQmd(): SearchBackend {
  return { isAvailable: () => true } as unknown as SearchBackend;
}

function buildScheduler(opts: {
  config: PluginConfig;
  catalog: NamespaceCatalog;
  router: NamespaceSearchRouter;
}): MaintenanceScheduler {
  return new MaintenanceScheduler({
    config: opts.config,
    getQmd: () => stubQmd(),
    namespaceSearchRouter: opts.router,
    namespaceCatalog: opts.catalog,
  });
}

// ───────────────────────────────────────────────────────────────────────────

test("runQmdMaintenance updates and embeds cataloged dynamic namespaces (NGnei)", async () => {
  const updateArgs: string[] = [];
  const updateCalls: Array<{ namespaces: string[]; strict: boolean | undefined }> = [];
  const embedArgs: string[] = [];
  const embedCalls: string[][] = [];
  const memoryDir = path.join(os.tmpdir(), "remnic-qmd-maintenance-ngnei");
  const dynamicNamespace = "project-origin-dynamic";
  const dynamicStorageDir = path.join(
    memoryDir,
    "namespaces",
    namespaceIdentityToken(dynamicNamespace),
  );
  await mkdir(path.join(dynamicStorageDir, "facts"), { recursive: true });

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: true,
    qmdEmbedMinIntervalMs: 0,
  });
  const catalog = {
    enabled: true,
    async listNamespaces() {
      return [
        { namespace: "default" },
        {
          namespace: dynamicNamespace,
          identityToken: namespaceIdentityToken(dynamicNamespace),
          kind: "project",
          createdAt: "2026-04-12T12:00:00.000Z",
          storageDir: dynamicStorageDir,
          discoveredBy: "write",
        },
      ];
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(
      ns: string[],
      _execution: unknown,
      options: { strict?: boolean } | undefined,
    ): Promise<NamespaceUpdateResult> {
      updateCalls.push({ namespaces: [...ns], strict: options?.strict });
      updateArgs.push(...ns);
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(ns: string[]): Promise<void> {
      embedCalls.push([...ns]);
      embedArgs.push(...ns);
    },
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    assert.ok(updateArgs.length > 0, "updateNamespaces must be called");
    assert.equal(updateCalls.length, 1, "global QMD maintenance must batch selected namespaces into one update call");
    assert.equal(updateCalls[0]?.strict, true, "recurring QMD maintenance must use strict update semantics");
    assert.ok(
      updateArgs.includes(dynamicNamespace),
      "QMD update must cover the cataloged dynamic namespace, not just configured ones",
    );
    assert.ok(
      updateArgs.includes("default") && updateArgs.includes("shared"),
      "configured namespaces remain covered",
    );
    assert.ok(
      embedArgs.includes(dynamicNamespace),
      "QMD embed must cover the cataloged dynamic namespace",
    );
    assert.equal(embedCalls.length, 1, "QMD embed must batch all selected namespaces into one router call");
    assert.deepEqual(new Set(embedCalls[0]), new Set(["default", "shared", dynamicNamespace]));
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runQmdMaintenance tracks namespace embed cadence across budget rotation", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-namespace-embed-cadence-"));
  const updateCalls: string[][] = [];
  const embedCalls: string[][] = [];

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [{ name: "project-a" }, { name: "project-b" }],
    maintenanceMaxNamespacesPerCycle: 3,
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: true,
    qmdEmbedMinIntervalMs: 60_000,
  });
  const catalog = {
    enabled: false,
    async listNamespaces(): Promise<never[]> {
      throw new Error("catalog disabled - must not be read");
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      updateCalls.push([...ns]);
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(ns: string[]): Promise<void> {
      embedCalls.push([...ns]);
    },
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();
    // Re-arm pending for the second budget rotation (the debounce timer is
    // already armed from the first call, so this just re-sets the flag).
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    assert.deepEqual(updateCalls, [
      ["default", "shared", "project-a"],
      ["default", "shared", "project-b"],
    ]);
    assert.deepEqual(
      embedCalls,
      [["default", "shared", "project-a"], ["project-b"]],
      "a global embed timestamp must not suppress embeddings for newly budgeted namespaces",
    );
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runQmdMaintenance skips cataloged dynamic namespaces whose live root is unsafe", async () => {
  const updateArgs: string[] = [];
  const updateCalls: string[][] = [];
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-unsafe-root-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-unsafe-target-"));
  const dynamicNamespace = "project-origin-symlinked";
  const liveLegacyRoot = path.join(memoryDir, "namespaces", dynamicNamespace);
  const catalogSafeRoot = path.join(
    memoryDir,
    "namespaces",
    namespaceIdentityToken(dynamicNamespace),
  );
  await mkdir(path.dirname(liveLegacyRoot), { recursive: true });
  await symlink(outsideDir, liveLegacyRoot, "dir");

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 0,
  });
  const catalog = {
    enabled: true,
    async listNamespaces() {
      return [
        {
          namespace: dynamicNamespace,
          identityToken: namespaceIdentityToken(dynamicNamespace),
          kind: "project",
          createdAt: "2026-04-12T12:00:00.000Z",
          storageDir: catalogSafeRoot,
          discoveredBy: "write",
        },
      ];
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      updateCalls.push([...ns]);
      updateArgs.push(...ns);
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {},
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    assert.ok(updateArgs.length > 0, "updateNamespaces must be called");
    assert.equal(updateCalls.length, 1, "global QMD maintenance must update once for the locked namespace set");
    assert.deepEqual(
      [...updateArgs].sort(),
      ["default", "shared"],
      "cataloged dynamic namespaces are skipped when the live router root differs from the catalog-sanitized root",
    );
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("runQmdMaintenance treats zero namespace updates as failed maintenance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-zero-update-"));
  let markMaintenanceCalls = 0;
  let embedCalls = 0;

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 0,
  });
  const catalog = {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "default" }];
    },
    async markMaintenance() {
      markMaintenanceCalls += 1;
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(): Promise<NamespaceUpdateResult> {
      return { backendCount: 0, eligibleNamespaces: [] };
    },
    async embedNamespaces(): Promise<void> {
      embedCalls += 1;
    },
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    const statuses = await readNamespaceMaintenanceStatuses(config);
    assert.ok(
      statuses.some((status) => status.namespace === "default" && status.state === "failed"),
      "zero updates should be recorded as failed maintenance, not a successful run",
    );
    assert.equal(markMaintenanceCalls, 0);
    assert.equal(embedCalls, 0);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runQmdMaintenance treats partial namespace update eligibility as failed maintenance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-partial-update-"));
  let markMaintenanceCalls = 0;
  let embedCalls = 0;

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 0,
  });
  const catalog = {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "default" }];
    },
    async markMaintenance() {
      markMaintenanceCalls += 1;
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      assert.ok(ns.includes("default") && ns.includes("shared"));
      return { backendCount: 1, eligibleNamespaces: ["default"] };
    },
    async embedNamespaces(): Promise<void> {
      embedCalls += 1;
    },
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    const statuses = await readNamespaceMaintenanceStatuses(config);
    assert.ok(
      statuses.some((status) => status.namespace === "default" && status.state === "failed"),
      "partial update eligibility should not be recorded as successful maintenance",
    );
    assert.ok(
      statuses.some((status) => status.namespace === "shared" && status.state === "failed"),
      "ineligible selected namespaces should not be rotated as maintained",
    );
    assert.equal(markMaintenanceCalls, 0);
    assert.equal(embedCalls, 0);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runQmdMaintenance treats namespace embed errors as failed maintenance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-embed-failure-"));
  let markMaintenanceCalls = 0;

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: true,
    qmdEmbedMinIntervalMs: 0,
  });
  const catalog = {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "default" }];
    },
    async markMaintenance() {
      markMaintenanceCalls += 1;
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      return { backendCount: 1, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {
      throw Object.assign(new Error("embed failed"), { code: "EQMD" });
    },
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    const statuses = await readNamespaceMaintenanceStatuses(config);
    assert.ok(
      statuses.some((status) => status.namespace === "default" && status.state === "failed"),
      "embed failures should not be recorded as successful namespace maintenance",
    );
    assert.equal(markMaintenanceCalls, 0);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runQmdMaintenance records QMD min-interval throttles as skipped maintenance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-throttled-update-"));
  let markMaintenanceCalls = 0;
  let embedCalls = 0;
  let updateCalls = 0;

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 0,
  });
  const catalog = {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "default" }];
    },
    async markMaintenance() {
      markMaintenanceCalls += 1;
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(
      _ns: string[],
      _execution: unknown,
      options: { strict?: boolean } | undefined,
    ): Promise<NamespaceUpdateResult> {
      updateCalls += 1;
      assert.equal(options?.strict, true, "recurring maintenance must use strict QMD updates");
      throw new Error("QMD update skipped by global min-interval gate");
    },
    async embedNamespaces(): Promise<void> {
      embedCalls += 1;
    },
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    const statuses = await readNamespaceMaintenanceStatuses(config);
    assert.equal(updateCalls, 1, "strict global QMD maintenance should be attempted once");
    assert.ok(
      statuses.some(
        (status) =>
          status.namespace === "default" &&
          status.state === "skipped" &&
          status.reason === "throttled",
      ),
      "QMD min-interval throttles should be recorded as skipped maintenance",
    );
    assert.ok(
      statuses.some(
        (status) =>
          status.namespace === "shared" &&
          status.state === "skipped" &&
          status.reason === "throttled",
      ),
      "every selected namespace should receive the throttled skip status",
    );
    assert.equal(markMaintenanceCalls, 0);
    assert.equal(embedCalls, 0);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runQmdMaintenance still embeds when due update is throttled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-throttled-update-embed-"));
  let markMaintenanceCalls = 0;
  let updateCalls = 0;
  const embedCalls: string[][] = [];

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: true,
    qmdEmbedMinIntervalMs: 0,
  });
  const catalog = {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "default" }];
    },
    async markMaintenance() {
      markMaintenanceCalls += 1;
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(
      _ns: string[],
      _execution: unknown,
      options: { strict?: boolean } | undefined,
    ): Promise<NamespaceUpdateResult> {
      updateCalls += 1;
      assert.equal(options?.strict, true, "recurring maintenance must use strict QMD updates");
      throw new Error("QMD update skipped by global min-interval gate");
    },
    async embedNamespaces(
      ns: string[],
      options: { strict?: boolean } | undefined,
    ): Promise<void> {
      assert.equal(options?.strict, true, "due embed retries must surface embed failures");
      embedCalls.push([...ns]);
    },
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    const statuses = await readNamespaceMaintenanceStatuses(config);
    assert.equal(updateCalls, 1, "strict global QMD maintenance should be attempted once");
    assert.deepEqual(embedCalls, [["default", "shared"]]);
    assert.ok(
      statuses.every((status) => status.state === "skipped" && status.reason === "throttled"),
      "a throttled update should still be recorded as skipped after the due embed retry",
    );
    assert.equal(markMaintenanceCalls, 0);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runQmdMaintenance treats strict namespace update errors as failed maintenance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-update-failure-"));
  let markMaintenanceCalls = 0;
  let embedCalls = 0;
  let updateCalls = 0;

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: true,
    qmdEmbedMinIntervalMs: 0,
  });
  const catalog = {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "default" }];
    },
    async markMaintenance() {
      markMaintenanceCalls += 1;
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(
      _ns: string[],
      _execution: unknown,
      options: { strict?: boolean } | undefined,
    ): Promise<NamespaceUpdateResult> {
      updateCalls += 1;
      assert.equal(options?.strict, true, "recurring maintenance must require strict update failure propagation");
      throw new Error("qmd exploded");
    },
    async embedNamespaces(): Promise<void> {
      embedCalls += 1;
    },
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    const statuses = await readNamespaceMaintenanceStatuses(config);
    assert.equal(updateCalls, 1, "strict global QMD maintenance should be attempted once");
    assert.ok(
      statuses.some((status) => status.namespace === "default" && status.state === "failed"),
      "strict update errors should be recorded as failed maintenance",
    );
    assert.equal(markMaintenanceCalls, 0);
    assert.equal(embedCalls, 0);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runQmdMaintenance falls back to configured namespaces when the catalog is disabled (NGnei)", async () => {
  const updateArgs: string[] = [];
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-disabled-catalog-"));

  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 0,
  });
  const catalog = {
    enabled: false,
    async listNamespaces(): Promise<never[]> {
      throw new Error("catalog disabled — must not be read");
    },
  } as unknown as NamespaceCatalog;
  const router = {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      updateArgs.push(...ns);
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {},
  } as unknown as NamespaceSearchRouter;

  const scheduler = buildScheduler({ config, catalog, router });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();

    assert.ok(updateArgs.length > 0, "updateNamespaces must be called");
    assert.deepEqual(
      [...updateArgs].sort(),
      ["default", "shared"],
      "a disabled catalog covers exactly the configured set",
    );
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("MaintenanceScheduler reads a runtime-swapped qmd backend via getQmd (regression for captured-by-value)", async () => {
  const calls: string[] = [];
  const liveBackend = {
    isAvailable: () => true,
    async update() {
      calls.push("live.update");
    },
    async embed() {
      calls.push("live.embed");
    },
  } as unknown as SearchBackend;
  const noopBackend = {
    isAvailable: () => false,
    async update() {
      calls.push("noop.update");
    },
    async embed() {
      calls.push("noop.embed");
    },
  } as unknown as SearchBackend;
  const holder: { backend: SearchBackend } = { backend: liveBackend };

  const config = fixtureConfig({
    namespacesEnabled: false,
    qmdAutoEmbedEnabled: false,
  });
  const catalog = { enabled: false } as unknown as NamespaceCatalog;
  const router = {} as unknown as NamespaceSearchRouter;
  const scheduler = new MaintenanceScheduler({
    config,
    getQmd: () => holder.backend,
    namespaceSearchRouter: router,
    namespaceCatalog: catalog,
  });

  try {
    // Sanity: arming + running while the live backend is present invokes it.
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();
    assert.deepEqual(calls, ["live.update"]);

    holder.backend = noopBackend;
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();
    assert.deepEqual(
      calls,
      ["live.update"],
      "after the swap to NoopSearchBackend, requestQmdMaintenance must short-circuit (isAvailable===false) and never touch the disposed backend",
    );
  } finally {
    await scheduler.dispose();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────

interface CompactableScheduler {
  maybeCompactMemoryLifecycleLedger(): Promise<void>;
  lifecycleLedgerMaxBytes: number;
  lastLifecycleCompactionAtMs: number;
  dispose(): void;
}

async function seedMemoryDirWithOversizedLedger(
  padBytes: number,
): Promise<{ memoryDir: string; ledgerPath: string }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-"));
  await mkdir(path.join(memoryDir, "facts", "2026-03-08"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "facts", "2026-03-08", "fact-1.md"),
    `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
    "utf-8",
  );
  const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const line = '{"legacy":true,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';
  const rows = Math.ceil(padBytes / line.length);
  await writeFile(ledgerPath, line.repeat(rows), "utf-8");
  return { memoryDir, ledgerPath };
}

function buildCompactionScheduler(config: PluginConfig): CompactableScheduler {
  return new MaintenanceScheduler({
    config,
    getQmd: () => stubQmd(),
    namespaceSearchRouter: {} as unknown as NamespaceSearchRouter,
    namespaceCatalog: {} as unknown as NamespaceCatalog,
  }) as unknown as CompactableScheduler;
}

test("auto-compaction shrinks an oversized ledger and writes a verbatim backup", async () => {
  const { memoryDir, ledgerPath } = await seedMemoryDirWithOversizedLedger(4096);
  try {
    const before = await readFile(ledgerPath, "utf-8");
    const beforeSize = (await stat(ledgerPath)).size;
    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }

    const afterSize = (await stat(ledgerPath)).size;
    assert.ok(afterSize < beforeSize, "compacted ledger must be smaller");
    const rebuilt = (await readFile(ledgerPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rebuilt.map((r) => r.eventType), ["created", "updated"]);

    const archiveRoot = path.join(memoryDir, "archive", "memory-lifecycle-ledger");
    const stamps = await readdir(archiveRoot);
    assert.equal(stamps.length, 1);
    const backup = await readFile(
      path.join(archiveRoot, stamps[0]!, "state", "memory-lifecycle-ledger.jsonl"),
      "utf-8",
    );
    assert.equal(backup, before, "backup must be the verbatim original ledger");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction preserves append-only lifecycle events with no frontmatter equivalent (#1910)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-preserve-"));
  try {
    await mkdir(path.join(memoryDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "facts", "2026-03-08", "fact-1.md"),
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
      "utf-8",
    );
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const appendOnly = {
      eventId: "capture-1",
      memoryId: "fact-1",
      eventType: "explicit_capture_accepted",
      timestamp: "2026-03-08T02:00:00.000Z",
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    const pad = '{"legacy":true,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';
    await writeFile(
      ledgerPath,
      pad.repeat(Math.ceil(4096 / pad.length)) + `${JSON.stringify(appendOnly)}\n`,
      "utf-8",
    );

    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }

    const rebuilt = (await readFile(ledgerPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { eventId: string; eventType: string; legacy?: boolean });
    const eventTypes = rebuilt.map((r) => r.eventType);
    assert.ok(eventTypes.includes("created"));
    assert.ok(eventTypes.includes("updated"));
    assert.ok(
      rebuilt.some((r) => r.eventId === "capture-1" && r.eventType === "explicit_capture_accepted"),
      "append-only capture event must survive background compaction",
    );
    // Junk padding rows are still discarded — compaction shrank the ledger.
    assert.ok(!rebuilt.some((r) => r.legacy === true), "junk rows discarded");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction is disabled when memoryLifecycleLedgerCompactBytes is 0", async () => {
  const { memoryDir, ledgerPath } = await seedMemoryDirWithOversizedLedger(4096);
  try {
    const before = await readFile(ledgerPath, "utf-8");
    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 0,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }
    assert.equal(await readFile(ledgerPath, "utf-8"), before, "disabled: ledger untouched");
    await assert.rejects(() => readdir(path.join(memoryDir, "archive", "memory-lifecycle-ledger")));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction min-interval throttle prevents a second run within the window", async () => {
  const { memoryDir, ledgerPath } = await seedMemoryDirWithOversizedLedger(4096);
  try {
    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
      const compactedSize = (await stat(ledgerPath)).size;

      const line = '{"legacy":true,"pad":"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"}\n';
      await writeFile(ledgerPath, line.repeat(Math.ceil(4096 / line.length)), "utf-8");
      const regrownSize = (await stat(ledgerPath)).size;

      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.equal((await stat(ledgerPath)).size, regrownSize, "throttled: ledger not recompacted");
      assert.ok(regrownSize > compactedSize);
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction is a no-op when the ledger is below the threshold", async () => {
  const { memoryDir, ledgerPath } = await seedMemoryDirWithOversizedLedger(256);
  try {
    const before = await readFile(ledgerPath, "utf-8");
    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 1024 * 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }
    assert.equal(await readFile(ledgerPath, "utf-8"), before, "under threshold: ledger untouched");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction singleflight: two requests racing through the over-cap probe compact once (#2033)", async () => {
  const { memoryDir, ledgerPath } = await seedMemoryDirWithOversizedLedger(4096);
  try {
    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    ) as CompactableScheduler & {
      hasOverCapEncryptedLifecycleLedger: (targets: unknown) => Promise<boolean>;
      compactLifecycleLedgerTarget: (
        target: unknown,
        threshold: number,
      ) => Promise<"skipped" | "compacted" | "failed" | "deferred">;
    };
    try {
      // await between the singleflight guard and claiming it — is exercised.
      scheduler.lastLifecycleCompactionAtMs = Date.now();

      // Deterministically open the race window the reviewer flagged: gate the
      // over-cap probe so BOTH callers pass the early `lifecycleCompactionInFlight`
      // guard and park inside the same await, then release them together. An
      // over-cap encrypted ledger (probe => true) bypasses the throttle, so both
      // fall through toward claiming the guard.
      const { promise: probeGate, resolve: releaseProbe } = Promise.withResolvers<void>();
      const { promise: bothArrived, resolve: signalBothArrived } =
        Promise.withResolvers<void>();
      let probeArrivals = 0;
      scheduler.hasOverCapEncryptedLifecycleLedger = async () => {
        probeArrivals += 1;
        if (probeArrivals === 2) signalBothArrived();
        await probeGate;
        return true;
      };

      let compactions = 0;
      const realCompact = scheduler.compactLifecycleLedgerTarget.bind(scheduler);
      scheduler.compactLifecycleLedgerTarget = async (target, threshold) => {
        compactions += 1;
        return realCompact(target, threshold);
      };

      const a = scheduler.maybeCompactMemoryLifecycleLedger();
      const b = scheduler.maybeCompactMemoryLifecycleLedger();
      await bothArrived;
      releaseProbe();
      await Promise.all([a, b]);

      assert.equal(
        compactions,
        1,
        "exactly one caller compacts; the racing caller must re-observe the singleflight guard after the probe",
      );

      const archiveRoot = path.join(memoryDir, "archive", "memory-lifecycle-ledger");
      const stamps = await readdir(archiveRoot);
      assert.equal(stamps.length, 1, "only one compaction backup exists");
      assert.ok((await stat(ledgerPath)).size < 4096, "ledger was compacted once");
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

function buildCompactionSchedulerWithStorage(
  config: PluginConfig,
  getStorage: () => StorageManager,
  storageForNamespace?: (namespace: string) => Promise<StorageManager>,
  namespaceCatalog?: NamespaceCatalog,
): CompactableScheduler {
  return new MaintenanceScheduler({
    config,
    getQmd: () => stubQmd(),
    namespaceSearchRouter: {} as unknown as NamespaceSearchRouter,
    namespaceCatalog: (namespaceCatalog ?? ({} as unknown as NamespaceCatalog)),
    getStorage,
    storageForNamespace,
  }) as unknown as CompactableScheduler;
}

test("auto-compaction leaves the throttle un-advanced after a failed run so it retries next pass", async () => {
  const { memoryDir, ledgerPath } = await seedMemoryDirWithOversizedLedger(4096);
  try {
    const beforeSize = (await stat(ledgerPath)).size;
    // A required-but-locked secure store makes the rewrite throw
    // SecureStoreLockedError, so the first compaction fails.
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreRequired(true);
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => storage,
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.equal((await stat(ledgerPath)).size, beforeSize, "failed run leaves ledger intact");

      storage.setSecureStoreKey(Buffer.alloc(32, 9));
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.ok(
        (await stat(ledgerPath)).size < beforeSize,
        "still-eligible retry compacts once the failure clears",
      );
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction rewrites the ledger encrypted at rest under a secure store", async () => {
  const { memoryDir, ledgerPath } = await seedMemoryDirWithOversizedLedger(4096);
  try {
    const before = await readFile(ledgerPath, "utf-8");
    const beforeSize = before.length;
    const key = Buffer.alloc(32, 5);
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key);
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => storage,
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }
    // The rewritten ledger is encrypted at rest and smaller than the plaintext
    // original, and decrypts back to the rebuilt events via the same key.
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "compacted ledger must be encrypted");
    assert.ok((await stat(ledgerPath)).size < beforeSize);
    const rebuilt = await storage.readAllMemoryLifecycleEvents();
    assert.deepEqual(rebuilt.map((e) => e.eventType), ["created", "updated"]);
    const archiveRoot = path.join(memoryDir, "archive", "memory-lifecycle-ledger");
    const stamps = await readdir(archiveRoot);
    assert.equal(stamps.length, 1);
    assert.equal(
      await readFile(
        path.join(archiveRoot, stamps[0]!, "state", "memory-lifecycle-ledger.jsonl"),
        "utf-8",
      ),
      before,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction re-encrypts an ENCRYPTED ledger's backup for the archive path so it decrypts there, not with the source AAD (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-enc-backup-"));
  try {
    await mkdir(path.join(memoryDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "facts", "2026-03-08", "fact-1.md"),
      `---\nid: fact-1\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["alpha"]\n---\n\nalpha\n`,
      "utf-8",
    );
    const key = Buffer.alloc(32, 6);
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const legacyIds = Array.from({ length: 80 }, (_, i) => `evt-legacy-${i}`);
    const plaintextLedger = legacyIds
      .map((id) => JSON.stringify({
        schemaVersion: 1, eventId: id, memoryId: "m-legacy", eventType: "note",
        timestamp: "2026-03-08T00:00:00.000Z", actor: "t", ruleVersion: "1",
      }))
      .join("\n") + "\n";
    await writeFile(ledgerPath, encryptFileBody(plaintextLedger, key, filePathAad(ledgerPath, memoryDir)));
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "precondition: source ledger encrypted");

    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key);
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => storage,
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }

    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "compacted ledger stays encrypted at rest");

    const archiveRoot = path.join(memoryDir, "archive", "memory-lifecycle-ledger");
    const stamps = await readdir(archiveRoot);
    assert.equal(stamps.length, 1);
    const backupPath = path.join(archiveRoot, stamps[0]!, "state", "memory-lifecycle-ledger.jsonl");
    const backupBytes = await readFile(backupPath);
    assert.ok(isEncryptedFile(backupBytes), "backup encrypted at rest (no plaintext leak)");
    const decrypted = decryptFileBody(backupBytes, key, filePathAad(backupPath, memoryDir)).toString("utf8");
    const decryptedIds = decrypted
      .trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l).eventId as string)
      .sort();
    assert.deepEqual(
      decryptedIds,
      [...legacyIds].sort(),
      "backup preserves exactly the prior ledger's events, decryptable at the archive path",
    );
    assert.throws(
      () => decryptFileBody(backupBytes, key, filePathAad(ledgerPath, memoryDir)),
      "backup must NOT decrypt under the SOURCE-path AAD (proves re-encrypt, not byte copy)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("mixed pass: a deferred encrypted target keeps the throttle un-armed so untouched ledgers retry (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-mixed-"));
  try {
    const junk = '{"legacy":true,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';
    const junkBlob = junk.repeat(Math.ceil(4096 / junk.length));

    await mkdir(path.join(root, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(root, "facts", "2026-03-08", "fact-root.md"),
      `---\nid: fact-root\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["alpha"]\n---\n\nalpha\n`,
      "utf-8",
    );
    const rootLedger = path.join(root, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(rootLedger), { recursive: true });
    await writeFile(rootLedger, junkBlob, "utf-8");

    const key = Buffer.alloc(32, 5);
    const nsDir = path.join(root, "namespaces", namespaceIdentityToken("locked-ns"));
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const encrypted = encryptFileBody(junkBlob, key, filePathAad(nsLedger, nsDir));
    await writeFile(nsLedger, encrypted);

    const catalog = {
      enabled: true,
      listNamespaces: async (): Promise<NamespaceRecord[]> =>
        [{ namespace: "locked-ns", storageDir: nsDir } as unknown as NamespaceRecord],
    } as unknown as NamespaceCatalog;
    const nsStorage = new StorageManager(nsDir);
    nsStorage.setSecureStoreRequired(true); // required + no key → locked (deferred).
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir: root,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => new StorageManager(root),
      async () => nsStorage,
      catalog,
    );
    try {
      const rootBefore = (await stat(rootLedger)).size;
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.ok((await stat(rootLedger)).size < rootBefore, "root ledger compacted");
      assert.deepEqual(
        await readFile(nsLedger),
        encrypted,
        "encrypted+locked namespace ledger deferred, left byte-for-byte intact",
      );

      await writeFile(rootLedger, junkBlob, "utf-8");
      const regrown = (await stat(rootLedger)).size;
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.ok(
        (await stat(rootLedger)).size < regrown,
        "deferred target left the throttle un-armed: the second in-window pass recompacts",
      );
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maintenance drains a pending lifecycle-append spill even when compaction is disabled (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-drain-"));
  try {
    const key = Buffer.alloc(32, 7);
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreKey(key);
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);
    await mkdir(spillDir, { recursive: true });
    const spillPath = path.join(spillDir, "spill.jsonl");
    const row =
      `{"eventId":"evt-spilled","memoryId":"m","eventType":"created",`
      + `"timestamp":"2026-03-08T00:00:00.000Z","actor":"t","ruleVersion":"1"}\n`;
    await writeFile(spillPath, encryptFileBody(row, key, filePathAad(spillPath, memoryDir)));

    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 0,
        memoryLifecycleLedgerCompactMinIntervalMs: 1,
      }),
      () => storage,
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }

    const ids = (await storage.readAllMemoryLifecycleEvents()).map((e) => e.eventId);
    assert.ok(ids.includes("evt-spilled"), "spill drained into the ledger with compaction disabled");
    await assert.rejects(() => stat(spillPath), /ENOENT/, "spill file removed after drain");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("maintenance drains a namespace pending spill created after the throttle armed, before returning on the min-interval throttle (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-drain-throttled-"));
  try {
    const junk = '{"legacy":true,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';
    const junkBlob = junk.repeat(Math.ceil(4096 / junk.length));
    await mkdir(path.join(root, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(root, "facts", "2026-03-08", "fact-root.md"),
      `---\nid: fact-root\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["alpha"]\n---\n\nalpha\n`,
      "utf-8",
    );
    const rootLedger = path.join(root, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(rootLedger), { recursive: true });
    await writeFile(rootLedger, junkBlob, "utf-8");

    const key = Buffer.alloc(32, 7);
    const token = namespaceIdentityToken("project-alpha");
    const nsDir = path.join(root, "namespaces", token);
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const nsStorage = new StorageManager(nsDir);
    nsStorage.setSecureStoreKey(key);
    const catalog = {
      enabled: true,
      listNamespaces: async (): Promise<NamespaceRecord[]> =>
        [{ namespace: "project-alpha", storageDir: nsDir } as unknown as NamespaceRecord],
    } as unknown as NamespaceCatalog;
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir: root,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => new StorageManager(root),
      async () => nsStorage,
      catalog,
    );
    try {
      const rootBefore = (await stat(rootLedger)).size;
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.ok((await stat(rootLedger)).size < rootBefore, "root ledger compacted on the first pass");

      const spillDir = pendingLifecycleLedgerDir(nsLedger);
      await mkdir(spillDir, { recursive: true });
      const spillPath = path.join(spillDir, "spill.jsonl");
      const row =
        `{"eventId":"evt-ns-spilled","memoryId":"m","eventType":"created",`
        + `"timestamp":"2026-03-08T00:00:00.000Z","actor":"t","ruleVersion":"1"}\n`;
      await writeFile(spillPath, encryptFileBody(row, key, filePathAad(spillPath, nsDir)));

      await scheduler.maybeCompactMemoryLifecycleLedger();
      const ids = (await nsStorage.readAllMemoryLifecycleEvents()).map((e) => e.eventId);
      assert.ok(
        ids.includes("evt-ns-spilled"),
        "namespace spill drained before the throttle return, not stranded until the interval elapses",
      );
      await assert.rejects(() => stat(spillPath), /ENOENT/, "namespace spill file removed after drain");
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-compaction bounds per-namespace ledgers, not just the root state path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-"));
  try {
    const token = namespaceIdentityToken("project-alpha");
    const nsDir = path.join(root, "namespaces", token);
    await mkdir(path.join(nsDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(nsDir, "facts", "2026-03-08", "fact-ns.md"),
      `---\nid: fact-ns\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["alpha"]\n---\n\nalpha\n`,
      "utf-8",
    );
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const line = '{"legacy":true,"pad":"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}\n';
    await writeFile(nsLedger, line.repeat(Math.ceil(4096 / line.length)), "utf-8");
    const beforeSize = (await stat(nsLedger)).size;

    const catalog = {
      enabled: true,
      listNamespaces: async (): Promise<NamespaceRecord[]> =>
        [{ namespace: "project-alpha", storageDir: nsDir } as unknown as NamespaceRecord],
    } as unknown as NamespaceCatalog;
    const nsStorages = new Map<string, StorageManager>();
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir: root,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => new StorageManager(root),
      async (namespace) => {
        let sm = nsStorages.get(namespace);
        if (!sm) {
          sm = new StorageManager(nsDir);
          nsStorages.set(namespace, sm);
        }
        return sm;
      },
      catalog,
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }
    assert.ok((await stat(nsLedger)).size < beforeSize, "namespace ledger must be compacted");
    const rebuilt = (await readFile(nsLedger, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rebuilt.map((r) => r.eventType), ["created", "updated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog-disabled fallback never downgrades an encrypted namespace ledger to plaintext (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-secure-"));
  try {
    const key = Buffer.alloc(32, 5);
    const token = namespaceIdentityToken("project-secure");
    const nsDir = path.join(root, "namespaces", token);
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const junk = '{"legacy":true,"pad":"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}\n';
    const encrypted = encryptFileBody(
      junk.repeat(Math.ceil(4096 / junk.length)), key, filePathAad(nsLedger, nsDir),
    );
    await writeFile(nsLedger, encrypted);
    assert.ok(isEncryptedFile(await readFile(nsLedger)), "precondition: ledger encrypted");

    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }
    assert.deepEqual(
      await readFile(nsLedger),
      encrypted,
      "encrypted namespace ledger must be left untouched, never plaintext-rewritten",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog-disabled fallback compacts an encrypted over-cap namespace ledger through the keyed store (#2033 thread PRRT_kwDORJXyws6SEvWo)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-secure-keyed-"));
  try {
    const key = Buffer.alloc(32, 5);
    const nsName = "project-secure-keyed";
    const token = namespaceIdentityToken(nsName);
    const nsDir = path.join(root, "namespaces", token);
    await mkdir(path.join(nsDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(nsDir, "facts", "2026-03-08", "fact-ns.md"),
      `---\nid: fact-ns\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["secure"]\n---\n\nsecure\n`,
      "utf-8",
    );
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const junk = '{"legacy":true,"pad":"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}\n';
    const encrypted = encryptFileBody(
      junk.repeat(Math.ceil(4096 / junk.length)), key, filePathAad(nsLedger, nsDir),
    );
    await writeFile(nsLedger, encrypted);
    assert.ok(isEncryptedFile(await readFile(nsLedger)), "precondition: ledger encrypted");
    const beforeSize = (await stat(nsLedger)).size;

    const nsStorage = new StorageManager(nsDir);
    nsStorage.setSecureStoreRequired(true);
    nsStorage.setSecureStoreKey(key); // unlocked + encrypt-on-write ⇒ rewrite stays encrypted.
    let resolverCalls = 0;
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        secureStoreEnabled: true,
        secureStoreEncryptOnWrite: true,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => new StorageManager(root), // root has no ledger ⇒ skipped.
      async (namespace) => {
        resolverCalls += 1;
        assert.equal(namespace, nsName, "fallback resolves by the DECODED namespace, not the raw token");
        return nsStorage;
      },
      undefined, // catalog disabled.
    );
    const seam = scheduler as unknown as CompactableScheduler & {
      resolveLifecycleCompactionTargets: () => Promise<
        Array<{ memoryDir: string; storage?: StorageManager }>
      >;
      compactLifecycleLedgerTarget: (
        target: unknown,
        threshold: number,
      ) => Promise<"skipped" | "compacted" | "failed" | "deferred">;
    };
    try {
      const targets = await seam.resolveLifecycleCompactionTargets();
      assert.ok(resolverCalls > 0, "the fallback consulted the namespace storage resolver");
      const nsTarget = targets.find(
        (t) => path.resolve(t.memoryDir) === path.resolve(nsDir),
      );
      assert.ok(nsTarget, "fallback discovered the per-namespace ledger dir");
      assert.ok(nsTarget?.storage, "fallback target carries a keyed StorageManager, not a keyless dir");
      assert.ok(
        nsTarget?.storage?.isSecureStoreUnlocked(),
        "fallback target storage is unlocked so the encrypted ledger can be rewritten",
      );

      // The core proof: the encrypted over-cap ledger COMPACTS, it does not defer.
      const outcome = await seam.compactLifecycleLedgerTarget(nsTarget, 1024);
      assert.equal(
        outcome,
        "compacted",
        "encrypted fallback ledger compacts through the keyed store, never deferred forever",
      );
    } finally {
      await scheduler.dispose();
    }

    assert.notDeepEqual(
      await readFile(nsLedger),
      encrypted,
      "ledger was rewritten (not left byte-for-byte intact, i.e. not deferred)",
    );
    assert.ok((await stat(nsLedger)).size < beforeSize, "compacted ledger is smaller");
    assert.ok(
      isEncryptedFile(await readFile(nsLedger)),
      "compacted ledger stays encrypted at rest (namespace isolation + at-rest format preserved)",
    );
    const rebuilt = await nsStorage.readAllMemoryLifecycleEvents();
    assert.deepEqual(rebuilt.map((e) => e.eventType), ["created", "updated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog-disabled fallback decodes a long tokenized namespace dir so an encrypted over-cap ledger compacts instead of deferring forever (#2033 thread PRRT_kwDORJXyws6SE5fv)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-longtoken-"));
  try {
    const nsName = "project-origin-with-a-verylong-namespace";
    const token = namespaceIdentityToken(nsName);
    assert.ok(nsName.length >= 31, "precondition: namespace long enough to overflow the routed token");
    assert.ok(isSafeRouteNamespace(nsName), "precondition: the namespace itself is a valid route namespace");
    assert.ok(token.length > 64, "precondition: the tokenized dir name exceeds the 64-char route limit");
    assert.ok(!isSafeRouteNamespace(token), "precondition: the raw token would be REJECTED as a route namespace");
    assert.equal(namespaceIdentityFromToken(token), nsName, "precondition: the token decodes back to the namespace");

    const key = Buffer.alloc(32, 7);
    const nsDir = path.join(root, "namespaces", token);
    await mkdir(path.join(nsDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(nsDir, "facts", "2026-03-08", "fact-ns.md"),
      `---\nid: fact-ns\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["long"]\n---\n\nlong\n`,
      "utf-8",
    );
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const junk = '{"legacy":true,"pad":"wwwwwwwwwwwwwwwwwwwwwwwwwwwwww"}\n';
    const encrypted = encryptFileBody(
      junk.repeat(Math.ceil(4096 / junk.length)), key, filePathAad(nsLedger, nsDir),
    );
    await writeFile(nsLedger, encrypted);
    assert.ok(isEncryptedFile(await readFile(nsLedger)), "precondition: ledger encrypted");
    const beforeSize = (await stat(nsLedger)).size;

    const nsStorage = new StorageManager(nsDir);
    nsStorage.setSecureStoreRequired(true);
    nsStorage.setSecureStoreKey(key); // unlocked + encrypt-on-write ⇒ rewrite stays encrypted.
    let resolvedWith: string | null = null;
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        secureStoreEnabled: true,
        secureStoreEncryptOnWrite: true,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => new StorageManager(root), // root has no ledger ⇒ skipped.
      async (namespace) => {
        resolvedWith = namespace;
        if (!isSafeRouteNamespace(namespace)) {
          throw new Error(`invalid namespace: ${namespace}`);
        }
        return nsStorage;
      },
      undefined, // catalog disabled.
    );
    const seam = scheduler as unknown as CompactableScheduler & {
      resolveLifecycleCompactionTargets: () => Promise<
        Array<{ memoryDir: string; storage?: StorageManager }>
      >;
      compactLifecycleLedgerTarget: (
        target: unknown,
        threshold: number,
      ) => Promise<"skipped" | "compacted" | "failed" | "deferred">;
    };
    try {
      const targets = await seam.resolveLifecycleCompactionTargets();
      assert.equal(resolvedWith, nsName, "fallback resolves by the DECODED namespace, never the over-64 token");
      const nsTarget = targets.find(
        (t) => path.resolve(t.memoryDir) === path.resolve(nsDir),
      );
      assert.ok(nsTarget, "fallback discovered the per-namespace ledger dir");
      assert.ok(
        nsTarget?.storage,
        "long-namespace fallback target carries a keyed StorageManager, not a keyless dir",
      );
      assert.ok(
        nsTarget?.storage?.isSecureStoreUnlocked(),
        "keyed target is unlocked so the encrypted ledger can be rewritten",
      );

      // The core proof: the encrypted over-cap ledger COMPACTS, it does not defer.
      const outcome = await seam.compactLifecycleLedgerTarget(nsTarget, 1024);
      assert.equal(
        outcome,
        "compacted",
        "encrypted over-cap ledger for a long namespace compacts through the keyed store, never deferred forever",
      );
    } finally {
      await scheduler.dispose();
    }

    assert.notDeepEqual(
      await readFile(nsLedger),
      encrypted,
      "ledger was rewritten (not left byte-for-byte intact, i.e. not deferred)",
    );
    assert.ok((await stat(nsLedger)).size < beforeSize, "compacted ledger is smaller");
    assert.ok(
      isEncryptedFile(await readFile(nsLedger)),
      "compacted ledger stays encrypted at rest (namespace isolation + at-rest format preserved)",
    );
    const rebuilt = await nsStorage.readAllMemoryLifecycleEvents();
    assert.deepEqual(rebuilt.map((e) => e.eventType), ["created", "updated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog-disabled fallback resolves a LEGACY RAW namespace dir (not a ns- token) through the keyed store so its encrypted over-cap ledger compacts (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-legacyraw-"));
  try {
    const nsName = "legacy-raw-ns";
    assert.equal(namespaceIdentityFromToken(nsName), null, "precondition: dir name is NOT a ns- identity token");
    assert.ok(isSafeRouteNamespace(nsName), "precondition: dir name is a safe route namespace");

    const key = Buffer.alloc(32, 5);
    const nsDir = path.join(root, "namespaces", nsName);
    await mkdir(path.join(nsDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(nsDir, "facts", "2026-03-08", "fact-legacy.md"),
      `---\nid: fact-legacy\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["legacy"]\n---\n\nlegacy\n`,
      "utf-8",
    );
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const junk = '{"legacy":true,"pad":"wwwwwwwwwwwwwwwwwwwwwwwwwwwwww"}\n';
    const encrypted = encryptFileBody(
      junk.repeat(Math.ceil(4096 / junk.length)), key, filePathAad(nsLedger, nsDir),
    );
    await writeFile(nsLedger, encrypted);
    assert.ok(isEncryptedFile(await readFile(nsLedger)), "precondition: ledger encrypted");
    const beforeSize = (await stat(nsLedger)).size;

    const nsStorage = new StorageManager(nsDir);
    nsStorage.setSecureStoreRequired(true);
    nsStorage.setSecureStoreKey(key); // unlocked + encrypt-on-write ⇒ rewrite stays encrypted.
    let resolvedWith: string | null = null;
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        secureStoreEnabled: true,
        secureStoreEncryptOnWrite: true,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => new StorageManager(root), // root has no ledger ⇒ skipped.
      async (namespace) => {
        resolvedWith = namespace;
        if (!isSafeRouteNamespace(namespace)) {
          throw new Error(`invalid namespace: ${namespace}`);
        }
        return nsStorage;
      },
      undefined, // catalog disabled.
    );
    const seam = scheduler as unknown as CompactableScheduler & {
      resolveLifecycleCompactionTargets: () => Promise<
        Array<{ memoryDir: string; storage?: StorageManager }>
      >;
      compactLifecycleLedgerTarget: (
        target: unknown,
        threshold: number,
      ) => Promise<"skipped" | "compacted" | "failed" | "deferred">;
    };
    try {
      const targets = await seam.resolveLifecycleCompactionTargets();
      assert.equal(resolvedWith, nsName, "fallback resolves by the RAW legacy namespace name");
      const nsTarget = targets.find(
        (t) => path.resolve(t.memoryDir) === path.resolve(nsDir),
      );
      assert.ok(nsTarget, "fallback discovered the legacy raw namespace ledger dir");
      assert.ok(
        nsTarget?.storage,
        "legacy raw fallback target carries a keyed StorageManager, not a keyless dir",
      );
      assert.ok(
        nsTarget?.storage?.isSecureStoreUnlocked(),
        "keyed target is unlocked so the encrypted ledger can be rewritten",
      );

      const outcome = await seam.compactLifecycleLedgerTarget(nsTarget, 1024);
      assert.equal(
        outcome,
        "compacted",
        "encrypted over-cap ledger under a legacy raw namespace dir compacts through the keyed store, never deferred forever",
      );
    } finally {
      await scheduler.dispose();
    }

    assert.notDeepEqual(await readFile(nsLedger), encrypted, "ledger was rewritten (not deferred)");
    assert.ok((await stat(nsLedger)).size < beforeSize, "compacted ledger is smaller");
    assert.ok(
      isEncryptedFile(await readFile(nsLedger)),
      "compacted ledger stays encrypted at rest (namespace isolation + at-rest format preserved)",
    );
    const rebuilt = await nsStorage.readAllMemoryLifecycleEvents();
    assert.deepEqual(rebuilt.map((e) => e.eventType), ["created", "updated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog-disabled fallback routes a LEGACY RAW namespace dir through the PRODUCTION resolver (resolveNamespaceStorageRoot) so its encrypted over-cap ledger compacts, not defers (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-legacyraw-prod-"));
  try {
    // A legacy deployment wrote per-namespace data under the RAW namespace name
    const nsName = "legacy-raw-prod-ns";
    assert.equal(namespaceIdentityFromToken(nsName), null, "precondition: dir name is NOT a ns- identity token");
    assert.ok(isSafeRouteNamespace(nsName), "precondition: dir name is a safe route namespace");

    const config = fixtureConfig({
      memoryDir: root,
      defaultNamespace: "primary",
      namespacesEnabled: true,
      secureStoreEnabled: true,
      secureStoreEncryptOnWrite: true,
      memoryLifecycleLedgerCompactBytes: 1024,
      memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
    });

    const key = Buffer.alloc(32, 7);
    const nsDir = path.join(root, "namespaces", nsName);
    await mkdir(path.join(nsDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(nsDir, "facts", "2026-03-08", "fact-legacy.md"),
      `---\nid: fact-legacy\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["legacy"]\n---\n\nlegacy\n`,
      "utf-8",
    );
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const junk = '{"legacy":true,"pad":"vvvvvvvvvvvvvvvvvvvvvvvvvvvvvv"}\n';
    const encrypted = encryptFileBody(
      junk.repeat(Math.ceil(4096 / junk.length)), key, filePathAad(nsLedger, nsDir),
    );
    await writeFile(nsLedger, encrypted);
    assert.ok(isEncryptedFile(await readFile(nsLedger)), "precondition: ledger encrypted");
    const beforeSize = (await stat(nsLedger)).size;

    assert.equal(
      path.resolve(await resolveNamespaceStorageRoot(config, nsName)),
      path.resolve(nsDir),
      "production resolver routes the legacy raw namespace name to its legacy dir",
    );

    let resolvedWith: string | null = null;
    const scheduler = buildCompactionSchedulerWithStorage(
      config,
      () => new StorageManager(root), // root has no ledger, so it is skipped.
      async (namespace) => {
        resolvedWith = namespace;
        const resolvedRoot = await resolveNamespaceStorageRoot(config, namespace);
        const sm = new StorageManager(resolvedRoot);
        sm.setSecureStoreRequired(true);
        sm.setSecureStoreKey(key);
        return sm;
      },
      undefined, // catalog disabled.
    );
    const seam = scheduler as unknown as CompactableScheduler & {
      resolveLifecycleCompactionTargets: () => Promise<
        Array<{ memoryDir: string; storage?: StorageManager }>
      >;
      compactLifecycleLedgerTarget: (
        target: unknown,
        threshold: number,
      ) => Promise<"skipped" | "compacted" | "failed" | "deferred">;
    };
    try {
      const targets = await seam.resolveLifecycleCompactionTargets();
      assert.equal(resolvedWith, nsName, "fallback resolves by the RAW legacy namespace name");
      const nsTarget = targets.find(
        (t) => path.resolve(t.memoryDir) === path.resolve(nsDir),
      );
      assert.ok(nsTarget, "fallback discovered the legacy raw namespace ledger dir");
      assert.ok(
        nsTarget?.storage,
        "legacy raw fallback target carries a keyed StorageManager (production resolver), not a keyless dir",
      );
      assert.equal(
        path.resolve(nsTarget!.storage!.dir),
        path.resolve(nsDir),
        "the keyed target roots at the legacy raw dir, so the keyed guard held",
      );
      assert.ok(
        nsTarget?.storage?.isSecureStoreUnlocked(),
        "keyed target is unlocked so the encrypted ledger can be rewritten",
      );

      const outcome = await seam.compactLifecycleLedgerTarget(nsTarget, 1024);
      assert.equal(
        outcome,
        "compacted",
        "encrypted over-cap ledger under a legacy raw namespace dir compacts through the production-resolved keyed store, never deferred forever",
      );
    } finally {
      await scheduler.dispose();
    }

    assert.notDeepEqual(await readFile(nsLedger), encrypted, "ledger was rewritten (not deferred)");
    assert.ok((await stat(nsLedger)).size < beforeSize, "compacted ledger is smaller");
    assert.ok(
      isEncryptedFile(await readFile(nsLedger)),
      "compacted ledger stays encrypted at rest (namespace isolation + at-rest format preserved)",
    );
    const verifyStorage = new StorageManager(nsDir);
    verifyStorage.setSecureStoreRequired(true);
    verifyStorage.setSecureStoreKey(key);
    const rebuilt = await verifyStorage.readAllMemoryLifecycleEvents();
    assert.deepEqual(rebuilt.map((e) => e.eventType), ["created", "updated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserving rebuild skips the backup+rewrite for an already-compact ledger, ending the periodic re-archive churn (#2033 thread PRRT_kwDORJXyws6SExst)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-noop-"));
  try {
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const events = Array.from({ length: 30 }, (_unused, i) => ({
      eventId: `noop-${String(i).padStart(3, "0")}`,
      memoryId: "mem-a",
      eventType: "explicit_capture_accepted",
      timestamp: new Date(Date.UTC(2026, 2, 8, 0, 0, 0, 0) + i * 1000).toISOString(),
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    }));
    const junk = '{"legacy":true,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';
    await writeFile(
      ledgerPath,
      junk.repeat(4) + `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf-8",
    );

    const storage = new StorageManager(memoryDir);
    const bigCap = 10 * 1024 * 1024; // far above the tiny ledger: nothing is bounded away.
    const archiveRoot = path.join(memoryDir, "archive", "memory-lifecycle-ledger");

    const first = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      storage,
      preserveExistingEvents: true,
      maxLedgerBytes: bigCap,
      now: new Date("2026-03-08T00:00:00.000Z"),
    });
    assert.equal(first.rewritten, true, "first rebuild rewrites (junk discarded)");
    assert.ok(first.backupPath, "first rebuild archives a backup");
    const afterFirst = await readFile(ledgerPath);
    assert.equal(
      (await readdir(archiveRoot)).length,
      1,
      "exactly one backup after the first (effective) rebuild",
    );

    const second = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      storage,
      preserveExistingEvents: true,
      maxLedgerBytes: bigCap,
      now: new Date("2026-03-08T01:00:00.000Z"),
    });
    assert.equal(second.rewritten, false, "already-compact ledger: rebuild is a no-op");
    assert.equal(second.backupPath, undefined, "no-op rebuild archives no backup");
    assert.deepEqual(await readFile(ledgerPath), afterFirst, "no-op leaves the ledger byte-for-byte");
    assert.equal(
      (await readdir(archiveRoot)).length,
      1,
      "no second backup archived across intervals (churn eliminated)",
    );

    const third = await rebuildMemoryLifecycleLedger({
      memoryDir,
      dryRun: false,
      storage,
      preserveExistingEvents: true,
      maxLedgerBytes: bigCap,
      now: new Date("2026-03-08T02:00:00.000Z"),
    });
    assert.equal(third.rewritten, false, "still a no-op on the third interval");
    assert.equal((await readdir(archiveRoot)).length, 1, "archive still holds exactly one backup");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("catalog-disabled fallback refuses a symlinked namespaces scan root (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-outside-"));
  try {
    const nsLedger = path.join(
      outside, namespaceIdentityToken("evil"), "state", "memory-lifecycle-ledger.jsonl",
    );
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const junk = '{"legacy":true,"pad":"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}\n';
    const original = junk.repeat(Math.ceil(4096 / junk.length));
    await writeFile(nsLedger, original, "utf-8");
    await symlink(outside, path.join(root, "namespaces"));

    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }
    assert.equal(
      await readFile(nsLedger, "utf-8"),
      original,
      "ledger behind a symlinked namespaces root must be untouched",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("maintenance request triggers lifecycle compaction even when QMD is unavailable (#1910)", async () => {
  const { memoryDir } = await seedMemoryDirWithOversizedLedger(4096);
  try {
    const scheduler = new MaintenanceScheduler({
      config: fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      getQmd: () => ({ isAvailable: () => false }) as unknown as SearchBackend,
      namespaceSearchRouter: {} as unknown as NamespaceSearchRouter,
      namespaceCatalog: {} as unknown as NamespaceCatalog,
    });
    let compactionInvoked = false;
    const seam = scheduler as unknown as CompactableScheduler;
    seam.maybeCompactMemoryLifecycleLedger = async () => {
      compactionInvoked = true;
    };
    try {
      scheduler.requestQmdMaintenanceForTool("test");
      assert.ok(
        compactionInvoked,
        "lifecycle compaction must be triggered from the maintenance request when QMD is unavailable",
      );
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction bounds per-namespace ledgers via filesystem fallback when the catalog is disabled (#1910)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-nocatalog-"));
  try {
    const token = namespaceIdentityToken("project-beta");
    const nsDir = path.join(root, "namespaces", token);
    await mkdir(path.join(nsDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(nsDir, "facts", "2026-03-08", "fact-ns.md"),
      `---\nid: fact-ns\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["beta"]\n---\n\nbeta\n`,
      "utf-8",
    );
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    const line = '{"legacy":true,"pad":"wwwwwwwwwwwwwwwwwwwwwwwwwwwwww"}\n';
    await writeFile(nsLedger, line.repeat(Math.ceil(4096 / line.length)), "utf-8");
    const beforeSize = (await stat(nsLedger)).size;

    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }
    assert.ok(
      (await stat(nsLedger)).size < beforeSize,
      "namespace ledger must be compacted via the filesystem fallback",
    );
    const rebuilt = (await readFile(nsLedger, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rebuilt.map((r) => r.eventType), ["created", "updated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-compaction bounds a large append-only history under the read/decrypt cap and arms the throttle (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-bound-"));
  try {
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const total = 200;
    const events = Array.from({ length: total }, (_unused, i) => ({
      eventId: `cap-${String(i).padStart(3, "0")}`,
      memoryId: "mem-a",
      eventType: "explicit_capture_accepted",
      timestamp: new Date(Date.UTC(2026, 2, 8, 0, 0, 0, 0) + i * 1000).toISOString(),
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    }));
    const original = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await writeFile(ledgerPath, original, "utf-8");
    const rowBytes = Buffer.byteLength(`${JSON.stringify(events[0])}\n`, "utf8");
    const cap = rowBytes * 20 + Math.floor(rowBytes / 2); // admits ~20 rows.

    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: rowBytes * 5, // threshold << ledger size.
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    scheduler.lifecycleLedgerMaxBytes = cap;
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();

      const rewritten = await readFile(ledgerPath, "utf-8");
      assert.ok(
        Buffer.byteLength(rewritten, "utf8") < cap,
        "compacted ledger must be bounded under the read/decrypt cap",
      );
      const keptIds = rewritten.trim().split("\n").map((l) => JSON.parse(l).eventId);
      assert.ok(keptIds.includes(`cap-${String(total - 1).padStart(3, "0")}`), "newest append-only event survives");
      assert.ok(!keptIds.includes("cap-000"), "oldest append-only event archived out of the active ledger");

      const backups = await readdir(path.join(memoryDir, "archive", "memory-lifecycle-ledger")).catch(() => []);
      assert.ok(backups.length > 0, "a backup archive was written for the overflow");

      await writeFile(ledgerPath, original, "utf-8");
      const regrown = (await stat(ledgerPath)).size;
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.equal(
        (await stat(ledgerPath)).size,
        regrown,
        "throttle armed after an effective bounded compaction: second in-window pass is a no-op",
      );
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("filesystem-fallback compaction drains a pending lifecycle append even when no storage is wired (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-fallback-drain-"));
  try {
    const token = namespaceIdentityToken("project-fallback");
    const nsDir = path.join(root, "namespaces", token);
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    await writeFile(nsLedger, "", "utf-8");
    const spillDir = pendingLifecycleLedgerDir(nsLedger);
    await mkdir(spillDir, { recursive: true });
    const spillPath = path.join(spillDir, "spill.jsonl");
    const spilled = {
      eventId: "evt-fallback-spilled",
      memoryId: "mem-ns",
      eventType: "explicit_capture_accepted",
      timestamp: "2026-03-08T00:00:00.000Z",
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    await writeFile(spillPath, `${JSON.stringify(spilled)}\n`, "utf-8");

    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }

    const ledger = await readFile(nsLedger, "utf-8");
    assert.ok(
      ledger.includes("evt-fallback-spilled"),
      "the pending spill must be drained into the namespace ledger via the fallback path",
    );
    await assert.rejects(() => stat(spillPath), /ENOENT/, "spill file removed after the fallback drain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem-fallback compaction recovers a crash-orphaned *.claimed spill when no live spill remains (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-fallback-claimed-"));
  try {
    // Namespaces enabled but NO catalog storage wired: only the filesystem
    // fallback finds this per-namespace ledger, so target.storage is absent.
    const token = namespaceIdentityToken("project-fallback-claimed");
    const nsDir = path.join(root, "namespaces", token);
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    await writeFile(nsLedger, "", "utf-8");
    const spillDir = pendingLifecycleLedgerDir(nsLedger);
    await mkdir(spillDir, { recursive: true });
    const claimedPath = path.join(spillDir, "spill.jsonl.claimed");
    const orphaned = {
      eventId: "evt-claimed-orphan",
      memoryId: "mem-ns",
      eventType: "explicit_capture_accepted",
      timestamp: "2026-03-08T00:00:00.000Z",
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    await writeFile(claimedPath, `${JSON.stringify(orphaned)}\n`, "utf-8");
    assert.equal((await listContainedSpillFiles(spillDir)).length, 0, "precondition: no live *.jsonl spill");
    assert.equal(
      (await listContainedSpillFiles(spillDir, ".jsonl.claimed")).length,
      1,
      "precondition: exactly one crash-orphaned *.jsonl.claimed file",
    );

    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }

    const ledger = await readFile(nsLedger, "utf-8");
    assert.ok(
      ledger.includes("evt-claimed-orphan"),
      "the crash-orphaned claimed spill must be recovered and folded into the namespace ledger",
    );
    await assert.rejects(() => stat(claimedPath), /ENOENT/, "claimed orphan removed after recovery + commit");
    assert.equal(
      (await listContainedSpillFiles(spillDir, ".jsonl.claimed")).length,
      0,
      "no claimed orphan left stranded",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog-disabled fallback drain re-probes encryption UNDER the lock and defers ciphertext instead of plaintext-corrupting it (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-fallback-secure-drain-"));
  try {
    const key = Buffer.alloc(32, 4);
    const validRow = (id: string): string =>
      `{"eventId":"${id}","memoryId":"m","eventType":"created",`
      + `"timestamp":"2026-03-08T00:00:00.000Z","actor":"t","ruleVersion":"1"}\n`;

    const tokenA = namespaceIdentityToken("ns-enc-spill");
    const nsDirA = path.join(root, "namespaces", tokenA);
    const nsLedgerA = path.join(nsDirA, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedgerA), { recursive: true });
    await writeFile(nsLedgerA, "", "utf-8");
    const spillDirA = pendingLifecycleLedgerDir(nsLedgerA);
    await mkdir(spillDirA, { recursive: true });
    const spillPathA = path.join(spillDirA, "spill.jsonl");
    const encryptedSpillA = encryptFileBody(validRow("evt-enc-spill"), key, filePathAad(spillPathA, nsDirA));
    await writeFile(spillPathA, encryptedSpillA);

    const tokenB = namespaceIdentityToken("ns-enc-ledger");
    const nsDirB = path.join(root, "namespaces", tokenB);
    const nsLedgerB = path.join(nsDirB, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedgerB), { recursive: true });
    const encryptedLedgerB = encryptFileBody(validRow("evt-existing"), key, filePathAad(nsLedgerB, nsDirB));
    await writeFile(nsLedgerB, encryptedLedgerB);
    const spillDirB = pendingLifecycleLedgerDir(nsLedgerB);
    await mkdir(spillDirB, { recursive: true });
    const spillPathB = path.join(spillDirB, "spill.jsonl");
    await writeFile(spillPathB, validRow("evt-plain-spill"), "utf-8");

    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        memoryLifecycleLedgerCompactBytes: 0, // drain still runs unconditionally
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }

    assert.deepEqual(await readFile(spillPathA), encryptedSpillA, "encrypted spill left intact for the keyed path");
    assert.equal(await readFile(nsLedgerA, "utf-8"), "", "plaintext ledger never received ciphertext");
    assert.ok(isEncryptedFile(await readFile(spillPathA)), "spill stays encrypted at rest");

    assert.deepEqual(await readFile(nsLedgerB), encryptedLedgerB, "encrypted ledger left byte-for-byte intact");
    assert.equal(
      await readFile(spillPathB, "utf-8"),
      validRow("evt-plain-spill"),
      "plaintext spill rolled back to unclaimed for a later keyed pass",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto-compaction triggers on an encrypted ledger at/above the decrypt cap even when the configured threshold is larger (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-cap-clamp-"));
  try {
    await mkdir(path.join(memoryDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "facts", "2026-03-08", "fact-1.md"),
      `---\nid: fact-1\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["alpha"]\n---\n\nalpha\n`,
      "utf-8",
    );
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const key = Buffer.alloc(32, 7);
    const junk = '{"legacy":true,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';
    const junkBlob = junk.repeat(Math.ceil(4096 / junk.length));
    await writeFile(ledgerPath, encryptFileBody(junkBlob, key, filePathAad(ledgerPath, memoryDir)));
    const beforeSize = (await stat(ledgerPath)).size;

    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key); // unlocked, so an encrypted target is not deferred.
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: 10 * 1024 * 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => storage,
    );
    scheduler.lifecycleLedgerMaxBytes = 2048; // tiny cap: the ~4KB ledger is "at/above" it.
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }
    const afterSize = (await stat(ledgerPath)).size;
    assert.ok(afterSize < beforeSize, "over-cap encrypted ledger must compact despite the larger threshold");
    assert.ok(afterSize < 2048, "compacted encrypted ledger must land below the decrypt cap");
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "rewritten ledger stays encrypted at rest");
    const rebuilt = await storage.readAllMemoryLifecycleEvents();
    assert.deepEqual(rebuilt.map((e) => e.eventType), ["created", "updated"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction bypasses the min-interval throttle for an over-cap encrypted ledger, but still throttles a below-cap target (#2033)", async () => {
  const bypassDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-throttle-bypass-"));
  const throttledDir = (await seedMemoryDirWithOversizedLedger(4096)).memoryDir;
  try {
    await mkdir(path.join(bypassDir, "facts", "2026-03-08"), { recursive: true });
    await writeFile(
      path.join(bypassDir, "facts", "2026-03-08", "fact-1.md"),
      `---\nid: fact-1\ncategory: fact\ncreated: 2026-03-08T00:00:00.000Z\n`
      + `updated: 2026-03-08T01:00:00.000Z\nsource: test\nconfidence: 0.8\n`
      + `confidenceTier: implied\ntags: ["alpha"]\n---\n\nalpha\n`,
      "utf-8",
    );
    const bypassLedger = path.join(bypassDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(bypassLedger), { recursive: true });
    const key = Buffer.alloc(32, 7);
    const junk = '{"legacy":true,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';
    const junkBlob = junk.repeat(Math.ceil(4096 / junk.length));
    await writeFile(bypassLedger, encryptFileBody(junkBlob, key, filePathAad(bypassLedger, bypassDir)));
    const bypassBefore = (await stat(bypassLedger)).size;

    const storage = new StorageManager(bypassDir);
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key); // unlocked, so the encrypted target is not deferred.
    const bypassScheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir: bypassDir,
        memoryLifecycleLedgerCompactBytes: 10 * 1024 * 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => storage,
    );
    bypassScheduler.lifecycleLedgerMaxBytes = 2048; // tiny cap: the ~4KB ledger is over it.
    bypassScheduler.lastLifecycleCompactionAtMs = Date.now();
    try {
      await bypassScheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await bypassScheduler.dispose();
    }
    const bypassAfter = (await stat(bypassLedger)).size;
    assert.ok(
      bypassAfter < bypassBefore,
      "over-cap encrypted ledger must compact despite the armed throttle (#2033 bypass)",
    );
    assert.ok(bypassAfter < 2048, "compacted encrypted ledger must land below the decrypt cap");
    assert.ok(isEncryptedFile(await readFile(bypassLedger)), "rewritten ledger stays encrypted at rest");

    const throttledLedger = path.join(throttledDir, "state", "memory-lifecycle-ledger.jsonl");
    const throttledBefore = (await stat(throttledLedger)).size;
    const throttledScheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir: throttledDir,
        memoryLifecycleLedgerCompactBytes: 1024, // ledger is over threshold — eligible if unthrottled.
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    throttledScheduler.lastLifecycleCompactionAtMs = Date.now();
    try {
      await throttledScheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await throttledScheduler.dispose();
    }
    assert.equal(
      (await stat(throttledLedger)).size,
      throttledBefore,
      "below-cap target stays throttled: the armed throttle prevents recompaction",
    );
  } finally {
    await rm(bypassDir, { recursive: true, force: true });
    await rm(throttledDir, { recursive: true, force: true });
  }
});

test("auto-compaction reserves the secure-store envelope so an encrypted rewrite lands below the cap and does not retry forever (#2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-envelope-"));
  try {
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const total = 200;
    const events = Array.from({ length: total }, (_unused, i) => ({
      eventId: `cap-${String(i).padStart(3, "0")}`,
      memoryId: "mem-a",
      eventType: "explicit_capture_accepted",
      timestamp: new Date(Date.UTC(2026, 2, 8, 0, 0, 0, 0) + i * 1000).toISOString(),
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    }));
    const plaintext = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    const key = Buffer.alloc(32, 3);
    await writeFile(ledgerPath, encryptFileBody(plaintext, key, filePathAad(ledgerPath, memoryDir)));
    const rowBytes = Buffer.byteLength(`${JSON.stringify(events[0])}\n`, "utf8");
    const cap = rowBytes * 20;
    assert.ok(
      rowBytes * 20 + SECURE_STORE_ENVELOPE_OVERHEAD_BYTES > cap,
      "sanity: cap chosen so an unreserved budget would push the encrypted file over the cap",
    );

    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key);
    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: rowBytes * 5,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => storage,
    );
    scheduler.lifecycleLedgerMaxBytes = cap;
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
      const onDisk = (await stat(ledgerPath)).size;
      assert.ok(isEncryptedFile(await readFile(ledgerPath)), "rewritten ledger encrypted at rest");
      assert.ok(onDisk < cap, `encrypted on-disk ledger (${onDisk}B) must be strictly below the cap (${cap}B)`);
      const keptIds = (await storage.readAllMemoryLifecycleEvents()).map((e) => e.eventId);
      assert.ok(keptIds.includes(`cap-${String(total - 1).padStart(3, "0")}`), "newest event survives");
      assert.ok(!keptIds.includes("cap-000"), "oldest event archived out of the active ledger");

      const backups = await readdir(path.join(memoryDir, "archive", "memory-lifecycle-ledger")).catch(() => []);
      assert.ok(backups.length > 0, "overflow archived to a verbatim backup");

      const regrownPlain = `${events.slice(0, 10).map((e) => JSON.stringify(e)).join("\n")}\n`;
      await writeFile(ledgerPath, encryptFileBody(regrownPlain, key, filePathAad(ledgerPath, memoryDir)));
      const regrown = (await stat(ledgerPath)).size;
      assert.ok(
        regrown > rowBytes * 5 && regrown < cap,
        "regrown ledger is over threshold but below the cap (throttle, not bypass, applies)",
      );
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.equal(
        (await stat(ledgerPath)).size,
        regrown,
        "throttle armed after an effective encrypted compaction: second in-window pass is a no-op",
      );
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction reserves the envelope when a PLAINTEXT ledger will be rewritten encrypted (write-mode budget, #2033)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-plaintext-encrypt-"));
  try {
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    const total = 200;
    const events = Array.from({ length: total }, (_unused, i) => ({
      eventId: `cap-${String(i).padStart(3, "0")}`,
      memoryId: "mem-a",
      eventType: "explicit_capture_accepted",
      timestamp: new Date(Date.UTC(2026, 2, 8, 0, 0, 0, 0) + i * 1000).toISOString(),
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    }));
    const plaintext = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await writeFile(ledgerPath, plaintext, "utf-8");
    assert.ok(!isEncryptedFile(await readFile(ledgerPath)), "precondition: existing ledger is plaintext");

    const rowBytes = Buffer.byteLength(`${JSON.stringify(events[0])}\n`, "utf8");
    const cap = rowBytes * 20 + SECURE_STORE_ENVELOPE_OVERHEAD_BYTES;
    assert.ok(
      20 * rowBytes + SECURE_STORE_ENVELOPE_OVERHEAD_BYTES >= cap,
      "sanity: an unreserved 20-row plaintext budget encrypts to at/over the cap",
    );
    assert.ok(
      19 * rowBytes + SECURE_STORE_ENVELOPE_OVERHEAD_BYTES < cap,
      "sanity: a reserved 19-row budget encrypts to strictly below the cap",
    );

    const key = Buffer.alloc(32, 5);
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreRequired(true);
    storage.setSecureStoreKey(key); // unlocked + encrypt-on-write ⇒ the rewrite encrypts.
    assert.ok(storage.willEncryptStateWrites(), "precondition: writes will be encrypted at rest");

    const scheduler = buildCompactionSchedulerWithStorage(
      fixtureConfig({
        memoryDir,
        memoryLifecycleLedgerCompactBytes: rowBytes * 5,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
      () => storage,
    );
    scheduler.lifecycleLedgerMaxBytes = cap;
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
      const onDisk = (await stat(ledgerPath)).size;
      assert.ok(isEncryptedFile(await readFile(ledgerPath)), "rewritten ledger encrypted at rest");
      assert.ok(onDisk < cap, `encrypted on-disk ledger (${onDisk}B) must be strictly below the cap (${cap}B)`);
      const keptIds = (await storage.readAllMemoryLifecycleEvents()).map((e) => e.eventId);
      assert.ok(keptIds.includes(`cap-${String(total - 1).padStart(3, "0")}`), "newest event survives");
      assert.ok(!keptIds.includes("cap-000"), "oldest event archived out of the active ledger");

      await writeFile(ledgerPath, plaintext, "utf-8");
      const regrown = (await stat(ledgerPath)).size;
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.equal(
        (await stat(ledgerPath)).size,
        regrown,
        "throttle armed after an effective compaction: second in-window pass is a no-op",
      );
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("catalog-disabled fallback pending drain skips unsafe spill entries (symlink/FIFO/dir) without following or blocking (#2033)", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-fallback-unsafe-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-fallback-outside-"));
  try {
    const token = namespaceIdentityToken("project-unsafe");
    const nsDir = path.join(root, "namespaces", token);
    const nsLedger = path.join(nsDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(nsLedger), { recursive: true });
    await writeFile(nsLedger, "", "utf-8");
    const spillDir = pendingLifecycleLedgerDir(nsLedger);
    await mkdir(spillDir, { recursive: true });

    const goodPath = path.join(spillDir, "good.jsonl");
    const spilled = {
      eventId: "evt-good-spilled",
      memoryId: "mem-ns",
      eventType: "explicit_capture_accepted",
      timestamp: "2026-03-08T00:00:00.000Z",
      actor: "explicit-capture",
      ruleVersion: "memory-lifecycle-ledger.v1",
    };
    await writeFile(goodPath, `${JSON.stringify(spilled)}\n`, "utf-8");

    const outsideFile = path.join(outside, "target.jsonl");
    await writeFile(outsideFile, '{"eventId":"evt-outside"}\n', "utf-8");
    const linkPath = path.join(spillDir, "link.jsonl");
    await symlink(outsideFile, linkPath);
    const fifoPath = path.join(spillDir, "pipe.jsonl");
    execFileSync("mkfifo", [fifoPath]);
    const dirPath = path.join(spillDir, "dir.jsonl");
    await mkdir(dirPath);

    const scheduler = buildCompactionScheduler(
      fixtureConfig({
        memoryDir: root,
        namespacesEnabled: true,
        memoryLifecycleLedgerCompactBytes: 1024,
        memoryLifecycleLedgerCompactMinIntervalMs: 60 * 60 * 1000,
      }),
    );
    try {
      await scheduler.maybeCompactMemoryLifecycleLedger();
    } finally {
      await scheduler.dispose();
    }

    const ledger = await readFile(nsLedger, "utf-8");
    assert.ok(ledger.includes("evt-good-spilled"), "the safe plaintext spill drains into the ledger");
    assert.ok(!ledger.includes("evt-outside"), "the symlink target outside the spill dir is never followed");
    await assert.rejects(() => stat(goodPath), /ENOENT/, "drained safe spill removed");
    assert.ok((await lstat(linkPath)).isSymbolicLink(), "symlink entry left in place");
    assert.ok((await lstat(fifoPath)).isFIFO(), "FIFO entry left in place");
    assert.ok((await lstat(dirPath)).isDirectory(), "directory entry left in place");
    assert.equal(await readFile(outsideFile, "utf-8"), '{"eventId":"evt-outside"}\n', "outside target intact and unread");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────


async function seedMemoryDirWithOneFact(): Promise<string> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-projrebuild-"));
  await mkdir(path.join(memoryDir, "facts", "2026-07-01"), { recursive: true });
  await writeFile(
    path.join(memoryDir, "facts", "2026-07-01", "fact-1.md"),
    `---
id: fact-1
category: fact
created: 2026-07-01T00:00:00.000Z
updated: 2026-07-01T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
    "utf-8",
  );
  return memoryDir;
}
function projectionScheduleState(): ProjectionRebuildScheduleState {
  return createProjectionRebuildScheduleState();
}

test("scheduled projection rebuild runs when enabled and writes a populated projection (#2119)", async () => {
  const memoryDir = await seedMemoryDirWithOneFact();
  try {
    assert.equal(probeProjectionHealth(memoryDir).state, "absent");
    await maybeRebuildMemoryProjectionScheduled({
      config: fixtureConfig({
        memoryDir,
        projectionRebuildEnabled: true,
        projectionRebuildIntervalMs: 6 * 60 * 60 * 1000,
      }),
      state: projectionScheduleState(),
    });
    assert.equal(probeProjectionHealth(memoryDir).state, "openable");
    assert.equal(readProjectedMemoryBrowse(memoryDir, { limit: 5, offset: 0 })?.total, 1);
    assert.ok(readProjectionRebuiltAt(memoryDir), "rebuiltAt meta must be stamped");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scheduled projection rebuild is a no-op when disabled by config (#2119)", async () => {
  const memoryDir = await seedMemoryDirWithOneFact();
  try {
    await maybeRebuildMemoryProjectionScheduled({
      config: fixtureConfig({
        memoryDir,
        projectionRebuildEnabled: false,
        projectionRebuildIntervalMs: 6 * 60 * 60 * 1000,
      }),
      state: projectionScheduleState(),
    });
    assert.equal(probeProjectionHealth(memoryDir).state, "absent");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scheduled projection rebuild skips when the projection was rebuilt within the interval (#2119)", async () => {
  const memoryDir = await seedMemoryDirWithOneFact();
  try {
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    await rebuildMemoryProjection({ memoryDir, dryRun: false, now: oneMinuteAgo });
    const before = readProjectionRebuiltAt(memoryDir);
    assert.equal(before, oneMinuteAgo.toISOString());

    await maybeRebuildMemoryProjectionScheduled({
      config: fixtureConfig({
        memoryDir,
        projectionRebuildEnabled: true,
        projectionRebuildIntervalMs: 6 * 60 * 60 * 1000,
      }),
      state: projectionScheduleState(),
    });
    assert.equal(readProjectionRebuiltAt(memoryDir), before, "projection must not be rebuilt when fresh");
    await assert.rejects(
      () => readdir(path.join(memoryDir, "archive", "memory-projection")),
      "no backup means no rebuild occurred",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("maintenance tool request invokes the scheduled projection rebuild wiring (#2119)", async () => {
  const memoryDir = await seedMemoryDirWithOneFact();
  const scheduler = new MaintenanceScheduler({
    config: fixtureConfig({
      memoryDir,
      projectionRebuildEnabled: true,
      projectionRebuildIntervalMs: 6 * 60 * 60 * 1000,
    }),
    getQmd: () => ({ isAvailable: () => false }) as unknown as SearchBackend,
    namespaceSearchRouter: {} as unknown as NamespaceSearchRouter,
    namespaceCatalog: {} as unknown as NamespaceCatalog,
  });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    for (let attempt = 0; attempt < 60 && probeProjectionHealth(memoryDir).state === "absent"; attempt += 1) {
      await delay(500);
    }
    assert.equal(
      probeProjectionHealth(memoryDir).state,
      "openable",
      "the public maintenance request entrypoint must reach the projection rebuild",
    );
    assert.equal(readProjectedMemoryBrowse(memoryDir, { limit: 5, offset: 0 })?.total, 1);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// re-index actually ran (the entity-migration pending marker) cannot rely on
// requestQmdMaintenanceForTool, which only arms a debounced timer.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Non-namespace scheduler over a scriptable QMD backend. Like QmdClient, plain
 * `update()` is fail-open: it resolves even when the min-interval gate or the
 * failure backoff suppressed it or it errored, so only `updateStrict()` says
 * whether an update actually ran.
 */
function completionScheduler(
  backend: {
    available?: boolean;
    update?: () => Promise<void>;
    updateStrict?: (() => Promise<void>) | false;
  },
  overrides: Record<string, boolean> = {},
): MaintenanceScheduler {
  const runStrict = backend.updateStrict || (async () => undefined);
  const strict = backend.updateStrict === false ? {} : {
    async updateStrict() {
      if (!(backend.available ?? true)) throw new Error("QMD unavailable");
      await runStrict();
    },
  };
  const qmd: SearchBackend = Object.assign(Object.create(null), {
    isAvailable: () => backend.available ?? true,
    update: backend.update ?? (async () => undefined),
    async embed() {},
    ...strict,
  });
  const router: NamespaceSearchRouter = Object.create(null);
  const catalog: NamespaceCatalog = Object.assign(Object.create(null), { enabled: false });
  return new MaintenanceScheduler({
    config: fixtureConfig({ namespacesEnabled: false, qmdAutoEmbedEnabled: false, ...overrides }),
    getQmd: () => qmd,
    namespaceSearchRouter: router,
    namespaceCatalog: catalog,
  });
}

test("requestQmdMaintenanceCompletion resolves true once the pass that covers it has run", async () => {
  const scheduler = completionScheduler({});
  try {
    const served = scheduler.requestQmdMaintenanceCompletion();
    assert.equal(scheduler.isQmdMaintenancePending(), true, "the request arms the debounced pass");
    await scheduler.runQmdMaintenance();
    assert.equal(await served, true);
  } finally {
    await scheduler.dispose();
  }
});

test("requestQmdMaintenanceCompletion serves every request that was waiting when the pass started", async () => {
  const scheduler = completionScheduler({});
  try {
    const waiting = [scheduler.requestQmdMaintenanceCompletion(), scheduler.requestQmdMaintenanceCompletion()];
    await scheduler.runQmdMaintenance();
    assert.deepEqual(await Promise.all(waiting), [true, true]);
  } finally {
    await scheduler.dispose();
  }
});

test("requestQmdMaintenanceCompletion resolves false when the covering pass fails", async () => {
  const scheduler = completionScheduler({
    updateStrict: async () => {
      throw new Error("qmd update failed");
    },
  });
  try {
    const served = scheduler.requestQmdMaintenanceCompletion();
    await scheduler.runQmdMaintenance();
    assert.equal(await served, false, "a failed update left the index stale: the request stays owed");
  } finally {
    await scheduler.dispose();
  }
});

test("requestQmdMaintenanceCompletion resolves false when dispose() clears the armed timer", async () => {
  const scheduler = completionScheduler({});
  const served = scheduler.requestQmdMaintenanceCompletion();
  assert.equal(scheduler.isQmdMaintenancePending(), true);
  await scheduler.dispose();
  assert.equal(await served, false, "a destroy inside the debounce window must leave the re-index owed");
});

test("requestQmdMaintenanceCompletion over namespaces: a scoped request is served only when its own namespace ran, an unscoped one by the pass outcome", async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-completion-permanent-"));
  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
  });
  const catalog: NamespaceCatalog = Object.assign(Object.create(null), {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "feature-x", kind: "branch" }];
    },
    async markMaintenance() {},
  });
  const router: NamespaceSearchRouter = Object.assign(Object.create(null), {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {},
  });
  const scheduler = buildScheduler({ config, catalog, router });
  try {
    const unscoped = scheduler.requestQmdMaintenanceCompletion();
    const forBranch = scheduler.requestQmdMaintenanceCompletion("feature-x");
    const forDefault = scheduler.requestQmdMaintenanceCompletion("default");
    await scheduler.runQmdMaintenance();
    assert.equal(await unscoped, true);
    assert.equal(await forDefault, true, "default ran");
    assert.equal(await forBranch, false, "feature-x never ran, so its re-index is still owed");
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("requestQmdMaintenanceCompletion serves a scoped request when namespaces are disabled and the update ran", async () => {
  const scheduler = completionScheduler({});
  try {
    const served = scheduler.requestQmdMaintenanceCompletion("default");
    await scheduler.runQmdMaintenance();
    assert.equal(await served, true);
  } finally {
    await scheduler.dispose();
  }
});

test("requestQmdMaintenanceCompletion resolves false for a namespace-scoped request when dispose() abandons it", async () => {
  const scheduler = completionScheduler({});
  const served = scheduler.requestQmdMaintenanceCompletion("default");
  await scheduler.dispose();
  assert.equal(await served, false, "no pass ran the namespace, so the re-index stays owed");
});

test("requestQmdMaintenanceCompletion resolves false without arming anything when QMD is unavailable or disposed", async () => {
  const unavailable = completionScheduler({ available: false });
  try {
    assert.equal(await unavailable.requestQmdMaintenanceCompletion(), false);
    assert.equal(unavailable.isQmdMaintenancePending(), false, "no timer may be armed for a refused request");
  } finally {
    await unavailable.dispose();
  }
  const off = completionScheduler({}, { qmdMaintenanceEnabled: false });
  try {
    assert.equal(await off.requestQmdMaintenanceCompletion(), false, "maintenance switched off: nothing will ever serve it");
    assert.equal(off.isQmdMaintenancePending(), false);
  } finally {
    await off.dispose();
  }
  const disposed = completionScheduler({});
  await disposed.dispose();
  assert.equal(await disposed.requestQmdMaintenanceCompletion(), false);
  assert.equal(disposed.isQmdMaintenancePending(), false);
});

test("requestQmdMaintenanceCompletion resolves false when the update was suppressed or errored but plain update() still returned normally", async () => {
  for (const reason of ["QMD update skipped by min-interval gate", "QMD update skipped by recent failure backoff", "spawn qmd ENOENT"]) {
    const scheduler = completionScheduler({
      update: async () => undefined,
      updateStrict: async () => {
        throw new Error(reason);
      },
    });
    try {
      const served = scheduler.requestQmdMaintenanceCompletion();
      await scheduler.runQmdMaintenance();
      assert.equal(await served, false, reason);
    } finally {
      await scheduler.dispose();
    }
  }
});

test("requestQmdMaintenanceCompletion resolves false for a backend that cannot confirm an update", async () => {
  const scheduler = completionScheduler({ updateStrict: false });
  try {
    const served = scheduler.requestQmdMaintenanceCompletion();
    await scheduler.runQmdMaintenance();
    assert.equal(await served, false, "plain update() says nothing about whether it indexed");
  } finally {
    await scheduler.dispose();
  }
});

test("requestQmdMaintenanceCompletion keeps embedding after a suppressed update, as before", async () => {
  let embeds = 0;
  const qmd: SearchBackend = Object.assign(Object.create(null), {
    isAvailable: () => true,
    async update() {},
    async updateStrict() {
      throw new Error("QMD update skipped by min-interval gate");
    },
    async embed() {
      embeds += 1;
    },
  });
  const router: NamespaceSearchRouter = Object.create(null);
  const catalog: NamespaceCatalog = Object.assign(Object.create(null), { enabled: false });
  const scheduler = new MaintenanceScheduler({
    config: fixtureConfig({ namespacesEnabled: false, qmdAutoEmbedEnabled: true, qmdEmbedMinIntervalMs: 0 }),
    getQmd: () => qmd,
    namespaceSearchRouter: router,
    namespaceCatalog: catalog,
  });
  try {
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();
    assert.equal(embeds, 1, "a suppressed update must not skip a due embed");
  } finally {
    await scheduler.dispose();
  }
});

test("requestQmdMaintenanceCompletion follows updateCompleted for backends with no strict update (Orama, LanceDB, Meilisearch, remote)", async () => {
  for (const completed of [true, false]) {
    let updates = 0;
    const backend: SearchBackend = Object.assign(Object.create(null), {
      isAvailable: () => true,
      async update() {
        updates += 1;
      },
      async updateCompleted() {
        return completed;
      },
      async embed() {},
    });
    const scheduler = new MaintenanceScheduler({
      config: fixtureConfig({ namespacesEnabled: false, qmdAutoEmbedEnabled: false }),
      getQmd: () => backend,
      namespaceSearchRouter: Object.create(null),
      namespaceCatalog: Object.assign(Object.create(null), { enabled: false }),
    });
    try {
      const served = scheduler.requestQmdMaintenanceCompletion();
      await scheduler.runQmdMaintenance();
      assert.equal(await served, completed);
      assert.equal(updates, 0, "updateCompleted is the update, not an extra call after update()");
    } finally {
      await scheduler.dispose();
    }
  }
});

test("requestQmdMaintenanceCompletion is served by a real non-QMD backend (Orama) once its re-index completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-completion-orama-"));
  try {
    await mkdir(path.join(root, "facts"), { recursive: true });
    await writeFile(path.join(root, "facts", "fact.md"), "---\nid: mem-completion\n---\nA fact the re-index must cover.");
    const orama = new OramaBackend({
      dbPath: path.join(root, "orama-db"),
      collection: "openclaw-engram",
      embedHelper: new EmbedHelper(fixtureConfig({})),
      memoryDir: root,
      embeddingDimension: 4,
    });
    assert.equal(await orama.probe(), true);
    const scheduler = new MaintenanceScheduler({
      config: fixtureConfig({ namespacesEnabled: false, qmdAutoEmbedEnabled: false }),
      getQmd: () => orama,
      namespaceSearchRouter: Object.create(null),
      namespaceCatalog: Object.assign(Object.create(null), { enabled: false }),
    });
    try {
      const served = scheduler.requestQmdMaintenanceCompletion();
      await scheduler.runQmdMaintenance();
      assert.equal(await served, true);
      assert.equal((await orama.bm25Search("re-index")).some((r) => r.docid === "mem-completion"), true, "the pass indexed the corpus");
    } finally {
      await scheduler.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requestQmdMaintenanceCompletion resolves false when the backend became unavailable before the armed pass ran", async () => {
  const backend = { available: true };
  const scheduler = completionScheduler(backend);
  try {
    const served = scheduler.requestQmdMaintenanceCompletion();
    backend.available = false;
    await scheduler.runQmdMaintenance();
    assert.equal(await served, false);
  } finally {
    await scheduler.dispose();
  }
});

test("requestQmdMaintenanceCompletion is served by the next pass when requested during an in-flight one", async () => {
  const release = Promise.withResolvers<void>();
  let updates = 0;
  const scheduler = completionScheduler({
    updateStrict: async () => {
      updates += 1;
      if (updates === 1) await release.promise;
    },
  });
  try {
    scheduler.requestQmdMaintenanceForTool("first");
    const firstPass = scheduler.runQmdMaintenance();
    const served = scheduler.requestQmdMaintenanceCompletion();
    release.resolve();
    await firstPass;
    assert.equal(updates, 1);
    await scheduler.runQmdMaintenance();
    assert.equal(updates, 2, "the follow-up pass ran");
    assert.equal(await served, true);
  } finally {
    await scheduler.dispose();
  }
});

test("requestQmdMaintenanceCompletion over namespaces: true only when a namespace ran and none failed", async () => {
  for (const outcome of [{ eligible: true, expected: true }, { eligible: false, expected: false }]) {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-completion-ns-"));
    const config = fixtureConfig({
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
      maintenanceNamespaceLockStaleMs: 100,
      qmdAutoEmbedEnabled: false,
    });
    const catalog: NamespaceCatalog = Object.assign(Object.create(null), {
      enabled: true,
      async listNamespaces() {
        return [{ namespace: "default" }];
      },
      async markMaintenance() {},
    });
    const router: NamespaceSearchRouter = Object.assign(Object.create(null), {
      async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
        return outcome.eligible ? { backendCount: ns.length, eligibleNamespaces: ns } : { backendCount: 0, eligibleNamespaces: [] };
      },
      async embedNamespaces(): Promise<void> {},
    });
    const scheduler = buildScheduler({ config, catalog, router });
    try {
      const served = scheduler.requestQmdMaintenanceCompletion();
      await scheduler.runQmdMaintenance();
      assert.equal(await served, outcome.expected);
    } finally {
      await scheduler.dispose();
      await rm(memoryDir, { recursive: true, force: true });
    }
  }
});

test("requestQmdMaintenanceCompletion over namespaces: a failed catalog read leaves the request owed (#3289)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-completion-catalog-"));
  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
  });
  const catalog: NamespaceCatalog = Object.assign(Object.create(null), {
    enabled: true,
    async listNamespaces(): Promise<never> {
      throw new Error("catalog unavailable");
    },
    async markMaintenance() {},
  });
  const router: NamespaceSearchRouter = Object.assign(Object.create(null), {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {},
  });
  const scheduler = buildScheduler({ config, catalog, router });
  try {
    const served = scheduler.requestQmdMaintenanceCompletion();
    await scheduler.runQmdMaintenance();
    assert.equal(await served, false);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("requestQmdMaintenanceCompletion over namespaces: a malformed catalog record leaves the request owed (#3293)", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-completion-malformed-"));
  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
  });
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  await writeFile(path.join(memoryDir, "state", "namespaces.jsonl"), "{this is not json\n", "utf8");
  const router: NamespaceSearchRouter = Object.assign(Object.create(null), {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {},
  });
  const scheduler = buildScheduler({ config, catalog: new NamespaceCatalog(config), router });
  try {
    const served = scheduler.requestQmdMaintenanceCompletion();
    await scheduler.runQmdMaintenance();
    assert.equal(await served, false);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("requestQmdMaintenanceCompletion over namespaces: a permanent skip (branch_disabled) does not block serving", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-completion-permanent-"));
  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
  });
  const catalog: NamespaceCatalog = Object.assign(Object.create(null), {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "feature-x", kind: "branch" }];
    },
    async markMaintenance() {},
  });
  const router: NamespaceSearchRouter = Object.assign(Object.create(null), {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {},
  });
  const scheduler = buildScheduler({ config, catalog, router });
  try {
    const served = scheduler.requestQmdMaintenanceCompletion();
    await scheduler.runQmdMaintenance();
    assert.equal(await served, true);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("requestQmdMaintenanceCompletion over namespaces: more namespaces than the cycle budget: a later pass serves once all have run", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-completion-budget-"));
  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [{ name: "project-a" }, { name: "project-b" }],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
    maintenanceMaxNamespacesPerCycle: 3,
  });
  const catalog: NamespaceCatalog = Object.assign(Object.create(null), {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "default" }];
    },
    async markMaintenance() {},
  });
  const router: NamespaceSearchRouter = Object.assign(Object.create(null), {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {},
  });
  const scheduler = buildScheduler({ config, catalog, router });
  try {
    const served = scheduler.requestQmdMaintenanceCompletion();
    let settled = false;
    void served.then(() => {
      settled = true;
    });
    await scheduler.runQmdMaintenance();
    await setImmediate();
    assert.equal(settled, false, "three ran, project-b was skipped as budget_exhausted: still owed");
    await scheduler.runQmdMaintenance();
    assert.equal(await served, true, "every namespace has now run since the request");
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("requestQmdMaintenanceCompletion over namespaces: a pass that adds no coverage ends the request unserved instead of re-arming forever", async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-completion-budget-"));
  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
    maintenanceMaxNamespacesPerCycle: 1,
  });
  const catalog: NamespaceCatalog = Object.assign(Object.create(null), {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "default" }];
    },
    async markMaintenance() {},
  });
  const router: NamespaceSearchRouter = Object.assign(Object.create(null), {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {},
  });
  const scheduler = buildScheduler({ config, catalog, router });
  try {
    const served = scheduler.requestQmdMaintenanceCompletion();
    await scheduler.runQmdMaintenance();
    assert.equal(scheduler.isQmdMaintenancePending(), true);
    await scheduler.runQmdMaintenance();
    assert.equal(await served, false);
    assert.equal(scheduler.isQmdMaintenancePending(), false);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("requestQmdMaintenanceCompletion over namespaces: a request scoped to a namespace is served once that namespace ran, however the budget ranks the rest", async () => {
      const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-qmd-completion-budget-"));
  const config = fixtureConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceLockStaleMs: 100,
    qmdAutoEmbedEnabled: false,
    maintenanceMaxNamespacesPerCycle: 1,
  });
  const catalog: NamespaceCatalog = Object.assign(Object.create(null), {
    enabled: true,
    async listNamespaces() {
      return [{ namespace: "default" }];
    },
    async markMaintenance() {},
  });
  const router: NamespaceSearchRouter = Object.assign(Object.create(null), {
    async updateNamespacesDetailed(ns: string[]): Promise<NamespaceUpdateResult> {
      return { backendCount: ns.length, eligibleNamespaces: ns };
    },
    async embedNamespaces(): Promise<void> {},
  });
  const scheduler = buildScheduler({ config, catalog, router });
  try {
    const forDefault = scheduler.requestQmdMaintenanceCompletion("default");
    const forShared = scheduler.requestQmdMaintenanceCompletion("shared");
    await scheduler.runQmdMaintenance();
    assert.equal(await forDefault, true, "the namespace the migration rewrote ran this pass");
    await scheduler.runQmdMaintenance();
    assert.equal(await forShared, false);
    assert.equal(scheduler.isQmdMaintenancePending(), false);
  } finally {
    await scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
