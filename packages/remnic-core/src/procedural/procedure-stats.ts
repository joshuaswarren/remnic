/**
 * Procedural memory stats surface (issue #567 PR 5/5).
 *
 * Pure helper that tallies procedure memories by status and summarizes the
 * current `procedural.*` config so operators (and the dashboard) can see,
 * in one call, how procedural memory is behaving in a namespace.
 *
 * Consumed by:
 *   - CLI `remnic procedural stats`
 *   - HTTP `GET /engram/v1/procedural/stats`
 *   - MCP `remnic.procedural_stats` (+ `engram.procedural_stats` alias)
 */
import type { MemoryFile, MemoryStatus, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { readProcedureMaintenanceMarker } from "./library-maintenance.js";

export interface ProcedureStatusCounts {
  total: number;
  active: number;
  pending_review: number;
  rejected: number;
  quarantined: number;
  superseded: number;
  archived: number;
  /** Any status the enum doesn't yet cover. */
  other: number;
}

export interface ProcedureStatsConfigSnapshot {
  enabled: boolean;
  minOccurrences: number;
  successFloor: number;
  autoPromoteOccurrences: number;
  autoPromoteEnabled: boolean;
  lookbackDays: number;
  recallMaxProcedures: number;
}

export interface ProcedureStatsRecent {
  /** ISO 8601 timestamp of the most recent procedure write, or null. */
  lastWriteAt: string | null;
  /** Count of procedure files with `created` (or `updated`) in the last 7 days. */
  writesLast7Days: number;
  /** Count of procedures whose `source` is the procedure miner. */
  minerSourced: number;
}

export interface ProcedureStatsReport {
  schemaVersion: 1;
  generatedAt: string;
  counts: ProcedureStatusCounts;
  recent: ProcedureStatsRecent;
  config: ProcedureStatsConfigSnapshot;
  /** ISO timestamp of the last library-maintenance run marker, or null (issue #2370). */
  lastMaintenanceAt: string | null;
  /** Active procedures currently carrying a `needsRepair` flag (issue #2370). */
  needsRepairFlags: number;
}

function snapshotConfig(config: PluginConfig): ProcedureStatsConfigSnapshot {
  const p = config.procedural;
  return {
    enabled: p?.enabled === true,
    minOccurrences: typeof p?.minOccurrences === "number" ? p.minOccurrences : 0,
    successFloor: typeof p?.successFloor === "number" ? p.successFloor : 0,
    autoPromoteOccurrences:
      typeof p?.autoPromoteOccurrences === "number"
        ? p.autoPromoteOccurrences
        : 0,
    autoPromoteEnabled: p?.autoPromoteEnabled === true,
    lookbackDays: typeof p?.lookbackDays === "number" ? p.lookbackDays : 0,
    recallMaxProcedures:
      typeof p?.recallMaxProcedures === "number" ? p.recallMaxProcedures : 0,
  };
}

function tsMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read all memories from storage and tally procedures by status + recency.
 * `nowMs` is injectable so tests can pin the "last 7 days" window.
 */
export async function computeProcedureStats(options: {
  storage: StorageManager;
  config: PluginConfig;
  nowMs?: number;
}): Promise<ProcedureStatsReport> {
  const { storage, config } = options;
  const nowMs = options.nowMs ?? Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  const counts: ProcedureStatusCounts = {
    total: 0,
    active: 0,
    pending_review: 0,
    rejected: 0,
    quarantined: 0,
    superseded: 0,
    archived: 0,
    other: 0,
  };

  let lastWriteMs: number | null = null;
  let writesLast7Days = 0;
  let minerSourced = 0;
  let needsRepairFlags = 0;

  const known: MemoryStatus[] = [
    "active",
    "pending_review",
    "rejected",
    "quarantined",
    "superseded",
    "archived",
  ];

  // Iterate both live and archived memories so the counts surface matches
  // what operators expect when procedures have been archived via
  // `archiveMemory` (Codex P2 on #611). `readAllMemories` alone skips
  // `archive/`, which would otherwise underreport `counts.archived` and
  // `counts.total`.
  const seen = new Set<string>();
  const live = await storage.readAllMemories();
  const archived = await storage.readArchivedMemories();
  const pool: MemoryFile[] = [...live, ...archived];
  for (const m of pool) {
    if (m.frontmatter.category !== "procedure") continue;
    // Dedupe by id so a procedure appearing in both live + archive (mid-
    // archive race) isn't counted twice.
    if (seen.has(m.frontmatter.id)) continue;
    seen.add(m.frontmatter.id);
    counts.total += 1;
    const status = m.frontmatter.status ?? "active";
    if ((known as string[]).includes(status)) {
      // Safe index: the status enum values are the counts keys.
      (counts as unknown as Record<string, number>)[status] += 1;
    } else {
      counts.other += 1;
    }

    // Recency semantics (Codex P2 on #611): use the latest of `updated` and
    // `created`, not a fallback chain, so recently-edited procedures are
    // reflected in `lastWriteAt` and `writesLast7Days`. Missing timestamps
    // skip the row.
    const createdMs = tsMs(m.frontmatter.created);
    const updatedMs = tsMs(m.frontmatter.updated);
    const latestMs =
      createdMs !== null && updatedMs !== null
        ? Math.max(createdMs, updatedMs)
        : (updatedMs ?? createdMs);
    if (latestMs !== null) {
      if (lastWriteMs === null || latestMs > lastWriteMs) {
        lastWriteMs = latestMs;
      }
      // Exclusive upper bound per CLAUDE.md rule 35 — use half-open window.
      if (latestMs >= nowMs - sevenDaysMs && latestMs < nowMs) {
        writesLast7Days += 1;
      }
    }

    if (m.frontmatter.source === "procedure-miner") {
      minerSourced += 1;
    }
    if (
      m.frontmatter.structuredAttributes?.needsRepair !== undefined &&
      isActiveMemoryStatus(m.frontmatter.status)
    ) {
      needsRepairFlags += 1;
    }
  }

  const maintenanceMarker = await readProcedureMaintenanceMarker(storage.dir);
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    counts,
    recent: {
      lastWriteAt: lastWriteMs !== null ? new Date(lastWriteMs).toISOString() : null,
      writesLast7Days,
      minerSourced,
    },
    config: snapshotConfig(config),
    lastMaintenanceAt: maintenanceMarker?.lastRunAt ?? null,
    needsRepairFlags,
  };
}

/**
 * Render `ProcedureStatsReport` as a human-friendly plain-text block for CLI
 * operators. Keep it deterministic — no colors, no ANSI. Used by `--format text`.
 */
export function formatProcedureStatsText(report: ProcedureStatsReport): string {
  const { counts, recent, config } = report;
  const { autoPromoteEnabled } = config;
  const lines: string[] = [];
  lines.push(`Procedural memory stats (schema v${report.schemaVersion})`);
  lines.push(`  generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(`  config:`);
  lines.push(`    enabled:                 ${config.enabled}`);
  lines.push(`    minOccurrences:          ${config.minOccurrences}`);
  lines.push(`    successFloor:            ${config.successFloor}`);
  lines.push(`    autoPromoteOccurrences:  ${config.autoPromoteOccurrences}`);
  lines.push(`    autoPromoteEnabled:      ${autoPromoteEnabled}`);
  lines.push(`    lookbackDays:            ${config.lookbackDays}`);
  lines.push(`    recallMaxProcedures:     ${config.recallMaxProcedures}`);
  lines.push("");
  lines.push(`  counts:`);
  lines.push(`    total:           ${counts.total}`);
  lines.push(`    active:          ${counts.active}`);
  lines.push(`    pending_review:  ${counts.pending_review}`);
  lines.push(`    rejected:        ${counts.rejected}`);
  lines.push(`    quarantined:     ${counts.quarantined}`);
  lines.push(`    superseded:      ${counts.superseded}`);
  lines.push(`    archived:        ${counts.archived}`);
  if (counts.other > 0) {
    lines.push(`    other:           ${counts.other}`);
  }
  lines.push("");
  lines.push(`  recent:`);
  lines.push(`    lastWriteAt:      ${recent.lastWriteAt ?? "(none)"}`);
  lines.push(`    writesLast7Days:  ${recent.writesLast7Days}`);
  lines.push(`    minerSourced:     ${recent.minerSourced}`);
  lines.push("");
  lines.push(`  maintenance:`);
  lines.push(`    lastMaintenanceAt: ${report.lastMaintenanceAt ?? "(never)"}`);
  lines.push(`    needsRepairFlags:  ${report.needsRepairFlags}`);
  return lines.join("\n") + "\n";
}
