/**
 * Procedure library health maintenance (issue #2370).
 *
 * The library-health loop the agent-memory survey describes: consume the
 * telemetry Remnic already records (Memory Worth counters, access
 * timestamps, causal trajectories) and propose merge / repair-flag /
 * retire transitions for ACTIVE procedure memories.
 *
 * Shadow-first contract (mirrors `memory_governance_run`): the default run
 * mode produces a JSON report and writes NOTHING — not even the run
 * marker. Applying requires `apply: true` AND
 * `procedural.maintenance.enabled: true`.
 *
 * Actions, evaluated in this order per run:
 *   1. Merge   — cluster active procedures by normalized trigger phrase +
 *                step signature; most-recently-updated member becomes the
 *                canonical, the rest are superseded pointing at it. The
 *                canonical is stamped with the issue-#687 frontmatter
 *                contract (`reinforcement_count`, `last_reinforced_at`,
 *                `derived_via`, `derived_from`) so `patterns explain` reads
 *                procedure canonicals unchanged. A user-edited body never
 *                merges — the cluster is flagged instead.
 *   2. Repair  — flag (never rewrite) procedures whose `ProcedureStep`
 *                toolCall tools no longer appear in recent causal
 *                trajectories, via `structuredAttributes.needsRepair`.
 *   3. Retire  — demote to `archived` when failure-dominant past the
 *                configured thresholds, or idle past `retireIdleDays` with
 *                zero recorded outcomes. Demotion, never deletion; page
 *                versioning snapshots every overwrite. User-edited
 *                procedures are exempt and flagged instead.
 *
 * Deliberately NOT part of `runMemoryGovernance` — same isolation decision
 * as procedure mining (docs/procedural-memory.md).
 */

import path from "node:path";
import type { MemoryFile, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { bumpMemoryCorpusVersionForDir } from "../memory-corpus-version.js";
import {
  buildProcedurePersistBody,
  parseProcedureStepsFromBody,
  type ProcedureStep,
} from "./procedure-types.js";
import {
  filterTrajectoriesByLookbackDays,
  readCausalTrajectoryRecords,
  type CausalTrajectoryRecord,
} from "../causal-trajectory.js";
import { readJsonFile, writeJsonFileAtomic } from "../json-store.js";
import { log } from "../logger.js";

const MAINTENANCE_ACTOR = "procedure-library-maintenance";
const MAINTENANCE_RULE_VERSION = "procedure-library-maintenance:1";

export type ProcedureMaintenanceActionKind =
  | "merge"
  | "retire"
  | "flag_repair"
  | "flag_user_edited";

export type ProcedureMaintenanceReasonCode =
  | "merge_duplicate_signature"
  | "retire_failure_dominant"
  | "retire_idle"
  | "needs_repair_stale_tools"
  | "user_edited_protected";

export interface ProcedureMaintenanceEvidence {
  memoryId: string;
  mwSuccess: number;
  mwFail: number;
  lastAccessed: string | null;
  updated: string | null;
}

export interface ProcedureMaintenanceAction {
  action: ProcedureMaintenanceActionKind;
  reasonCode: ProcedureMaintenanceReasonCode;
  /** Canonical first for merges; otherwise the single targeted memory. */
  memoryIds: string[];
  canonicalId?: string;
  reason: string;
  evidence: ProcedureMaintenanceEvidence[];
}

export interface ProcedureLibraryMaintenanceReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: "shadow" | "apply";
  scannedProcedures: number;
  proposed: ProcedureMaintenanceAction[];
  applied: ProcedureMaintenanceAction[];
  appliedCount: number;
  skippedReason?: "procedural_disabled" | "maintenance_disabled";
}

export interface ProcedureMaintenanceMarker {
  schemaVersion: 1;
  lastRunAt: string;
  lastApplyAt: string | null;
  appliedCount: number;
}

function maintenanceMarkerPath(memoryDir: string): string {
  return path.join(memoryDir, "state", "procedure-maintenance.json");
}

/** Read the last-run marker. Absent marker (or shadow-only history) → null apply timestamp. */
export async function readProcedureMaintenanceMarker(
  memoryDir: string,
): Promise<ProcedureMaintenanceMarker | null> {
  try {
    const raw = await readJsonFile(maintenanceMarkerPath(memoryDir));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.lastRunAt !== "string") return null;
    return {
      schemaVersion: 1,
      lastRunAt: m.lastRunAt,
      lastApplyAt: typeof m.lastApplyAt === "string" ? m.lastApplyAt : null,
      appliedCount: typeof m.appliedCount === "number" ? m.appliedCount : 0,
    };
  } catch {
    return null;
  }
}

function evidenceFor(m: MemoryFile): ProcedureMaintenanceEvidence {
  return {
    memoryId: m.frontmatter.id,
    mwSuccess: m.frontmatter.mw_success ?? 0,
    mwFail: m.frontmatter.mw_fail ?? 0,
    lastAccessed: m.frontmatter.lastAccessed ?? null,
    updated: m.frontmatter.updated ?? null,
  };
}

function tsMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Title line of a procedure body — everything before the first `## Step N` header. */
function procedureTitle(content: string): string {
  const text = content.replace(/\r\n/g, "\n").trim();
  const idx = text.search(/^##\s+Step\s+\d+\s*$/im);
  return (idx === -1 ? text : text.slice(0, idx)).trim();
}

function normalizePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Ordered (intent, tool) signature — the machine-mined shape of a procedure. */
function stepSignature(steps: ProcedureStep[] | null): string {
  if (steps === null) return "<unparsed>";
  return steps
    .map(
      (s) =>
        `${s.order}|${normalizePhrase(s.intent)}|${s.toolCall?.kind ?? ""}|${s.toolCall?.signature ?? ""}`,
    )
    .join(";;");
}

/**
 * A procedure is user-edited when its body no longer round-trips through the
 * miner's own serializer for its parsed steps — the stateless equivalent of
 * "body hash differs from last mined write". Freeform bodies with no step
 * headers count as user-authored.
 */
export function isUserEditedProcedure(content: string): boolean {
  const steps = parseProcedureStepsFromBody(content);
  if (steps === null) return true;
  const rebuilt = buildProcedurePersistBody(procedureTitle(content), steps);
  return rebuilt.trim() !== content.replace(/\r\n/g, "\n").trim();
}

/** Most-recently-updated wins; total comparator with stable id tiebreak (§12). */
function compareCanonical(a: MemoryFile, b: MemoryFile): number {
  const aMs = tsMs(a.frontmatter.updated) ?? tsMs(a.frontmatter.created) ?? 0;
  const bMs = tsMs(b.frontmatter.updated) ?? tsMs(b.frontmatter.created) ?? 0;
  if (aMs !== bMs) return aMs > bMs ? -1 : 1;
  const aId = a.frontmatter.id ?? "";
  const bId = b.frontmatter.id ?? "";
  if (aId !== bId) return aId < bId ? -1 : 1;
  return 0;
}

function recentTrajectoryToolText(
  trajectories: readonly CausalTrajectoryRecord[],
): string {
  return trajectories.map((r) => r.actionSummary).join("\n").toLowerCase();
}

/**
 * Run one library-health maintenance pass over the procedures in a storage.
 * Shadow mode performs NO writes (not even the state marker).
 */
export async function runProcedureLibraryMaintenance(options: {
  storage: StorageManager;
  memoryDir: string;
  config: PluginConfig;
  apply?: boolean;
  now?: Date;
}): Promise<ProcedureLibraryMaintenanceReport> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const mode: "shadow" | "apply" = options.apply === true ? "apply" : "shadow";
  const cfg = options.config.procedural;
  if (cfg?.enabled !== true || cfg.maintenance?.enabled !== true) {
    return {
      schemaVersion: 1,
      generatedAt: nowIso,
      mode,
      scannedProcedures: 0,
      proposed: [],
      applied: [],
      appliedCount: 0,
      skippedReason: cfg?.enabled !== true ? "procedural_disabled" : "maintenance_disabled",
    };
  }
  const maintenance = cfg.maintenance;

  const all = await options.storage.readAllMemories();
  const byId = new Map<string, MemoryFile>();
  for (const m of all) {
    if (m.frontmatter.category !== "procedure") continue;
    // Only ACTIVE procedures are maintenance candidates. pending_review,
    // rejected, quarantined, superseded, and archived are never merge or
    // retire candidates (§41) — archived files live outside readAllMemories
    // entirely.
    if (!isActiveMemoryStatus(m.frontmatter.status)) continue;
    if (typeof m.frontmatter.id === "string" && m.frontmatter.id.length > 0) {
      byId.set(m.frontmatter.id, m);
    }
  }
  const activeProcedures = [...byId.values()];

  const report: ProcedureLibraryMaintenanceReport = {
    schemaVersion: 1,
    generatedAt: nowIso,
    mode,
    scannedProcedures: activeProcedures.length,
    proposed: [],
    applied: [],
    appliedCount: 0,
  };
  // Empty library: nothing to propose. Shadow returns immediately; an apply
  // run still falls through so the run marker records the pass.
  if (activeProcedures.length === 0 && mode === "shadow") return report;


  // --- 1. Merge -------------------------------------------------------------
  const mergeConsumed = new Set<string>();
  if (maintenance.mergeEnabled) {
    const clusters = new Map<string, MemoryFile[]>();
    for (const m of activeProcedures) {
      const steps = parseProcedureStepsFromBody(m.content);
      const key = `${normalizePhrase(procedureTitle(m.content))}\n@@\n${stepSignature(steps)}`;
      const bucket = clusters.get(key);
      if (bucket) bucket.push(m);
      else clusters.set(key, [m]);
    }
    for (const cluster of clusters.values()) {
      if (cluster.length < 2) continue;
      const sortedCluster = [...cluster].sort(compareCanonical);
      const userEdited = sortedCluster.filter((m) => isUserEditedProcedure(m.content));
      if (userEdited.length > 0) {
        report.proposed.push({
          action: "flag_user_edited",
          reasonCode: "user_edited_protected",
          memoryIds: sortedCluster.map((m) => m.frontmatter.id),
          reason:
            "duplicate-signature cluster contains user-edited bodies; merge skipped for manual review",
          evidence: sortedCluster.map(evidenceFor),
        });
        continue;
      }
      const canonical = sortedCluster[0]!;
      const duplicates = sortedCluster.slice(1);
      for (const m of sortedCluster) mergeConsumed.add(m.frontmatter.id);
      report.proposed.push({
        action: "merge",
        reasonCode: "merge_duplicate_signature",
        memoryIds: [canonical.frontmatter.id, ...duplicates.map((m) => m.frontmatter.id)],
        canonicalId: canonical.frontmatter.id,
        reason: `near-identical trigger phrase + step signature across ${sortedCluster.length} active procedures`,
        evidence: sortedCluster.map(evidenceFor),
      });
    }
  }

  // --- 2. Repair flag -------------------------------------------------------
  // Only meaningful when the lookback window holds trajectory evidence: an
  // empty window proves nothing about tool freshness.
  const trajectoryDir =
    typeof options.config.causalTrajectoryStoreDir === "string" &&
    options.config.causalTrajectoryStoreDir.trim().length > 0
      ? options.config.causalTrajectoryStoreDir.trim()
      : undefined;
  const { trajectories } = await readCausalTrajectoryRecords({
    memoryDir: options.memoryDir,
    causalTrajectoryStoreDir: trajectoryDir,
  });
  const recentTrajectories = filterTrajectoriesByLookbackDays(
    trajectories,
    cfg.lookbackDays,
    now.getTime(),
  );
  const repairFlags: ProcedureMaintenanceAction[] = [];
  const staleToolsByProcedure = new Map<string, string[]>();
  if (recentTrajectories.length > 0) {
    const toolText = recentTrajectoryToolText(recentTrajectories);
    for (const m of activeProcedures) {
      if (mergeConsumed.has(m.frontmatter.id)) continue;
      const steps = parseProcedureStepsFromBody(m.content);
      if (steps === null) continue;
      const tools = [
        ...new Set(
          steps
            .map((s) => s.toolCall?.kind)
            .filter((t): t is string => typeof t === "string" && t.length > 0),
        ),
      ];
      if (tools.length === 0) continue;
      const stale = tools.filter((t) => !toolText.includes(t.toLowerCase()));
      if (stale.length === 0) continue;
      staleToolsByProcedure.set(m.frontmatter.id, stale);
      repairFlags.push({
        action: "flag_repair",
        reasonCode: "needs_repair_stale_tools",
        memoryIds: [m.frontmatter.id],
        reason: `tools absent from last ${cfg.lookbackDays}d of trajectories: ${stale.join(", ")}`,
        evidence: [evidenceFor(m)],
      });
    }
  }

  // --- 3. Retire ------------------------------------------------------------
  const retireActions: ProcedureMaintenanceAction[] = [];
  const retireIds = new Set<string>();
  const idleMs = maintenance.retireIdleDays * 24 * 60 * 60 * 1000;
  for (const m of activeProcedures) {
    if (mergeConsumed.has(m.frontmatter.id)) continue;
    const mwSuccess = m.frontmatter.mw_success ?? 0;
    const mwFail = m.frontmatter.mw_fail ?? 0;
    const failureDominant =
      mwFail >= maintenance.retireMinOutcomes &&
      mwFail > mwSuccess * maintenance.retireFailRatio;
    // Half-open idle window (§23): fresh means last signal in
    // [now - idleMs, now); idle means strictly older than the window start.
    const lastSignalMs =
      tsMs(m.frontmatter.lastAccessed) ?? tsMs(m.frontmatter.updated);
    const idle =
      maintenance.retireIdleDays > 0 &&
      mwSuccess + mwFail === 0 &&
      lastSignalMs !== null &&
      lastSignalMs < now.getTime() - idleMs;
    const reasonCode: ProcedureMaintenanceReasonCode | null = failureDominant
      ? "retire_failure_dominant"
      : idle
        ? "retire_idle"
        : null;
    if (reasonCode === null) continue;
    retireIds.add(m.frontmatter.id);
    if (isUserEditedProcedure(m.content)) {
      report.proposed.push({
        action: "flag_user_edited",
        reasonCode: "user_edited_protected",
        memoryIds: [m.frontmatter.id],
        reason: `user-edited body exempt from automatic retirement (${reasonCode} waived)`,
        evidence: [evidenceFor(m)],
      });
      continue;
    }
    retireActions.push({
      action: "retire",
      reasonCode,
      memoryIds: [m.frontmatter.id],
      reason:
        reasonCode === "retire_failure_dominant"
          ? `mw_fail ${mwFail} >= ${maintenance.retireMinOutcomes} and > mw_success ${mwSuccess} * ${maintenance.retireFailRatio}`
          : `no access signal for ${maintenance.retireIdleDays}d and zero recorded outcomes`,
      evidence: [evidenceFor(m)],
    });
  }

  // Repair flags after merge/retire exclusions land in the report in
  // evaluation order (merge → repair → retire).
  for (const flag of repairFlags) {
    if (retireIds.has(flag.memoryIds[0]!)) continue;
    report.proposed.push(flag);
  }
  report.proposed.push(...retireActions);

  if (mode === "shadow") return report;

  // --- Apply ----------------------------------------------------------------
  const applied = report.proposed;
  let writes = 0;
  for (const action of applied) {
    try {
      if (action.action === "merge") {
        const canonicalId = action.canonicalId;
        const canonical = canonicalId !== undefined ? byId.get(canonicalId) : undefined;
        if (!canonical || canonicalId === undefined) continue;
        const memberIds = [...action.memoryIds].sort();
        const previousCount = canonical.frontmatter.reinforcement_count ?? 0;
        const newCount = Math.max(previousCount, memberIds.length);
        if (
          newCount !== canonical.frontmatter.reinforcement_count ||
          canonical.frontmatter.derived_via !== "pattern-reinforcement"
        ) {
          await options.storage.writeMemoryFrontmatter(
            canonical,
            {
              reinforcement_count: newCount,
              last_reinforced_at: nowIso,
              derived_via: "pattern-reinforcement",
              derived_from: memberIds,
              updated: nowIso,
            },
            {
              actor: MAINTENANCE_ACTOR,
              reasonCode: action.reasonCode,
              ruleVersion: MAINTENANCE_RULE_VERSION,
              relatedMemoryIds: memberIds,
            },
          );
          writes += 1;
        }
        for (const memberId of action.memoryIds) {
          if (memberId === canonicalId) continue;
          const member = byId.get(memberId);
          if (!member) continue;
          await options.storage.writeMemoryFrontmatter(
            member,
            {
              status: "superseded",
              supersededBy: canonicalId,
              supersededAt: nowIso,
              updated: nowIso,
            },
            {
              actor: MAINTENANCE_ACTOR,
              reasonCode: action.reasonCode,
              ruleVersion: MAINTENANCE_RULE_VERSION,
              relatedMemoryIds: [canonicalId],
            },
          );
          writes += 1;
        }
      } else if (action.action === "retire") {
        const memory = byId.get(action.memoryIds[0]!);
        if (!memory) continue;
        const archivedPath = await options.storage.archiveMemory(memory, {
          at: now,
          actor: `${MAINTENANCE_ACTOR}.apply`,
          reasonCode: action.reasonCode,
          ruleVersion: MAINTENANCE_RULE_VERSION,
          relatedMemoryIds: [],
        });
        if (archivedPath !== null) writes += 1;
      } else if (action.action === "flag_repair") {
        const memory = byId.get(action.memoryIds[0]!);
        if (!memory) continue;
        const existing = memory.frontmatter.structuredAttributes ?? {};
        const stamp = JSON.stringify({ reason: action.reason, detectedAt: nowIso });
        if (existing.needsRepair === stamp) continue;
        await options.storage.writeMemoryFrontmatter(
          memory,
          {
            structuredAttributes: { ...existing, needsRepair: stamp },
            updated: nowIso,
          },
          {
            actor: MAINTENANCE_ACTOR,
            reasonCode: action.reasonCode,
            ruleVersion: MAINTENANCE_RULE_VERSION,
          },
        );
        writes += 1;
      }
      // flag_user_edited writes nothing — flags are report-only by design.
      report.applied.push(action);
    } catch (err) {
      log.warn(
        `procedure-library-maintenance: action ${action.reasonCode} on ${action.memoryIds.join(",")} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  report.appliedCount = report.applied.length;

  if (writes > 0) {
    // Out-of-band corpus bump + marker so hot caches and the stats surface
    // observe the pass (§25/§31 — direct writes must not leave stale views).
    bumpMemoryCorpusVersionForDir(options.memoryDir);
  }
  try {
    await writeJsonFileAtomic(maintenanceMarkerPath(options.memoryDir), {
      schemaVersion: 1,
      lastRunAt: nowIso,
      lastApplyAt: nowIso,
      appliedCount: report.appliedCount,
    } satisfies ProcedureMaintenanceMarker);
  } catch (err) {
    log.warn(
      `procedure-library-maintenance: failed to persist run marker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return report;
}
