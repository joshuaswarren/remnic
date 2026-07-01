import assert from "node:assert/strict";
import { lutimes, mkdir, mkdtemp, open as openFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { NamespaceCatalog, NamespaceRecord } from "../namespaces/catalog.js";
import { namespaceIdentityToken } from "../namespaces/identity.js";
import type { PluginConfig } from "../types.js";
import {
  __setNamespaceMaintenanceFsForTest,
  type NamespaceMaintenanceCandidate,
  planNamespaceMaintenance,
  readNamespaceMaintenanceStatuses,
  runNamespaceMaintenanceBatchPlan,
  runNamespaceMaintenancePlan,
} from "./namespace-planner.js";

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
  return mkdtemp(path.join(os.tmpdir(), "remnic-maintenance-planner-"));
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
  lastWriteAt: string
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeStatus(
  memoryDir: string,
  status: {
    namespace: string;
    jobName?: string;
    state?: "ran" | "skipped" | "failed";
    reason?: string;
    completedAt: string;
  }
): Promise<void> {
  const jobName = status.jobName ?? "qmd";
  const statusDir = path.join(memoryDir, "state", "namespace-maintenance-status", jobName);
  await mkdir(statusDir, { recursive: true });
  await writeFile(
    path.join(statusDir, `${namespaceIdentityToken(status.namespace)}.json`),
    `${JSON.stringify({
      version: 1,
      namespace: status.namespace,
      jobName,
      state: status.state ?? "ran",
      reason: status.reason,
      startedAt: status.completedAt,
      completedAt: status.completedAt,
    })}\n`,
    "utf8"
  );
}

test("planner fans out to live cataloged project and team namespaces while skipping branches by default", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-alpha");
    await createNamespaceData(memoryDir, "team-pi-project-alpha");
    await createNamespaceData(memoryDir, "project-alpha-branch-main");

    const plan = await planNamespaceMaintenance(makeConfig(memoryDir), {
      jobName: "qmd",
      catalog: fakeCatalog([
        record(memoryDir, "project-alpha", "project", "2026-06-30T10:00:00.000Z"),
        record(memoryDir, "team-pi-project-alpha", "team-project", "2026-06-30T11:00:00.000Z"),
        record(memoryDir, "project-alpha-branch-main", "branch", "2026-06-30T12:00:00.000Z"),
      ]),
    });

    assert.deepEqual(
      plan.namespaces.map((candidate) => candidate.namespace),
      ["default", "shared", "team-pi-project-alpha", "project-alpha"]
    );
    assert.ok(
      plan.skipped.some(
        (skipped) => skipped.namespace === "project-alpha-branch-main" && skipped.reason === "branch_disabled"
      )
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("planner includes branch namespaces only when branch maintenance is enabled", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-alpha-branch-main");

    const plan = await planNamespaceMaintenance(makeConfig(memoryDir, { maintenanceIncludeBranchNamespaces: true }), {
      jobName: "qmd",
      catalog: fakeCatalog([record(memoryDir, "project-alpha-branch-main", "branch", "2026-06-30T12:00:00.000Z")]),
    });

    assert.ok(
      plan.namespaces.some((candidate) => candidate.namespace === "project-alpha-branch-main"),
      "branch namespace should be selected when explicitly enabled"
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("planner applies maxNamespacesPerCycle deterministically after default and shared", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-a");
    await createNamespaceData(memoryDir, "project-b");

    const plan = await planNamespaceMaintenance(makeConfig(memoryDir, { maintenanceMaxNamespacesPerCycle: 3 }), {
      jobName: "qmd",
      catalog: fakeCatalog([
        record(memoryDir, "project-a", "project", "2026-06-30T10:00:00.000Z"),
        record(memoryDir, "project-b", "project", "2026-06-30T11:00:00.000Z"),
      ]),
    });

    assert.deepEqual(
      plan.namespaces.map((candidate) => candidate.namespace),
      ["default", "shared", "project-b"]
    );
    assert.ok(
      plan.skipped.some((skipped) => skipped.namespace === "project-a" && skipped.reason === "budget_exhausted")
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("planner preserves configured default priority when catalog metadata disagrees", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const defaultRecord = record(memoryDir, "default", "project", "2026-06-30T08:00:00.000Z");
    defaultRecord.lastMaintenanceAt = { qmd: "2026-06-30T12:00:00.000Z" };

    const plan = await planNamespaceMaintenance(
      makeConfig(memoryDir, {
        maintenanceMaxNamespacesPerCycle: 2,
        namespacePolicies: [
          {
            name: "project-explicit",
            readPrincipals: ["*"],
            writePrincipals: ["*"],
          },
        ],
      }),
      {
        jobName: "qmd",
        catalog: fakeCatalog([defaultRecord]),
      },
    );

    assert.deepEqual(
      plan.namespaces.map((candidate) => [candidate.namespace, candidate.kind]),
      [
        ["default", "default"],
        ["shared", "shared"],
      ],
    );
    assert.ok(
      plan.skipped.some(
        (skipped) => skipped.namespace === "project-explicit" && skipped.reason === "budget_exhausted"
      ),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("planner can return the full safe namespace union without applying the cycle budget", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-a");
    await createNamespaceData(memoryDir, "project-b");

    const plan = await planNamespaceMaintenance(makeConfig(memoryDir, { maintenanceMaxNamespacesPerCycle: 3 }), {
      jobName: "qmd",
      budgetMode: "unbounded",
      catalog: fakeCatalog([
        record(memoryDir, "project-a", "project", "2026-06-30T10:00:00.000Z"),
        record(memoryDir, "project-b", "project", "2026-06-30T11:00:00.000Z"),
      ]),
    });

    assert.deepEqual(
      plan.namespaces.map((candidate) => candidate.namespace),
      ["default", "shared", "project-b", "project-a"]
    );
    assert.ok(
      !plan.skipped.some((skipped) => skipped.reason === "budget_exhausted"),
      "startup/recovery namespace discovery must not drop safe namespaces because of the maintenance cycle budget"
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("planner rotates budgeted dynamic namespaces by maintenance age before write recency", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await createNamespaceData(memoryDir, "project-old-maintenance");
    await createNamespaceData(memoryDir, "project-new-maintenance");
    await createNamespaceData(memoryDir, "project-never-maintained");

    const oldMaintenance = record(memoryDir, "project-old-maintenance", "project", "2026-06-30T10:00:00.000Z");
    oldMaintenance.lastMaintenanceAt = { qmd: "2026-06-30T10:30:00.000Z" };
    const newMaintenance = record(memoryDir, "project-new-maintenance", "project", "2026-06-30T12:00:00.000Z");
    newMaintenance.lastMaintenanceAt = { qmd: "2026-06-30T12:30:00.000Z" };
    const neverMaintained = record(memoryDir, "project-never-maintained", "project", "2026-06-30T09:00:00.000Z");

    const plan = await planNamespaceMaintenance(makeConfig(memoryDir, { maintenanceMaxNamespacesPerCycle: 4 }), {
      jobName: "qmd",
      catalog: fakeCatalog([newMaintenance, oldMaintenance, neverMaintained]),
    });

    assert.deepEqual(
      plan.namespaces.map((candidate) => candidate.namespace),
      ["default", "shared", "project-never-maintained", "project-old-maintenance"]
    );
    assert.ok(
      plan.skipped.some(
        (skipped) => skipped.namespace === "project-new-maintenance" && skipped.reason === "budget_exhausted"
      ),
      "recently maintained dynamic namespaces should yield the cycle budget to never/older-maintained namespaces"
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("planner rotates configured namespaces from status history when catalog metadata is unavailable", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    for (const [namespace, completedAt] of [
      ["project-a", "2026-06-30T12:00:00.000Z"],
      ["project-b", "2026-06-30T10:00:00.000Z"],
      ["project-c", "2026-06-30T11:00:00.000Z"],
    ] as const) {
      await writeStatus(memoryDir, { namespace, completedAt });
    }

    const plan = await planNamespaceMaintenance(
      makeConfig(memoryDir, {
        namespaceCatalogEnabled: false,
        maintenanceMaxNamespacesPerCycle: 3,
        namespacePolicies: [
          { name: "project-a", readPrincipals: ["*"], writePrincipals: ["*"] },
          { name: "project-b", readPrincipals: ["*"], writePrincipals: ["*"] },
          { name: "project-c", readPrincipals: ["*"], writePrincipals: ["*"] },
        ],
      }),
      {
        jobName: "qmd",
      }
    );

    assert.deepEqual(
      plan.namespaces.map((candidate) => candidate.namespace),
      ["default", "shared", "project-b"]
    );
    assert.ok(plan.skipped.some((skipped) => skipped.namespace === "project-a" && skipped.reason === "budget_exhausted"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("planner ignores unsuccessful status history when rotating configured namespaces", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    await writeStatus(memoryDir, {
      namespace: "project-a",
      state: "failed",
      completedAt: "2026-06-30T12:00:00.000Z",
    });
    await writeStatus(memoryDir, {
      namespace: "project-b",
      state: "skipped",
      reason: "lock_held",
      completedAt: "2026-06-30T11:00:00.000Z",
    });
    await writeStatus(memoryDir, {
      namespace: "project-c",
      completedAt: "2026-06-30T10:00:00.000Z",
    });

    const plan = await planNamespaceMaintenance(
      makeConfig(memoryDir, {
        namespaceCatalogEnabled: false,
        maintenanceMaxNamespacesPerCycle: 3,
        namespacePolicies: [
          { name: "project-a", readPrincipals: ["*"], writePrincipals: ["*"] },
          { name: "project-b", readPrincipals: ["*"], writePrincipals: ["*"] },
          { name: "project-c", readPrincipals: ["*"], writePrincipals: ["*"] },
        ],
      }),
      {
        jobName: "qmd",
      }
    );

    assert.deepEqual(
      plan.namespaces.map((candidate) => candidate.namespace),
      ["default", "shared", "project-a"]
    );
    assert.ok(plan.skipped.some((skipped) => skipped.namespace === "project-c" && skipped.reason === "budget_exhausted"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("planner preserves successful rotation history when later skips overwrite latest status", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir, {
      namespaceCatalogEnabled: false,
      maintenanceMaxNamespacesPerCycle: 3,
      namespacePolicies: [
        { name: "project-a", readPrincipals: ["*"], writePrincipals: ["*"] },
        { name: "project-b", readPrincipals: ["*"], writePrincipals: ["*"] },
        { name: "project-c", readPrincipals: ["*"], writePrincipals: ["*"] },
      ],
    });

    await runNamespaceMaintenancePlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [{ namespace: "project-a", kind: "explicit", source: "configured" }],
        skipped: [],
        budget: { maxNamespacesPerCycle: 3, selected: 1 },
      },
      async () => ({ itemCount: 1 }),
    );
    await runNamespaceMaintenancePlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:01.000Z",
        namespaces: [],
        skipped: [{ namespace: "project-a", kind: "explicit", reason: "budget_exhausted" }],
        budget: { maxNamespacesPerCycle: 3, selected: 0 },
      },
      async () => {
        throw new Error("skipped plans must not run namespace work");
      },
    );

    const statuses = await readNamespaceMaintenanceStatuses(config);
    assert.deepEqual(
      statuses
        .filter((status) => status.namespace === "project-a")
        .map((status) => `${status.state}:${status.reason ?? ""}`),
      ["skipped:budget_exhausted"],
      "public maintenance status should still report the latest observed state",
    );

    const plan = await planNamespaceMaintenance(config, { jobName: "qmd" });

    assert.deepEqual(
      plan.namespaces.map((candidate) => candidate.namespace),
      ["default", "shared", "project-b"],
      "a skipped latest status must not erase the last successful rotation timestamp",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runner honors sub-minute configured stale lock thresholds", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir, { maintenanceNamespaceLockStaleMs: 100_000 });
    const lockDir = path.join(memoryDir, "state", "maintenance-locks", "qmd");
    const lockFile = path.join(lockDir, `${namespaceIdentityToken("project-stale")}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockFile, "stale\n", "utf8");
    const staleTime = new Date(Date.now() - 200_000);
    await utimes(lockFile, staleTime, staleTime);

    let ran = false;
    const summary = await runNamespaceMaintenancePlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [
          {
            namespace: "project-stale",
            kind: "project",
            source: "catalog",
          },
        ],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 1 },
      },
      async () => {
        ran = true;
        return { itemCount: 1 };
      }
    );

    assert.equal(ran, true);
    assert.equal(summary.ran, 1);
    assert.equal(summary.skipped, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runner cleans up partial lock files after acquisition setup failures", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const lockFile = path.join(
      memoryDir,
      "state",
      "maintenance-locks",
      "qmd",
      `${namespaceIdentityToken("project-a")}.lock`,
    );
    const probe = await openFile(path.join(memoryDir, "probe.tmp"), "w");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      writeFile: (data: string, encoding: BufferEncoding) => Promise<void>;
    };
    const originalWriteFile = fileHandlePrototype.writeFile;
    await probe.close();
    let injectedFailure = false;
    fileHandlePrototype.writeFile = async function patchedWriteFile(
      this: unknown,
      data: string,
      encoding: BufferEncoding,
    ) {
      await originalWriteFile.call(this, data, encoding);
      if (!injectedFailure) {
        injectedFailure = true;
        throw Object.assign(new Error("simulated lock write failure"), { code: "EIO" });
      }
    };

    try {
      await assert.rejects(
        () =>
          runNamespaceMaintenancePlan(
            config,
            {
              jobName: "qmd",
              generatedAt: "2026-06-30T00:00:00.000Z",
              namespaces: [{ namespace: "project-a", kind: "project", source: "catalog" }],
              skipped: [],
              budget: { maxNamespacesPerCycle: 20, selected: 1 },
            },
            async () => ({ itemCount: 1 }),
          ),
        /simulated lock write failure/,
      );
    } finally {
      fileHandlePrototype.writeFile = originalWriteFile;
    }

    assert.equal(injectedFailure, true);
    await assert.rejects(() => stat(lockFile), "partial setup failures must unlink the created lock file");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runner cleans up lock directories after owner-file open failures", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const lockFile = path.join(
      memoryDir,
      "state",
      "maintenance-locks",
      "qmd",
      `${namespaceIdentityToken("project-a")}.lock`,
    );
    let injectedFailure = false;
    const restoreFs = __setNamespaceMaintenanceFsForTest({
      async open(target, flags) {
        if (target.toString().startsWith(lockFile) && flags === "wx" && !injectedFailure) {
          injectedFailure = true;
          throw Object.assign(new Error("simulated owner open failure"), { code: "ENOSPC" });
        }
        return openFile(target, flags);
      },
    });

    try {
      await assert.rejects(
        () =>
          runNamespaceMaintenancePlan(
            config,
            {
              jobName: "qmd",
              generatedAt: "2026-06-30T00:00:00.000Z",
              namespaces: [{ namespace: "project-a", kind: "project", source: "catalog" }],
              skipped: [],
              budget: { maxNamespacesPerCycle: 20, selected: 1 },
            },
            async () => ({ itemCount: 1 }),
          ),
        /simulated owner open failure/,
      );
    } finally {
      restoreFs();
    }

    assert.equal(injectedFailure, true);
    await assert.rejects(() => stat(lockFile), "owner open failures must remove the empty lock directory");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runner does not recursively retry persistent stale lock removal failures", async () => {
  const memoryDir = await mkMemoryDir();
  const lockDir = path.join(memoryDir, "state", "maintenance-locks", "qmd");
  try {
    const config = makeConfig(memoryDir, { maintenanceNamespaceLockStaleMs: 1 });
    const lockFile = path.join(lockDir, `${namespaceIdentityToken("project-a")}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockFile, "stale\n", "utf8");
    const staleTime = new Date(Date.now() - 5_000);
    await utimes(lockFile, staleTime, staleTime);
    const restoreFs = __setNamespaceMaintenanceFsForTest({
      async rm(target, options) {
        if (target.toString() === lockFile) {
          throw Object.assign(new Error("simulated stale lock removal failure"), { code: "EACCES" });
        }
        return rm(target, options);
      },
    });

    try {
      await assert.rejects(
        () =>
          runNamespaceMaintenancePlan(
            config,
            {
              jobName: "qmd",
              generatedAt: "2026-06-30T00:00:00.000Z",
              namespaces: [{ namespace: "project-a", kind: "project", source: "catalog" }],
              skipped: [],
              budget: { maxNamespacesPerCycle: 20, selected: 1 },
            },
            async () => ({ itemCount: 1 }),
          ),
        (error: unknown) => {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? (error as { code?: string }).code
              : undefined;
          return code === "EACCES";
        },
      );
    } finally {
      restoreFs();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runner treats symlinked stale lock directories as held without traversing them", async () => {
  const memoryDir = await mkMemoryDir();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lock-symlink-target-"));
  const lockDir = path.join(memoryDir, "state", "maintenance-locks", "qmd");
  const sentinelPath = path.join(outsideDir, "sentinel.txt");
  try {
    const config = makeConfig(memoryDir, { maintenanceNamespaceLockStaleMs: 1 });
    const lockFile = path.join(lockDir, `${namespaceIdentityToken("project-a")}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(sentinelPath, "keep\n", "utf8");
    await symlink(outsideDir, lockFile, "dir");
    const staleTime = new Date(Date.now() - 5_000);
    await lutimes(lockFile, staleTime, staleTime);

    const summary = await runNamespaceMaintenancePlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [{ namespace: "project-a", kind: "project", source: "catalog" }],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 1 },
      },
      async () => {
        throw new Error("symlinked lock paths must not be acquired");
      },
    );

    assert.equal(summary.ran, 0);
    assert.equal(summary.skipped, 1);
    assert.ok(
      summary.statuses.some(
        (status) =>
          status.namespace === "project-a" &&
          status.state === "skipped" &&
          status.reason === "lock_held",
      ),
      "symlinked lock paths should be treated as held/corrupt locks",
    );
    await assert.doesNotReject(
      () => stat(sentinelPath),
      "stale lock cleanup must not traverse a symlink and remove files outside memoryDir",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("runner release does not clear a replacement worker lock after stale takeover", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir, { maintenanceNamespaceLockStaleMs: 1 });
    const lockFile = path.join(
      memoryDir,
      "state",
      "maintenance-locks",
      "qmd",
      `${namespaceIdentityToken("project-stale")}.lock`
    );
    const plan = {
      jobName: "qmd",
      generatedAt: "2026-06-30T00:00:00.000Z",
      namespaces: [
        {
          namespace: "project-stale",
          kind: "project" as const,
          source: "catalog" as const,
        },
      ],
      skipped: [],
      budget: { maxNamespacesPerCycle: 20, selected: 1 },
    };

    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const releaseSecond = deferred();

    const firstRun = runNamespaceMaintenancePlan(config, plan, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return { itemCount: 1 };
    });
    await firstEntered.promise;

    const staleTime = new Date(Date.now() - 5_000);
    await utimes(lockFile, staleTime, staleTime);

    const secondRun = runNamespaceMaintenancePlan(config, plan, async () => {
      secondEntered.resolve();
      await releaseSecond.promise;
      return { itemCount: 1 };
    });
    await secondEntered.promise;

    releaseFirst.resolve();
    await firstRun;
    await assert.doesNotReject(
      () => stat(lockFile),
      "first worker release must not delete a newer replacement lock"
    );

    releaseSecond.resolve();
    await secondRun;
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runner records sanitized failure details without raw filesystem paths", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const rawPath = path.join(memoryDir, "state", "maintenance-locks", "secret.json");
    const error = Object.assign(new Error(`failed to open ${rawPath}`), { code: "EACCES" });

    const summary = await runNamespaceMaintenancePlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [
          {
            namespace: "project-failed",
            kind: "project",
            source: "catalog",
          },
        ],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 1 },
      },
      async () => {
        throw error;
      }
    );

    assert.equal(summary.failed, 1);
    assert.equal(summary.statuses[0]?.error, "Error (EACCES)");
    assert.ok(!summary.statuses[0]?.error?.includes(memoryDir), "raw failure status must not leak filesystem paths");

    const statuses = await readNamespaceMaintenanceStatuses(config);
    const persisted = statuses.find((status) => status.namespace === "project-failed");
    assert.equal(persisted?.error, "Error (EACCES)");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runner records lock-held skips without running duplicate namespace work", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const lockDir = path.join(memoryDir, "state", "maintenance-locks", "qmd");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, `${namespaceIdentityToken("project-a")}.lock`), "held\n", "utf8");

    const summary = await runNamespaceMaintenancePlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [
          {
            namespace: "project-a",
            kind: "project",
            source: "catalog",
          },
        ],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 1 },
      },
      async () => {
        throw new Error("runner should not execute when lock is held");
      }
    );

    assert.equal(summary.ran, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.statuses[0]?.reason, "lock_held");

    const statuses = await readNamespaceMaintenanceStatuses(config);
    assert.ok(
      statuses.some(
        (status) =>
          status.namespace === "project-a" &&
          status.jobName === "qmd" &&
          status.state === "skipped" &&
          status.reason === "lock_held"
      ),
      "lock-held status should be persisted for doctor/dashboard consumers"
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runner refreshes live locks during long namespace work", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir, { maintenanceNamespaceLockStaleMs: 30 });
    const lockFile = path.join(
      memoryDir,
      "state",
      "maintenance-locks",
      "qmd",
      `${namespaceIdentityToken("project-a")}.lock`
    );

    await runNamespaceMaintenancePlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [
          {
            namespace: "project-a",
            kind: "project",
            source: "catalog",
          },
        ],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 1 },
      },
      async () => {
        const before = (await stat(lockFile)).mtimeMs;
        await sleep(90);
        const after = (await stat(lockFile)).mtimeMs;
        assert.ok(after > before, "live maintenance locks should be touched before they become stale");
        return { itemCount: 1 };
      }
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("batch runner locks selected namespaces and runs one shared job", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const runnerInputs: string[][] = [];

    const summary = await runNamespaceMaintenanceBatchPlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [
          { namespace: "default", kind: "default", source: "configured" },
          { namespace: "project-a", kind: "project", source: "catalog" },
        ],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 2 },
      },
      async (candidates) => {
        runnerInputs.push(candidates.map((candidate) => candidate.namespace));
        return { itemCount: 1 };
      }
    );

    assert.equal(summary.ran, 2);
    assert.deepEqual(runnerInputs, [["default", "project-a"]]);
    assert.ok(summary.statuses.every((status) => status.state === "ran"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("batch runner can require every selected namespace lock before running shared work", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const lockDir = path.join(memoryDir, "state", "maintenance-locks", "qmd");
    const defaultLock = path.join(lockDir, `${namespaceIdentityToken("default")}.lock`);
    const projectLock = path.join(lockDir, `${namespaceIdentityToken("project-a")}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(projectLock, "held\n", "utf8");
    let runnerCalls = 0;

    const summary = await runNamespaceMaintenanceBatchPlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [
          { namespace: "default", kind: "default", source: "configured" },
          { namespace: "project-a", kind: "project", source: "catalog" },
        ],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 2 },
      },
      async () => {
        runnerCalls += 1;
        return { itemCount: 1 };
      },
      undefined,
      { requireAllLocks: true }
    );

    assert.equal(runnerCalls, 0);
    assert.equal(summary.ran, 0);
    assert.equal(summary.skipped, 2);
    assert.ok(summary.statuses.every((status) => status.state === "skipped"));
    assert.deepEqual(
      Object.fromEntries(summary.statuses.map((status) => [status.namespace, status.reason])),
      {
        default: "batch_lock_incomplete",
        "project-a": "lock_held",
      }
    );
    await assert.rejects(() => stat(defaultLock), "partial acquired locks must be released");
    await assert.doesNotReject(() => stat(projectLock), "externally held locks must be left alone");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("batch runner skips locked namespaces without blocking acquired batch work by default", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const lockDir = path.join(memoryDir, "state", "maintenance-locks", "qmd");
    const defaultLock = path.join(lockDir, `${namespaceIdentityToken("default")}.lock`);
    const projectLock = path.join(lockDir, `${namespaceIdentityToken("project-a")}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(projectLock, "held\n", "utf8");
    const runnerInputs: string[][] = [];

    const summary = await runNamespaceMaintenanceBatchPlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [
          { namespace: "default", kind: "default", source: "configured" },
          { namespace: "project-a", kind: "project", source: "catalog" },
        ],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 2 },
      },
      async (candidates) => {
        runnerInputs.push(candidates.map((candidate) => candidate.namespace));
        return { itemCount: 1 };
      }
    );

    assert.deepEqual(runnerInputs, [["default"]]);
    assert.equal(summary.ran, 1);
    assert.equal(summary.skipped, 1);
    assert.deepEqual(
      Object.fromEntries(summary.statuses.map((status) => [status.namespace, status.state])),
      {
        default: "ran",
        "project-a": "skipped",
      }
    );
    assert.deepEqual(
      Object.fromEntries(summary.statuses.map((status) => [status.namespace, status.reason])),
      {
        default: undefined,
        "project-a": "lock_held",
      }
    );
    await assert.rejects(() => stat(defaultLock), "acquired locks must be released after the batch run");
    await assert.doesNotReject(() => stat(projectLock), "externally held locks must be left alone");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("batch runner releases acquired locks when later lock acquisition throws", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    const lockDir = path.join(memoryDir, "state", "maintenance-locks", "qmd");
    const defaultLock = path.join(lockDir, `${namespaceIdentityToken("default")}.lock`);
    const throwingCandidate = {
      kind: "project",
      source: "catalog",
    } as unknown as NamespaceMaintenanceCandidate;
    Object.defineProperty(throwingCandidate, "namespace", {
      get() {
        throw new Error("namespace unavailable");
      },
    });

    await assert.rejects(
      () =>
        runNamespaceMaintenanceBatchPlan(
          config,
          {
            jobName: "qmd",
            generatedAt: "2026-06-30T00:00:00.000Z",
            namespaces: [
              { namespace: "default", kind: "default", source: "configured" },
              throwingCandidate,
            ],
            skipped: [],
            budget: { maxNamespacesPerCycle: 20, selected: 2 },
          },
          async () => ({ itemCount: 1 }),
        ),
      /namespace unavailable/,
    );

    await assert.rejects(() => stat(defaultLock), "acquired locks must be released on acquisition errors");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("batch runner records every locked namespace as failed when the shared job fails", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);

    const summary = await runNamespaceMaintenanceBatchPlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [
          { namespace: "default", kind: "default", source: "configured" },
          { namespace: "project-a", kind: "project", source: "catalog" },
        ],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 2 },
      },
      async () => {
        throw Object.assign(new Error("qmd failed"), { code: "EIO" });
      }
    );

    assert.equal(summary.failed, 2);
    assert.ok(summary.statuses.every((status) => status.state === "failed"));
    assert.ok(summary.statuses.every((status) => status.error === "Error (EIO)"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("batch runner can record classified shared-job errors as skipped", async () => {
  const memoryDir = await mkMemoryDir();
  try {
    const config = makeConfig(memoryDir);
    let markMaintenanceCalls = 0;
    const catalog = {
      enabled: true,
      async listNamespaces() {
        return [];
      },
      async markMaintenance() {
        markMaintenanceCalls += 1;
      },
    } as unknown as NamespaceCatalog;

    const summary = await runNamespaceMaintenanceBatchPlan(
      config,
      {
        jobName: "qmd",
        generatedAt: "2026-06-30T00:00:00.000Z",
        namespaces: [
          { namespace: "default", kind: "default", source: "configured" },
          { namespace: "project-a", kind: "project", source: "catalog" },
        ],
        skipped: [],
        budget: { maxNamespacesPerCycle: 20, selected: 2 },
      },
      async () => {
        throw new Error("QMD update skipped by global min-interval gate");
      },
      catalog,
      {
        skipReasonForError(error) {
          return error instanceof Error && error.message.includes("min-interval")
            ? "throttled"
            : null;
        },
      },
    );

    assert.equal(summary.ran, 0);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.failed, 0);
    assert.ok(summary.statuses.every((status) => status.state === "skipped"));
    assert.ok(summary.statuses.every((status) => status.reason === "throttled"));
    assert.equal(markMaintenanceCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
