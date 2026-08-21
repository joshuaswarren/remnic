import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { NamespaceCatalog, NamespaceRecord } from "../namespaces/catalog.js";
import { namespaceIdentityToken } from "../namespaces/identity.js";
import type { PluginConfig } from "../types.js";
import {
  NAMESPACE_MAINTENANCE_JOBS,
  formatNamespaceMaintenanceHealthText,
  runNamespaceMaintenanceFanout,
  summarizeNamespaceMaintenanceHealth,
} from "./namespace-maintenance-fanout.js";

function makeConfig(memoryDir: string, overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    memoryDir,
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    maintenanceNamespaceFanoutEnabled: true,
    maintenanceMaxNamespacesPerCycle: 20,
    maintenanceIncludeProjectNamespaces: true,
    maintenanceIncludeBranchNamespaces: false,
    maintenanceIncludeTeamProjectNamespaces: true,
    maintenanceNamespaceLockStaleMs: 10 * 60_000,
    qmdCollection: "remnic",
    entitySchemas: {},
    inlineSourceAttributionFormat: undefined,
    ...overrides,
  } as unknown as PluginConfig;
}

async function mkMemoryDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remnic-fanout-"));
}

async function createNamespaceData(memoryDir: string, namespace: string): Promise<string> {
  const storageDir = path.join(memoryDir, "namespaces", namespaceIdentityToken(namespace));
  await mkdir(path.join(storageDir, "facts"), { recursive: true });
  await writeFile(path.join(storageDir, "facts", "sample.md"), "# sample\n", "utf8");
  return storageDir;
}

function fakeCatalog(records: NamespaceRecord[]): NamespaceCatalog {
  return {
    enabled: true,
    async listNamespaces() {
      return records;
    },
    async markMaintenance() {},
  } as unknown as NamespaceCatalog;
}

function record(
  memoryDir: string,
  namespace: string,
  kind: NamespaceRecord["kind"],
  lastWriteAt: string,
): NamespaceRecord {
  return {
    namespace,
    identityToken: namespaceIdentityToken(namespace),
    kind,
    createdAt: "2026-06-30T00:00:00.000Z",
    lastWriteAt,
    storageDir: path.join(memoryDir, "namespaces", namespaceIdentityToken(namespace)),
    discoveredBy: "write",
  };
}

// ---------------------------------------------------------------------------
// runNamespaceMaintenanceFanout
// ---------------------------------------------------------------------------

test("fanout runs a job across all maintained namespaces (default + catalog)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-alpha");
    await createNamespaceData(memoryDir, "team-pi-project-beta");

    const config = makeConfig(memoryDir);
    const catalog = fakeCatalog([
      record(memoryDir, "project-alpha", "project", "2026-07-01T10:00:00.000Z"),
      record(memoryDir, "team-pi-project-beta", "team-project", "2026-07-01T11:00:00.000Z"),
    ]);

    const seen: string[] = [];
    const summary = await runNamespaceMaintenanceFanout({
      config,
      catalog,
      jobName: "pattern-reinforcement",
      resolveStorage: async () => ({}),
      runner: async (ctx) => {
        seen.push(ctx.candidate.namespace);
        return { itemCount: 1 };
      },
    });

    // default + shared (configured) + project-alpha + team-pi-project-beta
    assert.ok(seen.includes("default"), "default namespace should be maintained");
    assert.ok(seen.includes("project-alpha"), "project namespace should be maintained");
    assert.ok(seen.includes("team-pi-project-beta"), "team-project namespace should be maintained");
    assert.equal(summary.ran, seen.length);
    assert.equal(summary.failed, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fanout skips branch namespaces by default", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-alpha-branch-main");

    const config = makeConfig(memoryDir);
    const catalog = fakeCatalog([
      record(memoryDir, "project-alpha-branch-main", "branch", "2026-07-01T12:00:00.000Z"),
    ]);

    const seen: string[] = [];
    const summary = await runNamespaceMaintenanceFanout({
      config,
      catalog,
      jobName: "graph-decay",
      resolveStorage: async () => ({}),
      runner: async (ctx) => {
        seen.push(ctx.candidate.namespace);
        return undefined;
      },
    });

    assert.ok(
      !seen.includes("project-alpha-branch-main"),
      "branch namespace should be skipped by default",
    );
    assert.ok(
      summary.skipped >= 1,
      "branch namespace should appear in skipped count",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fanout includes branch namespaces when config enables them", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-alpha-branch-main");

    const config = makeConfig(memoryDir, {
      maintenanceIncludeBranchNamespaces: true,
    });
    const catalog = fakeCatalog([
      record(memoryDir, "project-alpha-branch-main", "branch", "2026-07-01T12:00:00.000Z"),
    ]);

    const seen: string[] = [];
    await runNamespaceMaintenanceFanout({
      config,
      catalog,
      jobName: "graph-decay",
      resolveStorage: async () => ({}),
      runner: async (ctx) => {
        seen.push(ctx.candidate.namespace);
        return undefined;
      },
    });

    assert.ok(
      seen.includes("project-alpha-branch-main"),
      "branch namespace should be maintained when config enables it",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fanout isolates per-namespace failures (one namespace failing does not abort others)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-good");
    await createNamespaceData(memoryDir, "project-bad");

    const config = makeConfig(memoryDir);
    const catalog = fakeCatalog([
      record(memoryDir, "project-good", "project", "2026-07-01T10:00:00.000Z"),
      record(memoryDir, "project-bad", "project", "2026-07-01T11:00:00.000Z"),
    ]);

    const summary = await runNamespaceMaintenanceFanout({
      config,
      catalog,
      jobName: "semantic-consolidation",
      resolveStorage: async () => ({}),
      runner: async (ctx) => {
        if (ctx.candidate.namespace === "project-bad") {
          throw new Error("simulated namespace failure");
        }
        return { itemCount: 5 };
      },
    });

    assert.ok(summary.failed >= 1, "failing namespace should be recorded as failed");
    assert.ok(summary.ran >= 1, "other namespaces should still run");
    const failedStatus = summary.statuses.find((s) => s.state === "failed");
    assert.ok(failedStatus, "failed status should be recorded");
    assert.ok(failedStatus!.error, "failed status should record an error detail");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fanout returns zero-summary when enabled=false (job gate off)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const catalog = fakeCatalog([
      record(memoryDir, "project-alpha", "project", "2026-07-01T10:00:00.000Z"),
    ]);

    let called = false;
    const summary = await runNamespaceMaintenanceFanout({
      config,
      catalog,
      jobName: "pattern-reinforcement",
      resolveStorage: async () => ({}),
      enabled: false,
      runner: async () => {
        called = true;
        return undefined;
      },
    });

    assert.equal(called, false, "runner must not be called when enabled=false");
    assert.equal(summary.ran, 0);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.failed, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fanout passes resolveStorage to the runner for per-namespace storage resolution", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const resolvedNamespaces: string[] = [];

    await runNamespaceMaintenanceFanout({
      config,
      jobName: "lifecycle",
      resolveStorage: async (namespace) => {
        resolvedNamespaces.push(namespace);
        return { dir: path.join(memoryDir, "namespaces", namespaceIdentityToken(namespace)) };
      },
      runner: async (ctx) => {
        const storage = await ctx.resolveStorage(ctx.candidate.namespace);
        assert.ok(typeof (storage as { dir: string }).dir === "string", "storage should be resolved");
        return { itemCount: 1 };
      },
    });

    assert.ok(
      resolvedNamespaces.includes("default"),
      "default namespace storage should be resolved",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fanout respects maxNamespacesPerCycle budget", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-a");
    await createNamespaceData(memoryDir, "project-b");
    await createNamespaceData(memoryDir, "project-c");

    const config = makeConfig(memoryDir, { maintenanceMaxNamespacesPerCycle: 2 });
    const catalog = fakeCatalog([
      record(memoryDir, "project-a", "project", "2026-07-01T10:00:00.000Z"),
      record(memoryDir, "project-b", "project", "2026-07-01T11:00:00.000Z"),
      record(memoryDir, "project-c", "project", "2026-07-01T12:00:00.000Z"),
    ]);

    const seen: string[] = [];
    const summary = await runNamespaceMaintenanceFanout({
      config,
      catalog,
      jobName: "pattern-reinforcement",
      resolveStorage: async () => ({}),
      runner: async (ctx) => {
        seen.push(ctx.candidate.namespace);
        return undefined;
      },
    });

    // Budget caps the selected count. Default + shared (configured) are always
    // included, so the total selected is min(maxNamespacesPerCycle, candidates).
    assert.ok(
      summary.ran + summary.skipped <= 2 || seen.length <= 2,
      "budget should cap the number of namespaces processed",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fanout updates lastMaintenanceAt through the catalog", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-alpha");

    const config = makeConfig(memoryDir);
    const marked: Array<{ namespace: string; jobName: string }> = [];
    const catalog = {
      enabled: true,
      async listNamespaces() {
        return [record(memoryDir, "project-alpha", "project", "2026-07-01T10:00:00.000Z")];
      },
      async markMaintenance(namespace: string, jobName: string) {
        marked.push({ namespace, jobName });
      },
    } as unknown as NamespaceCatalog;

    await runNamespaceMaintenanceFanout({
      config,
      catalog,
      jobName: "pattern-reinforcement",
      resolveStorage: async () => ({}),
      runner: async () => ({ itemCount: 1 }),
    });

    const alphaMark = marked.find((m) => m.namespace === "project-alpha");
    assert.ok(alphaMark, "catalog markMaintenance should be called for project-alpha");
    assert.equal(alphaMark!.jobName, "pattern-reinforcement");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Namespaces-disabled behavior (single-user compatibility)
// ---------------------------------------------------------------------------

test("fanout runs once against default when namespaces are disabled", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir, {
      namespacesEnabled: false,
      namespaceCatalogEnabled: false,
    });

    const seen: string[] = [];
    const summary = await runNamespaceMaintenanceFanout({
      config,
      jobName: "pattern-reinforcement",
      resolveStorage: async () => ({}),
      runner: async (ctx) => {
        seen.push(ctx.candidate.namespace);
        return undefined;
      },
    });

    // Namespaces disabled: storageFor() collapses every name to memoryDir, so
    // the planner seeds ONLY the default namespace to avoid double-processing
    // the same corpus (review #1622: honor the namespace fanout opt-out).
    assert.deepEqual(seen, ["default"], "only the default namespace is processed when namespaces are disabled");
    assert.equal(summary.ran, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fanout runs once against default when maintenanceNamespaceFanoutEnabled is false", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-alpha");
    const config = makeConfig(memoryDir, {
      maintenanceNamespaceFanoutEnabled: false,
    });
    const catalog = fakeCatalog([
      record(memoryDir, "project-alpha", "project", "2026-07-01T10:00:00.000Z"),
    ]);

    const seen: string[] = [];
    await runNamespaceMaintenanceFanout({
      config,
      catalog,
      jobName: "pattern-reinforcement",
      resolveStorage: async () => ({}),
      runner: async (ctx) => {
        seen.push(ctx.candidate.namespace);
        return undefined;
      },
    });

    assert.deepEqual(seen, ["default", "shared"], "configured namespaces are processed even with catalog fanout disabled");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// summarizeNamespaceMaintenanceHealth + formatNamespaceMaintenanceHealthText
// ---------------------------------------------------------------------------

test("health summary aggregates per-job statuses and reports fanout config", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);

    // Run a job to generate status files.
    await runNamespaceMaintenanceFanout({
      config,
      jobName: "pattern-reinforcement",
      resolveStorage: async () => ({}),
      runner: async () => ({ itemCount: 3 }),
    });

    const summary = await summarizeNamespaceMaintenanceHealth(config);

    assert.equal(summary.fanoutEnabled, true);
    assert.equal(summary.namespacesEnabled, true);
    assert.equal(summary.maxNamespacesPerCycle, 20);
    assert.ok(summary.totalRan >= 1, "at least one run should be recorded");

    const prJob = summary.jobs.find((j) => j.jobName === "pattern-reinforcement");
    assert.ok(prJob, "pattern-reinforcement job should appear in health summary");
    assert.ok(prJob!.ran >= 1, "pattern-reinforcement should have at least one ran namespace");
    assert.ok(prJob!.lastRunAt !== null, "lastRunAt should be populated");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health summary includes all standard job names even with no status files", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const summary = await summarizeNamespaceMaintenanceHealth(config);

    for (const jobName of NAMESPACE_MAINTENANCE_JOBS) {
      const job = summary.jobs.find((j) => j.jobName === jobName);
      assert.ok(job, `standard job '${jobName}' should appear in health summary even with no runs`);
    }
    assert.equal(summary.totalRan, 0);
    assert.equal(summary.totalFailed, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("formatNamespaceMaintenanceHealthText produces readable output", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);

    await runNamespaceMaintenanceFanout({
      config,
      jobName: "graph-decay",
      resolveStorage: async () => ({}),
      runner: async () => ({ itemCount: 10 }),
    });

    const summary = await summarizeNamespaceMaintenanceHealth(config);
    const text = formatNamespaceMaintenanceHealthText(summary);

    assert.ok(text.includes("=== Namespace Maintenance ==="), "header should be present");
    assert.ok(text.includes("fanout:"), "fanout status should be present");
    assert.ok(text.includes("graph-decay:"), "job breakdown should include graph-decay");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("formatNamespaceMaintenanceHealthText handles empty state", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const summary = await summarizeNamespaceMaintenanceHealth(config);
    const text = formatNamespaceMaintenanceHealthText(summary);

    assert.ok(text.includes("(no maintenance status recorded yet)"), "should report empty state");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("fanout records runner-reported skip as skipped (cadence-skip accuracy, review #1622)", async () => {
  // Regression: when a job's own cadence gate throttles a namespace, the
  // runner resolves without throwing. Before the fix the planner recorded
  // state:"ran" and bumped lastMaintenanceAt, so a throttled namespace
  // looked maintained. Now the runner signals { skipped: true } and the
  // planner records state:"skipped" without touching lastMaintenanceAt.
  const memoryDir = await mkMemoryDir();
  try {
    // Default-only config (namespaces disabled): the planner runs the job
    // exactly once against the default namespace, isolating the skip-signal
    // contract from catalog namespace discovery.
    const config = makeConfig(memoryDir);

    const summary = await runNamespaceMaintenanceFanout({
      config,
      jobName: "pattern-reinforcement",
      resolveStorage: async () => ({}),
      runner: async () => ({ skipped: true, skipReason: "cadence" }),
    });

    // Configured namespaces (default + shared) are both processed; the
    // contract under test is that NONE are recorded as ran and EVERY
    // status carries the runner's skip reason — no phantom lastMaintenanceAt.
    assert.equal(summary.ran, 0, "no namespace should be recorded as ran");
    assert.equal(summary.failed, 0);
    assert.equal(summary.skipped, summary.statuses.length, "every processed namespace recorded as skipped");
    assert.ok(summary.statuses.length >= 1, "at least one namespace was processed");
    for (const status of summary.statuses) {
      assert.equal(status.state, "skipped", `namespace ${status.namespace} state`);
      assert.equal(status.reason, "cadence", `namespace ${status.namespace} skipReason propagated`);
      assert.equal(status.itemCount, undefined, `namespace ${status.namespace} no itemCount on skip`);
    }

    // Health summary reflects the skips, not phantom runs.
    const health = await summarizeNamespaceMaintenanceHealth(config);
    assert.equal(health.totalRan, 0);
    assert.equal(health.totalSkipped, summary.statuses.length);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("formatNamespaceMaintenanceHealthText surfaces failed namespace names and reasons (review #1622)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    // Run a job that fails for one namespace and succeeds for another.
    const catalog = fakeCatalog([
      record(memoryDir, "default", "default", new Date().toISOString()),
    ]);
    await runNamespaceMaintenanceFanout({
      config,
      catalog,
      jobName: "governance",
      resolveStorage: async () => { throw new Error("disk full"); },
      runner: async () => { throw new Error("disk full"); },
    });

    const summary = await summarizeNamespaceMaintenanceHealth(config);
    const text = formatNamespaceMaintenanceHealthText(summary);
    // The failed namespace name and its error must appear in human-readable
    // output so operators know WHAT to fix without --json.
    assert.ok(text.includes("default"), "failed namespace name in output");
    assert.ok(text.includes("disk full") || text.includes("failed"), "failure detail in output");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("health summary lastRunAt survives a later skip via last-ran records (review #1622)", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);

    // First: a successful run writes both <ns>.json (ran) and <ns>.last-ran.json.
    await runNamespaceMaintenanceFanout({
      config,
      jobName: "semantic-consolidation",
      resolveStorage: async () => ({}),
      runner: async () => ({ itemCount: 3 }),
    });

    // Second: a skip overwrites <ns>.json with "skipped" but leaves last-ran.
    await runNamespaceMaintenanceFanout({
      config,
      jobName: "semantic-consolidation",
      resolveStorage: async () => ({}),
      runner: async () => ({ skipped: true, skipReason: "cadence" }),
    });

    const health = await summarizeNamespaceMaintenanceHealth(config);
    const job = health.jobs.find((j) => j.jobName === "semantic-consolidation");
    assert.ok(job, "semantic-consolidation job in health summary");
    // The latest outcome is skipped, but lastRunAt must still reflect the
    // prior successful run (from the last-ran record), not null.
    assert.ok(job!.lastRunAt, "lastRunAt preserved from last-ran after a skip");
    assert.notEqual(job!.lastRunAt, null);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
