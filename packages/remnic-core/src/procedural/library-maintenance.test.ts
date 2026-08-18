/**
 * Procedure library health maintenance (issue #2370).
 *
 * Covers the acceptance matrix:
 *   - shadow report on the canonical fixture (merge / retire-failing /
 *     retire-idle / user-edited flag-only, zero actions on non-active
 *     statuses) and that shadow writes NOTHING;
 *   - apply executes transitions on a real StorageManager, is idempotent,
 *     bumps the run marker, and post-apply recall no longer injects
 *     archived procedures;
 *   - repair flag from real causal-trajectory records;
 *   - config parsing (string coercion, zero semantics, loud rejection);
 *   - the service gate returns { enabled: false } with maintenance off;
 *   - end-to-end: injected procedures reach LastRecallSnapshot.memoryIds
 *     and accrue mw_* via recordMemoryOutcome through the real recall path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { StorageManager } from "../storage.js";
import { parseConfig } from "../config.js";
import type { PluginConfig } from "../types.js";
import { Orchestrator } from "../orchestrator.js";
import { EngramAccessService } from "../access-service.js";
import { recordMemoryOutcome } from "../memory-worth-outcomes.js";
import { recordCausalTrajectory, type CausalTrajectoryRecord } from "../causal-trajectory.js";
import {
  runProcedureLibraryMaintenance,
  readProcedureMaintenanceMarker,
} from "./library-maintenance.js";
import { computeProcedureStats } from "./procedure-stats.js";
import {
  buildProcedurePersistBody,
  type ProcedureStep,
} from "./procedure-types.js";
import { buildProcedureRecallSection } from "./procedure-recall.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function maintenanceConfig(memoryDir?: string, overrides: Record<string, unknown> = {}): PluginConfig {
  return parseConfig({
    openaiApiKey: "sk-test",
    ...(memoryDir !== undefined ? { memoryDir } : {}),
    procedural: {
      enabled: true,
      lookbackDays: 14,
      maintenance: { enabled: true, ...overrides },
    },
  });
}

/** Raw procedure file with full frontmatter control (memory-worth test pattern). */
async function writeProcedure(
  storage: StorageManager,
  id: string,
  body: string,
  extraFrontmatter: string[] = [],
): Promise<string> {
  const baseDir = (storage as unknown as { baseDir: string }).baseDir;
  const dir = path.join(baseDir, "procedures");
  await mkdir(dir, { recursive: true });
  const lines = [
    "---",
    `id: ${id}`,
    "category: procedure",
    `created: ${new Date(NOW.getTime() - 30 * DAY_MS).toISOString()}`,
    `updated: ${new Date(NOW.getTime() - 30 * DAY_MS).toISOString()}`,
    "source: procedure-miner",
    "confidence: 0.8",
    "tags: []",
    ...extraFrontmatter,
    "---",
  ];
  const filePath = path.join(dir, `${id}.md`);
  await writeFile(filePath, `${lines.join("\n")}\n\n${body}\n`, "utf-8");
  return filePath;
}

function steps(): ProcedureStep[] {
  return [
    { order: 1, intent: "Check the deployment checklist", toolCall: { kind: "deploy_cli", signature: "deploy --check" } },
    { order: 2, intent: "Run the migration", toolCall: { kind: "migrate_cli", signature: "migrate --up" } },
  ];
}

function duplicateBody(updatedOffsetDays: number): string {
  const title = "When you work on goals like: ship the payment service safely";
  const body = buildProcedurePersistBody(title, steps());
  // buildProcedurePersistBody output is deterministic; embed the offset in
  // frontmatter instead of the body so the two dups stay signature-identical.
  void updatedOffsetDays;
  return body;
}

const NON_ACTIVE_STATUSES = [
  "pending_review",
  "rejected",
  "quarantined",
  "superseded",
  "archived",
] as const;

/** The canonical acceptance fixture: 2 dups + failing + idle + user-edited + every non-active status. */
async function seedFixture(storage: StorageManager): Promise<void> {
  await writeProcedure(storage, "proc-dup-a", duplicateBody(5), [
    `updated: ${new Date(NOW.getTime() - 5 * DAY_MS).toISOString()}`,
  ]);
  await writeProcedure(storage, "proc-dup-b", duplicateBody(1), [
    `updated: ${new Date(NOW.getTime() - 1 * DAY_MS).toISOString()}`,
  ]);
  await writeProcedure(
    storage,
    "proc-failing",
    buildProcedurePersistBody("When you work on goals like: rotate the database credentials", [
      { order: 1, intent: "Rotate credentials", toolCall: { kind: "rotate_cli", signature: "rotate --now" } },
      { order: 2, intent: "Verify the new credentials", toolCall: { kind: "verify_cli", signature: "verify --creds" } },
    ]),
    ["mw_success: 1", "mw_fail: 6"],
  );
  await writeProcedure(
    storage,
    "proc-idle",
    buildProcedurePersistBody("When you work on goals like: clean up the staging environment", [
      { order: 1, intent: "List staging resources", toolCall: { kind: "list_cli", signature: "list --env staging" } },
      { order: 2, intent: "Delete unused resources", toolCall: { kind: "delete_cli", signature: "delete --unused" } },
    ]),
    [
      `updated: ${new Date(NOW.getTime() - 100 * DAY_MS).toISOString()}`,
      `lastAccessed: ${new Date(NOW.getTime() - 100 * DAY_MS).toISOString()}`,
    ],
  );
  // User-edited: same mined shape but with hand-written guidance appended, and
  // failure-dominant counters that MUST be waived by the user-edited exemption.
  const editedBody =
    buildProcedurePersistBody("When you work on goals like: tune the cache thresholds", [
      { order: 1, intent: "Measure current hit rate", toolCall: { kind: "cache_cli", signature: "cache --stats" } },
      { order: 2, intent: "Raise the TTL", toolCall: { kind: "cache_cli", signature: "cache --ttl 600" } },
    ]) + "\nHand-written note: always page the on-call engineer first.\n";
  await writeProcedure(storage, "proc-user-edited", editedBody, ["mw_success: 1", "mw_fail: 6"]);
  // Non-active statuses share the dup cluster signature AND failure-dominant
  // counters — they must never become merge or retire candidates (§41).
  for (const [index, status] of NON_ACTIVE_STATUSES.entries()) {
    await writeProcedure(storage, `proc-${status}`, duplicateBody(0), [
      `status: ${status}`,
      `mw_success: 0`,
      `mw_fail: 9`,
      `updated: ${new Date(NOW.getTime() - index - 1).toISOString()}`,
    ]);
  }
}

test("shadow report proposes exactly one merge, two retires, one user-edited flag; non-active statuses never act", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-maint-shadow-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await seedFixture(storage);

    const report = await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: maintenanceConfig(),
      apply: false,
      now: NOW,
    });

    assert.equal(report.mode, "shadow");
    assert.equal(report.appliedCount, 0);
    const merges = report.proposed.filter((a) => a.action === "merge");
    const retires = report.proposed.filter((a) => a.action === "retire");
    const userEditedFlags = report.proposed.filter((a) => a.action === "flag_user_edited");
    assert.equal(merges.length, 1, `expected exactly one merge, got ${JSON.stringify(merges)}`);
    assert.deepEqual(merges[0]!.memoryIds, ["proc-dup-b", "proc-dup-a"], "most-recently-updated member is canonical");
    assert.equal(merges[0]!.canonicalId, "proc-dup-b");
    assert.deepEqual(
      retires.map((a) => a.reasonCode).sort(),
      ["retire_failure_dominant", "retire_idle"],
    );
    assert.deepEqual(retires.map((a) => a.memoryIds), [["proc-failing"], ["proc-idle"]]);
    assert.equal(userEditedFlags.length, 1);
    assert.equal(userEditedFlags[0]!.memoryIds[0], "proc-user-edited");
    for (const status of NON_ACTIVE_STATUSES) {
      const touching = report.proposed.filter((a) => a.memoryIds.includes(`proc-${status}`));
      assert.equal(touching.length, 0, `${status} procedure must never be a candidate`);
    }

    // Shadow writes NOTHING: statuses unchanged, no marker.
    const after = await storage.readAllMemories();
    assert.equal(after.filter((m) => m.frontmatter.status === "active").length, 5);
    assert.equal(await readProcedureMaintenanceMarker(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("apply executes transitions, stamps the #687 contract on the canonical, archives retires, is idempotent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-maint-apply-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await seedFixture(storage);

    const report = await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: maintenanceConfig(),
      apply: true,
      now: NOW,
    });
    assert.equal(report.mode, "apply");
    assert.ok(report.appliedCount > 0);

    const after = await storage.readAllMemories();
    const byId = new Map(after.map((m) => [m.frontmatter.id, m]));

    const dupA = byId.get("proc-dup-a")!;
    assert.equal(dupA.frontmatter.status, "superseded");
    assert.equal(dupA.frontmatter.supersededBy, "proc-dup-b");
    const canonical = byId.get("proc-dup-b")!;
    assert.equal(canonical.frontmatter.status, "active");
    assert.equal(canonical.frontmatter.reinforcement_count, 2);
    assert.equal(canonical.frontmatter.derived_via, "pattern-reinforcement");
    assert.deepEqual([...canonical.frontmatter.derived_from ?? []].sort(), ["proc-dup-a", "proc-dup-b"]);
    assert.ok(canonical.frontmatter.last_reinforced_at);

    // Retires demoted to archived (§: demotion, never deletion) — archived
    // files leave the live tree, so the ids no longer resolve via readAllMemories.
    assert.equal(byId.has("proc-failing"), false, "failure-dominant procedure archived");
    assert.equal(byId.has("proc-idle"), false, "idle procedure archived");
    const archived = await storage.readArchivedMemories();
    const archivedIds = new Set(archived.map((m) => m.frontmatter.id));
    assert.ok(archivedIds.has("proc-failing"));
    assert.ok(archivedIds.has("proc-idle"));

    // User-edited untouched by apply.
    const edited = byId.get("proc-user-edited")!;
    assert.equal(edited.frontmatter.status, "active");
    assert.equal(edited.frontmatter.structuredAttributes?.needsRepair, undefined);

    // Marker persisted; stats surface exposes it.
    const marker = await readProcedureMaintenanceMarker(dir);
    assert.ok(marker);
    assert.equal(marker!.lastApplyAt, NOW.toISOString());

    // Follow-up recall no longer injects the retired procedures.
    const section = await buildProcedureRecallSection(
      storage,
      "ship the payment service safely deployment checklist",
      maintenanceConfig(),
    );
    assert.ok(section);
    assert.match(section!, /proc-dup-b/);
    assert.doesNotMatch(section!, /proc-failing/);
    assert.doesNotMatch(section!, /proc-idle/);

    // Idempotent re-run: nothing left to propose.
    const second = await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: maintenanceConfig(),
      apply: true,
      now: NOW,
    });
    // The user-edited advisory flag is report-only (nothing written, nothing
    // to converge), so it MAY reappear; no write-capable action may.
    const writeActions = second.proposed.filter((a) => a.action !== "flag_user_edited");
    assert.equal(writeActions.length, 0, `expected a converged no-op, got ${JSON.stringify(writeActions)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function trajectory(trajectoryId: string, actionSummary: string): CausalTrajectoryRecord {
  return {
    schemaVersion: 1,
    trajectoryId,
    recordedAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
    sessionKey: "session-proc-maintenance",
    goal: "Keep procedures healthy",
    actionSummary,
    observationSummary: "The run produced reusable signal.",
    outcomeKind: "success",
    outcomeSummary: "Done.",
  };
}

test("repair flag: tools absent from recent trajectories get needsRepair; present tools do not", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-maint-repair-"));
  try {
    await recordCausalTrajectory({ memoryDir: dir, record: trajectory("traj-1", "Ran deploy_cli then tailed logs_cli output.") });

    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await writeProcedure(storage, "proc-stale", buildProcedurePersistBody("When you work on goals like: migrate the ledger", [
      { order: 1, intent: "Run the migration", toolCall: { kind: "ghost_tool", signature: "ghost --run" } },
      { order: 2, intent: "Verify row counts", toolCall: { kind: "verify_cli", signature: "verify --rows" } },
    ]));
    await writeProcedure(storage, "proc-fresh", buildProcedurePersistBody("When you work on goals like: deploy the service", [
      { order: 1, intent: "Run the deploy", toolCall: { kind: "deploy_cli", signature: "deploy --prod" } },
      { order: 2, intent: "Watch the logs", toolCall: { kind: "logs_cli", signature: "logs --follow" } },
    ]));

    const report = await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: maintenanceConfig(dir),
      apply: true,
      now: NOW,
    });
    const flags = report.proposed.filter((a) => a.action === "flag_repair");
    assert.equal(flags.length, 1, `expected exactly the stale-tool procedure, got ${JSON.stringify(flags)}`);
    assert.equal(flags[0]!.memoryIds[0], "proc-stale");
    assert.match(flags[0]!.reason, /ghost_tool/);

    const after = await storage.readAllMemories();
    const stale = after.find((m) => m.frontmatter.id === "proc-stale")!;
    const stamp = stale.frontmatter.structuredAttributes?.needsRepair;
    assert.ok(stamp, "needsRepair must be stamped in apply mode");
    const parsed = JSON.parse(stamp!) as { reason: string; detectedAt: string };
    assert.equal(parsed.detectedAt, NOW.toISOString());
    // Repair is flag-only: the body is never rewritten.
    assert.match(stale.content, /ghost_tool/);
    const fresh = after.find((m) => m.frontmatter.id === "proc-fresh")!;
    assert.equal(fresh.frontmatter.structuredAttributes?.needsRepair, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idle window uses [start, end): exactly-at-boundary is fresh, one ms older retires", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-maint-boundary-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const body = (n: string) =>
      buildProcedurePersistBody(`When you work on goals like: benchmark the ${n} pipeline`, [
        { order: 1, intent: `Measure ${n}` },
        { order: 2, intent: "Record the numbers" },
      ]);
    await writeProcedure(storage, "proc-at-boundary", body("alpha"), [
      `lastAccessed: ${new Date(NOW.getTime() - 90 * DAY_MS).toISOString()}`,
    ]);
    await writeProcedure(storage, "proc-just-older", body("beta"), [
      `lastAccessed: ${new Date(NOW.getTime() - 90 * DAY_MS - 1).toISOString()}`,
    ]);

    const report = await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: maintenanceConfig(),
      apply: false,
      now: NOW,
    });
    const idles = report.proposed.filter((a) => a.reasonCode === "retire_idle");
    assert.deepEqual(idles.map((a) => a.memoryIds), [["proc-just-older"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical comparator: equal updated timestamps fall back to stable id order (returns 0 only on full ties)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-maint-tie-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const sameTs = new Date(NOW.getTime() - 3 * DAY_MS).toISOString();
    await writeProcedure(storage, "proc-tie-b", duplicateBody(3), [`updated: ${sameTs}`]);
    await writeProcedure(storage, "proc-tie-a", duplicateBody(3), [`updated: ${sameTs}`]);

    const report = await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: maintenanceConfig(),
      apply: false,
      now: NOW,
    });
    const merge = report.proposed.find((a) => a.action === "merge")!;
    assert.ok(merge);
    assert.equal(merge.canonicalId, "proc-tie-a", "lexicographically smaller id wins the tie");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config: defaults, string coercion, zero semantics, loud rejection of invalid values", () => {
  const defaults = parseConfig({ procedural: { maintenance: { enabled: true } } }).procedural.maintenance;
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.retireIdleDays, 90);
  assert.equal(defaults.retireMinOutcomes, 5);
  assert.equal(defaults.retireFailRatio, 2);
  assert.equal(defaults.mergeEnabled, true);

  const off = parseConfig({}).procedural.maintenance;
  assert.equal(off.enabled, false, "maintenance defaults off");

  // CLI string forms (§17/§24).
  const strings = parseConfig({
    procedural: {
      maintenance: {
        enabled: "true",
        retireIdleDays: "30",
        retireMinOutcomes: "8",
        retireFailRatio: "3",
        mergeEnabled: "false",
      },
    },
  }).procedural.maintenance;
  assert.equal(strings.enabled, true);
  assert.equal(strings.retireIdleDays, 30);
  assert.equal(strings.retireMinOutcomes, 8);
  assert.equal(strings.retireFailRatio, 3);
  assert.equal(strings.mergeEnabled, false);

  // `0` disables idle-based retirement (§33 documented zero semantics).
  assert.equal(
    parseConfig({ procedural: { maintenance: { enabled: true, retireIdleDays: 0 } } }).procedural.maintenance.retireIdleDays,
    0,
  );

  assert.throws(() => parseConfig({ procedural: { maintenance: { retireIdleDays: "abc" } } }), /retireIdleDays/);
  assert.throws(() => parseConfig({ procedural: { maintenance: { retireMinOutcomes: 4.5 } } }), /integer/);
  assert.throws(() => parseConfig({ procedural: { maintenance: { retireFailRatio: 0 } } }), /positive/);
  assert.throws(() => parseConfig({ procedural: { maintenance: { enabled: "fales" } } }), /maintenance.enabled/);
  assert.throws(() => parseConfig({ procedural: { maintenance: "nope" } }), /must be an object/);
});

test("module gate: procedural.maintenance disabled returns skippedReason and proposes nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-maint-gate-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await writeProcedure(storage, "proc-gate", duplicateBody(1));

    const disabled = await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: maintenanceConfig(undefined, { enabled: false }),
      apply: true,
      now: NOW,
    });
    assert.equal(disabled.skippedReason, "maintenance_disabled");
    assert.equal(disabled.proposed.length, 0);
    assert.equal(await readProcedureMaintenanceMarker(dir), null, "disabled gate writes no marker");

    const proceduralOff = await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: parseConfig({ procedural: { enabled: false, maintenance: { enabled: true } } }),
      apply: true,
      now: NOW,
    });
    assert.equal(proceduralOff.skippedReason, "procedural_disabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service gate: maintenance off (including string \"false\"/\"0\") returns { enabled: false } before any storage read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-maint-service-"));
  try {
    for (const enabledValue of [false, "false", "0", "no", "off"]) {
      const config = parseConfig({
        openaiApiKey: "sk-test",
        memoryDir: dir,
        qmdEnabled: false,
        procedural: { enabled: true, maintenance: { enabled: enabledValue as boolean } },
      });
      const service = new EngramAccessService(new Orchestrator(config));
      const result = await service.procedureLibraryMaintenance({ apply: true });
      assert.deepEqual(result, { enabled: false }, `enabled=${JSON.stringify(enabledValue)} must gate off`);
      
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end-to-end: injected procedure reaches LastRecallSnapshot.memoryIds and accrues mw_fail via memory_outcome", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-maint-e2e-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      multiGraphMemoryEnabled: false,
      entityGraphEnabled: false,
      timeGraphEnabled: false,
      causalGraphEnabled: false,
      extractionJudgeEnabled: false,
      temporalSupersessionEnabled: false,
      contradictionDetectionEnabled: false,
      chunkingEnabled: false,
      extractionMinChars: 0,
      extractionMinImportanceLevel: "trivial",
      inlineSourceAttributionEnabled: false,
      initGateTimeoutMs: 200,
      procedural: { enabled: true, maintenance: { enabled: true } },
    });
    const orchestrator = new Orchestrator(config);
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const body = buildProcedurePersistBody(
      "When you work on goals like: deploy the payment service and run the database migration",
      steps(),
    );
    const baseDir = (storage as unknown as { baseDir: string }).baseDir;
    const proceduresDir = path.join(baseDir, "procedures");
    await mkdir(proceduresDir, { recursive: true });
    const id = "proc-e2e";
    const filePath = path.join(proceduresDir, `${id}.md`);
    const frontmatter = [
      "---",
      `id: ${id}`,
      "category: procedure",
      "status: active",
      `created: ${NOW.toISOString()}`,
      `updated: ${NOW.toISOString()}`,
      "source: procedure-miner",
      "confidence: 0.8",
      "tags: []",
      "---",
    ].join("\n");
    await writeFile(filePath, `${frontmatter}\n\n${body}\n`, "utf-8");

    const context = await orchestrator.recall(
      "I need to deploy the payment service and run the database migration",
      "sess-proc-maint-e2e",
    );
    assert.ok(typeof context === "string" && context.length > 0, "recall must return context");

    const snapshot = await orchestrator.getLastRecall("sess-proc-maint-e2e");
    assert.ok(snapshot, "snapshot must exist after recall");
    assert.ok(
      (snapshot!.memoryIds ?? []).includes(id),
      `procedure id must reach LastRecallSnapshot.memoryIds (got ${JSON.stringify(snapshot!.memoryIds)})`,
    );
    assert.ok(context!.includes(id), "procedure preview must be injected into the context");

    // The real outcome path (same function the memory_outcome op dispatches to).
    const outcome = await recordMemoryOutcome(storage, { memoryPath: filePath, outcome: "failure" });
    assert.ok(outcome.ok, `outcome must succeed on an eligible procedure (got ${JSON.stringify(outcome)})`);
    assert.equal(outcome.ok && outcome.mw_fail, 1);
    const after = await storage.getMemoryById(id);
    assert.ok(after);
    assert.equal(after!.frontmatter.mw_fail, 1);
    assert.equal(after!.frontmatter.mw_success, 0);
    await orchestrator.destroy();
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("stats surface exposes lastMaintenanceAt and needsRepairFlags", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-proc-maint-stats-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await writeProcedure(storage, "proc-stats", duplicateBody(1));
    const before = await computeProcedureStats({ storage, config: maintenanceConfig(), nowMs: NOW.getTime() });
    assert.equal(before.lastMaintenanceAt, null);
    assert.equal(before.needsRepairFlags, 0);

    await runProcedureLibraryMaintenance({
      storage,
      memoryDir: dir,
      config: maintenanceConfig(),
      apply: true,
      now: NOW,
    });
    const after = await computeProcedureStats({ storage, config: maintenanceConfig(), nowMs: NOW.getTime() });
    assert.equal(after.lastMaintenanceAt, NOW.toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
