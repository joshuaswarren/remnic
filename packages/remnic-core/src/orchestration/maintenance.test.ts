/**
 * Colocated suite for MaintenanceScheduler (issue #1526 PR1).
 *
 * These tests were ported from orchestrator-flush.test.ts /
 * orchestrator-characterization.test.ts where they previously poked
 * `orchestrator.runQmdMaintenance()` and its private cadence fields directly.
 * Now that the cadence + singleflight state lives on the scheduler, they
 * construct a real MaintenanceScheduler and drive it through its public API
 * (requestQmdMaintenanceForTool arms the debounced pending flag exactly as the
 * orchestrator does in production; runQmdMaintenance runs the pass).
 *
 * Fixture-cast note: NamespaceCatalog and NamespaceSearchRouter are classes
 * with private cache state, so a partial stub cannot structurally satisfy them.
 * Each cast below bridges a stub that only implements the surface
 * runQmdMaintenance actually invokes; the reason is documented at each site.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";

import { MaintenanceScheduler } from "./maintenance.js";
import type { PluginConfig } from "../types.js";
import type { SearchBackend } from "../search/port.js";
import type {
  NamespaceSearchRouter,
  NamespaceUpdateResult,
} from "../namespaces/search.js";
import type { NamespaceCatalog, NamespaceRecord } from "../namespaces/catalog.js";
import { namespaceIdentityToken } from "../namespaces/identity.js";
import { readNamespaceMaintenanceStatuses } from "../maintenance/namespace-planner.js";
import { StorageManager } from "../storage.js";
import { encryptFileBody, filePathAad, isEncryptedFile } from "../secure-store/secure-fs.js";
import { pendingLifecycleLedgerDir } from "../storage/memory-lifecycle-ledger-access.js";

/** Build a fixture PluginConfig. Cast bridges a partial fixture to the full
 *  contract — only the fields the scheduler/planner read are populated. */
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

/** Minimal QMD stub — runQmdMaintenance's namespaces branch never touches qmd
 *  directly; only isAvailable() is checked when arming pending work. */
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
// runQmdMaintenance — namespace union, cadence, and failure semantics
// (ported from orchestrator-flush.test.ts; behavior unchanged)
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
  // Fixture: catalog stub implements only listNamespaces + enabled.
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
    scheduler.dispose();
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
    scheduler.dispose();
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
    scheduler.dispose();
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
    scheduler.dispose();
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
    scheduler.dispose();
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
    scheduler.dispose();
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
    scheduler.dispose();
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
    scheduler.dispose();
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
    scheduler.dispose();
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
    scheduler.dispose();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("MaintenanceScheduler reads a runtime-swapped qmd backend via getQmd (regression for captured-by-value)", async () => {
  // Regression for issue #1526 PR1: when MaintenanceSchedulerDeps.qmd was a
  // fixed reference captured at construction, the orchestrator's runtime swap
  // `this.qmd = new NoopSearchBackend()` (initialize / startupSearchSync,
  // invoked when the collection is missing) left the scheduler running
  // debounced maintenance against the disposed/stale backend. The live
  // `getQmd: () => this.qmd` accessor must observe the swap so maintenance
  // short-circuits once the backend reports unavailable.
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

    // The orchestrator swaps to a Noop backend at runtime when the collection
    // is missing — the scheduler must observe the new reference, not the one
    // captured at construction.
    holder.backend = noopBackend;
    scheduler.requestQmdMaintenanceForTool("test");
    await scheduler.runQmdMaintenance();
    assert.deepEqual(
      calls,
      ["live.update"],
      "after the swap to NoopSearchBackend, requestQmdMaintenance must short-circuit (isAvailable===false) and never touch the disposed backend",
    );
  } finally {
    scheduler.dispose();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Lifecycle-ledger auto-compaction (issue #1910)
// ───────────────────────────────────────────────────────────────────────────

/** Access the private size-gated compaction trigger for focused testing. */
interface CompactableScheduler {
  maybeCompactMemoryLifecycleLedger(): Promise<void>;
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
  // Oversized legacy ledger: many junk rows the rebuild will discard (it
  // reconstructs from frontmatter), so the compacted output is far smaller.
  const line = '{"legacy":true,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';
  const rows = Math.ceil(padBytes / line.length);
  await writeFile(ledgerPath, line.repeat(rows), "utf-8");
  return { memoryDir, ledgerPath };
}

function buildCompactionScheduler(config: PluginConfig): CompactableScheduler {
  return new MaintenanceScheduler({
    config,
    getQmd: () => stubQmd(),
    // The compaction path never touches the router/catalog.
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
      scheduler.dispose();
    }

    const afterSize = (await stat(ledgerPath)).size;
    assert.ok(afterSize < beforeSize, "compacted ledger must be smaller");
    const rebuilt = (await readFile(ledgerPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rebuilt.map((r) => r.eventType), ["created", "updated"]);

    // A verbatim backup of the original ledger must exist under archive/.
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
    // Oversized: junk pad rows the rebuild discards + one valid append-only
    // event frontmatter cannot reconstruct and MUST survive compaction.
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
      scheduler.dispose();
    }

    const rebuilt = (await readFile(ledgerPath, "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { eventId: string; eventType: string; legacy?: boolean });
    const eventTypes = rebuilt.map((r) => r.eventType);
    // Frontmatter-derived rows are reconstructed AND the append-only capture row
    // is carried over (a bare rebuild dropped it silently before this fix).
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
      scheduler.dispose();
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

      // Re-grow the ledger past the threshold; a second immediate call is
      // inside the min-interval window and must be throttled (no recompaction).
      const line = '{"legacy":true,"pad":"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"}\n';
      await writeFile(ledgerPath, line.repeat(Math.ceil(4096 / line.length)), "utf-8");
      const regrownSize = (await stat(ledgerPath)).size;

      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.equal((await stat(ledgerPath)).size, regrownSize, "throttled: ledger not recompacted");
      assert.ok(regrownSize > compactedSize);
    } finally {
      scheduler.dispose();
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
      scheduler.dispose();
    }
    assert.equal(await readFile(ledgerPath, "utf-8"), before, "under threshold: ledger untouched");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

/** Scheduler wired with a live secure-store-configured root storage (issue
 *  #1910, Cursor Medium / Codex P2). */
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
      // Failed run must NOT shrink the ledger and must NOT arm the throttle.
      assert.equal((await stat(ledgerPath)).size, beforeSize, "failed run leaves ledger intact");

      // Unlock the store, then call again INSIDE the min-interval window. If the
      // failed run had armed the throttle this second call would be skipped and
      // the ledger would stay oversized. Because it did not, the ledger compacts.
      storage.setSecureStoreKey(Buffer.alloc(32, 9));
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.ok(
        (await stat(ledgerPath)).size < beforeSize,
        "still-eligible retry compacts once the failure clears",
      );
    } finally {
      scheduler.dispose();
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
      scheduler.dispose();
    }
    // The rewritten ledger is encrypted at rest and smaller than the plaintext
    // original, and decrypts back to the rebuilt events via the same key.
    assert.ok(isEncryptedFile(await readFile(ledgerPath)), "compacted ledger must be encrypted");
    assert.ok((await stat(ledgerPath)).size < beforeSize);
    const rebuilt = await storage.readAllMemoryLifecycleEvents();
    assert.deepEqual(rebuilt.map((e) => e.eventType), ["created", "updated"]);
    // The backup is the verbatim original plaintext ledger.
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

test("mixed pass: a deferred encrypted target keeps the throttle un-armed so untouched ledgers retry (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-mixed-"));
  try {
    const junk = '{"legacy":true,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n';
    const junkBlob = junk.repeat(Math.ceil(4096 / junk.length));

    // Root: plaintext oversized ledger with a reconstructable memory → compacts.
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

    // Namespace: encrypted-at-rest oversized ledger whose secure store is LOCKED
    // (required, no key). Compaction must DEFER it (not skip) so this untouched,
    // still-oversized ledger keeps its retry eligibility.
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

      // Re-grow the root within the min-interval window. Because a target was
      // DEFERRED (not a genuine no-op), the throttle must NOT have armed, so this
      // second in-window pass still recompacts — the #2033 throttle fix.
      await writeFile(rootLedger, junkBlob, "utf-8");
      const regrown = (await stat(rootLedger)).size;
      await scheduler.maybeCompactMemoryLifecycleLedger();
      assert.ok(
        (await stat(rootLedger)).size < regrown,
        "deferred target left the throttle un-armed: the second in-window pass recompacts",
      );
    } finally {
      scheduler.dispose();
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
    // An encrypted pending spill, exactly as a lock-timed-out append leaves it.
    const spillDir = pendingLifecycleLedgerDir(ledgerPath);
    await mkdir(spillDir, { recursive: true });
    const spillPath = path.join(spillDir, "spill.jsonl");
    const row =
      `{"eventId":"evt-spilled","memoryId":"m","eventType":"created",`
      + `"timestamp":"2026-03-08T00:00:00.000Z","actor":"t","ruleVersion":"1"}\n`;
    await writeFile(spillPath, encryptFileBody(row, key, filePathAad(spillPath, memoryDir)));

    // Compaction disabled (threshold 0): the unconditional root drain must still
    // fold the spill back into the ledger so no lifecycle row is lost.
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
      scheduler.dispose();
    }

    const ids = (await storage.readAllMemoryLifecycleEvents()).map((e) => e.eventId);
    assert.ok(ids.includes("evt-spilled"), "spill drained into the ledger with compaction disabled");
    await assert.rejects(() => stat(spillPath), /ENOENT/, "spill file removed after drain");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("auto-compaction bounds per-namespace ledgers, not just the root state path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-"));
  try {
    // Root ledger stays absent (nothing to compact); a namespace under
    // memoryDir/namespaces/<token>/ carries the oversized ledger.
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
      scheduler.dispose();
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
    // Namespaces enabled but the catalog is inactive, so only the filesystem
    // fallback finds this per-namespace ledger. It is encrypted at rest and
    // oversized, but the fallback has no secure StorageManager for a
    // catalog-disabled namespace. The rebuild-chokepoint guard must REFUSE to
    // rebuild it through a plaintext StorageManager — leaving it untouched and
    // still encrypted — rather than downgrade it to plaintext.
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
      scheduler.dispose();
    }
    // Skipped, not rewritten: the encrypted ledger must be byte-for-byte intact.
    assert.deepEqual(
      await readFile(nsLedger),
      encrypted,
      "encrypted namespace ledger must be left untouched, never plaintext-rewritten",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog-disabled fallback refuses a symlinked namespaces scan root (#2033)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-autocompact-ns-outside-"));
  try {
    // <root>/namespaces is a symlink pointing OUTSIDE the memory dir. Following
    // it would let compaction read/rewrite ledgers outside memoryDir, so the
    // scan root must be rejected and the external ledger left untouched.
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
      scheduler.dispose();
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
    // QMD reports unavailable, so requestQmdMaintenance() short-circuits and
    // runQmdMaintenance() never fires. The compaction check must still be wired
    // off the request entrypoint so a QMD-off deployment keeps bounding the
    // ledger. requestQmdMaintenanceForTool invokes the check synchronously
    // (fire-and-forget), so a spy on the private method observes the wiring
    // deterministically without waiting on the async filesystem work.
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
    // Named seam cast (reason: reach the private compaction method to observe
    // the request→compaction wiring), mirroring the CompactableScheduler cast
    // used by the direct compaction tests above.
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
      scheduler.dispose();
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

    // namespacesEnabled=true but NO catalog wired (the namespaceCatalogEnabled=false
    // deployment). The catalog walk finds nothing; the filesystem fallback must
    // still discover and bound the per-namespace ledger (codex P2).
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
      scheduler.dispose();
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
