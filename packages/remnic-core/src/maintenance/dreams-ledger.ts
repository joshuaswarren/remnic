/**
 * dreams-ledger.ts — per-phase telemetry for the Dreams consolidation pipeline.
 *
 * Every scheduled or manual phase run appends one JSONL entry to
 *   <memoryDir>/state/dreams-ledger.jsonl
 *
 * The entry records which phase ran, how long it took, and a small
 * itemsProcessed counter so `remnic dreams status` can aggregate the last
 * 24-hour window without scanning the full memory corpus.
 *
 * This module is intentionally side-effect-free on import (no fs calls at
 * module load time) so tests can import it without touching the filesystem.
 */

import path from "node:path";
import { appendFile, lstat, mkdir, readdir, readFile } from "node:fs/promises";

// ── Types ─────────────────────────────────────────────────────────────────────

/** The three named phases of the Dreams consolidation pipeline. */
export type DreamsPhase = "lightSleep" | "rem" | "deepSleep";

/**
 * One entry written to the dreams ledger for every phase run.
 * Older entries that predate this field simply won't have it (no backfill).
 */
export interface DreamsLedgerEntry {
  /** Schema version — always 1 for entries written by this module. */
  schemaVersion: 1;
  /** ISO-8601 timestamp when the phase run started. */
  startedAt: string;
  /** ISO-8601 timestamp when the phase run completed. */
  completedAt: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /**
   * Which Dreams phase this entry represents.
   * - `lightSleep` — recent activity scoring + clustering
   * - `rem`        — cross-session synthesis, supersession, consolidation
   * - `deepSleep`  — tier migration, page-version snapshots, archive
   */
  phase: DreamsPhase;
  /** How many memory items were evaluated (scored / clustered / migrated). */
  itemsProcessed: number;
  /** Whether this was a dry-run (no writes committed). */
  dryRun: boolean;
  /**
   * How the phase was triggered.
   * - `scheduled` — invoked by the governance cron or orchestrator maintenance pass
   * - `manual`    — invoked via `remnic dreams run`
   */
  trigger: "scheduled" | "manual";
  /** Free-form notes for debugging (optional, never required). */
  notes?: string;
}

/** Aggregated stats for a single phase over a time window. */
export interface DreamsPhaseStatus {
  phase: DreamsPhase;
  /** Number of phase runs in the window. */
  runCount: number;
  /** Total wall-clock milliseconds across all runs in the window. */
  totalDurationMs: number;
  /** Total items processed across all runs in the window. */
  totalItemsProcessed: number;
  /** ISO-8601 timestamp of the most recent completed run, or null if none. */
  lastRunAt: string | null;
  /** Duration of the most recent run in ms, or null if none. */
  lastDurationMs: number | null;
}

/** Shape returned by `getDreamsStatus` — the canonical telemetry response. */
export interface DreamsStatusResult {
  /** ISO-8601 start of the query window (inclusive). */
  windowStart: string;
  /** ISO-8601 end of the query window (exclusive). */
  windowEnd: string;
  /** Per-phase summaries, always present for all three phases. */
  phases: {
    lightSleep: DreamsPhaseStatus;
    rem: DreamsPhaseStatus;
    deepSleep: DreamsPhaseStatus;
  };
}

// ── Path helpers ──────────────────────────────────────────────────────────────

export function dreamsLedgerPath(memoryDir: string): string {
  return path.join(memoryDir, "state", "dreams-ledger.jsonl");
}

// ── Writer ────────────────────────────────────────────────────────────────────

/**
 * Append a single entry to the dreams ledger.
 * Creates the file (and its parent directory) if needed.
 * Uses `appendFile` (O_APPEND) so concurrent callers never overwrite each other.
 */
export async function appendDreamsLedgerEntry(
  memoryDir: string,
  entry: DreamsLedgerEntry,
): Promise<void> {
  const ledgerPath = dreamsLedgerPath(memoryDir);
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, JSON.stringify(entry) + "\n", "utf-8");
}

// ── Reader ────────────────────────────────────────────────────────────────────

/**
 * Parse all valid `DreamsLedgerEntry` rows from the ledger file.
 * Malformed lines are silently skipped (resilience over strictness for telemetry).
 */
export async function readDreamsLedgerEntries(memoryDir: string): Promise<DreamsLedgerEntry[]> {
  const ledgerPath = dreamsLedgerPath(memoryDir);
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const entries: DreamsLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<DreamsLedgerEntry>;
      if (typeof parsed !== "object" || parsed === null) continue;
      if (
        typeof parsed.phase === "string" &&
        (parsed.phase === "lightSleep" || parsed.phase === "rem" || parsed.phase === "deepSleep") &&
        typeof parsed.startedAt === "string" &&
        typeof parsed.completedAt === "string" &&
        typeof parsed.durationMs === "number" &&
        typeof parsed.itemsProcessed === "number"
      ) {
        entries.push({
          schemaVersion: 1,
          startedAt: parsed.startedAt,
          completedAt: parsed.completedAt,
          durationMs: parsed.durationMs,
          phase: parsed.phase,
          itemsProcessed: parsed.itemsProcessed,
          dryRun: parsed.dryRun === true,
          trigger: parsed.trigger === "manual" ? "manual" : "scheduled",
          notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
        });
      }
    } catch {
      // Malformed line — skip.
    }
  }
  return entries;
}

// ── Aggregator ────────────────────────────────────────────────────────────────

const ALL_PHASES: DreamsPhase[] = ["lightSleep", "rem", "deepSleep"];
const MAX_WINDOW_HOURS = 24 * 365 * 100;

export function normalizeDreamsStatusWindowHours(value: unknown, fallback = 24): number {
  const raw = value === undefined || value === null ? fallback : value;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > MAX_WINDOW_HOURS
  ) {
    throw new RangeError(`windowHours must be a positive integer no greater than ${MAX_WINDOW_HOURS}`);
  }
  return raw;
}

/**
 * Build per-phase 24-hour summary.
 *
 * @param memoryDir   The memory directory (parent of `state/`).
 * @param windowHours How many hours to look back (default 24).
 * @param now         Reference time (default `new Date()`).
 */
export async function getDreamsStatus(
  memoryDir: string,
  windowHours = 24,
  now: Date = new Date(),
): Promise<DreamsStatusResult> {
  const boundedWindowHours = normalizeDreamsStatusWindowHours(windowHours);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("now must be a valid Date");
  }
  const windowMs = boundedWindowHours * 60 * 60 * 1000;
  const windowStart = new Date(nowMs - windowMs);
  const windowEnd = now;
  if (!Number.isFinite(windowStart.getTime())) {
    throw new RangeError("windowHours produces an invalid status window");
  }

  const entries = await readDreamsLedgerEntries(memoryDir);

  // Filter to entries within the window based on completedAt.
  const windowEntries = entries.filter((e) => {
    const ts = Date.parse(e.completedAt);
    return Number.isFinite(ts) && ts >= windowStart.getTime() && ts < windowEnd.getTime();
  });

  const statusMap = new Map<DreamsPhase, DreamsPhaseStatus>();
  for (const phase of ALL_PHASES) {
    statusMap.set(phase, {
      phase,
      runCount: 0,
      totalDurationMs: 0,
      totalItemsProcessed: 0,
      lastRunAt: null,
      lastDurationMs: null,
    });
  }

  for (const entry of windowEntries) {
    const status = statusMap.get(entry.phase);
    if (!status) continue;
    status.runCount += 1;
    status.totalDurationMs += entry.durationMs;
    status.totalItemsProcessed += entry.itemsProcessed;

    // Track the most recent run (by completedAt).
    if (
      status.lastRunAt === null ||
      Date.parse(entry.completedAt) > Date.parse(status.lastRunAt)
    ) {
      status.lastRunAt = entry.completedAt;
      status.lastDurationMs = entry.durationMs;
    }
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    phases: {
      lightSleep: statusMap.get("lightSleep")!,
      rem: statusMap.get("rem")!,
      deepSleep: statusMap.get("deepSleep")!,
    },
  };
}

// ── Phase runner (PR 4/4: manual invocation) ─────────────────────────────────

export interface DreamsRunOptions {
  memoryDir: string;
  phase: DreamsPhase;
  dryRun?: boolean;
}

/** Public result shape — identical to what HTTP, MCP, and CLI surfaces expose. */
export interface DreamsRunResult {
  phase: DreamsPhase;
  dryRun: boolean;
  durationMs: number;
  itemsProcessed: number;
  notes?: string;
}

/** Internal result shape returned by `runDreamsPhase` — includes the raw ledger entry. */
export interface DreamsRunResultInternal extends DreamsRunResult {
  ledgerEntry?: DreamsLedgerEntry;
}

export async function recordDreamsPhaseRun(options: {
  memoryDir: string;
  phase: DreamsPhase;
  trigger: DreamsLedgerEntry["trigger"];
  dryRun?: boolean;
  itemsProcessed: number;
  notes?: string;
  startedAt?: string;
  completedAt?: string;
}): Promise<DreamsLedgerEntry> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const completedAt = options.completedAt ?? new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  const ledgerEntry: DreamsLedgerEntry = {
    schemaVersion: 1,
    startedAt,
    completedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    phase: options.phase,
    itemsProcessed: Math.max(0, Math.floor(options.itemsProcessed)),
    dryRun: options.dryRun === true,
    trigger: options.trigger,
    notes: options.notes,
  };
  if (!ledgerEntry.dryRun) {
    await appendDreamsLedgerEntry(options.memoryDir, ledgerEntry);
  }
  return ledgerEntry;
}

/**
 * Manually invoke a single Dreams phase pass.
 *
 * For light sleep and REM: runs a lightweight scan against the observation
 * ledger and returns a count of items that would be (or were, if not dry-run)
 * processed.  The actual heavy consolidation is long-running and orchestrator-
 * bound; the manual surface delegates to existing ledger utilities and returns
 * the phase telemetry so callers get the same shape as a scheduled run.
 *
 * For deep sleep: delegates to the memory governance run (shadow mode when
 * dryRun is true, apply mode otherwise).
 */
export async function runDreamsPhase(
  options: DreamsRunOptions,
  governanceRunner?: (opts: { memoryDir: string; dryRun: boolean }) => Promise<{ scannedMemories: number; appliedActionCount: number; notes?: string }>,
  phaseRunner?: (opts: { memoryDir: string; phase: Exclude<DreamsPhase, "deepSleep"> }) => Promise<{ itemsProcessed: number; notes?: string }>,
): Promise<DreamsRunResultInternal> {
  const { memoryDir, phase, dryRun = false } = options;
  const startedAt = new Date().toISOString();

  let itemsProcessed = 0;
  let notes: string | undefined;

  if (phase === "lightSleep") {
    // Dry-run light sleep counts recent observation entries as a preview.
    // Live runs must be backed by the orchestrator phase runner so the command
    // never reports success without executing the phase.
    if (!dryRun) {
      if (!phaseRunner) {
        throw new Error("light-sleep manual runs require a phase runner");
      }
      const result = await phaseRunner({ memoryDir, phase });
      itemsProcessed = Math.max(0, Math.floor(result.itemsProcessed));
      notes = result.notes ?? `scored ${itemsProcessed} memories`;
    } else {
      // Light sleep: count observation ledger entries from the last 24h as a
      // proxy for "items scored". The live value-scoring pass runs through the
      // phase runner above.
      try {
        const ledgerPath = path.join(memoryDir, "state", "observation-ledger", "rebuilt-observations.jsonl");
        let raw = "";
        try {
          raw = await readFile(ledgerPath, "utf-8");
        } catch {
          // No ledger yet — zero items.
        }
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const nowMs = Date.now();
        const cutoff = nowMs - 24 * 60 * 60 * 1000;
        itemsProcessed = lines.filter((line) => {
          try {
            const obj = JSON.parse(line) as {
              hour?: string;
              timestamp?: string;
              ts?: string;
            };
            const timestamp = typeof obj.hour === "string"
              ? obj.hour
              : typeof obj.ts === "string"
                ? obj.ts
                : typeof obj.timestamp === "string"
                  ? obj.timestamp
                  : null;
            if (!timestamp) return false;
            const ms = Date.parse(timestamp);
            return Number.isFinite(ms) && ms >= cutoff && ms < nowMs;
          } catch {
            return false;
          }
        }).length;
        notes = `dry-run: would score ${itemsProcessed} observation entries`;
      } catch (err) {
        throw new Error(`light-sleep scan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (phase === "rem") {
    if (!dryRun) {
      if (!phaseRunner) {
        throw new Error("REM manual runs require a phase runner");
      }
      const result = await phaseRunner({ memoryDir, phase });
      itemsProcessed = Math.max(0, Math.floor(result.itemsProcessed));
      notes = result.notes ?? `REM pass assessed ${itemsProcessed} memories`;
    } else {
      // REM dry-runs estimate candidates without synthesizing or archiving.
      try {
        const stateFilePath = path.join(memoryDir, "state", "semantic-consolidation-last-run.json");
        let lastRunAt: string | null = null;
        try {
          const stateRaw = await readFile(stateFilePath, "utf-8");
          const stateData = JSON.parse(stateRaw) as { lastRunAt?: string };
          lastRunAt = stateData.lastRunAt ?? null;
        } catch {
          // No state file — never run.
        }
        const memFiles = await listMemoryFiles(memoryDir);
        itemsProcessed = memFiles.length;
        notes = `dry-run: ${itemsProcessed} memories would enter REM consolidation pass${lastRunAt ? ` (last run: ${lastRunAt})` : " (never run)"}`;
      } catch (err) {
        throw new Error(`REM scan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    // deep sleep
    if (governanceRunner) {
      try {
        const result = await governanceRunner({ memoryDir, dryRun });
        itemsProcessed = result.scannedMemories;
        notes = result.notes ?? (dryRun ? `dry-run: ${result.appliedActionCount} actions proposed` : `${result.appliedActionCount} actions applied`);
      } catch (err) {
        throw new Error(`deep-sleep governance run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // Fallback: count memory files.
      const memFiles = await listMemoryFiles(memoryDir);
      itemsProcessed = memFiles.length;
      notes = dryRun
        ? `dry-run: ${itemsProcessed} memories eligible for deep-sleep governance`
        : `assessed ${itemsProcessed} memories for deep-sleep governance`;
    }
  }

  const completedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  let ledgerEntry: DreamsLedgerEntry | undefined;
  try {
    ledgerEntry = await recordDreamsPhaseRun({
      memoryDir,
      startedAt,
      completedAt,
      phase,
      itemsProcessed,
      dryRun,
      trigger: "manual",
      notes,
    });
  } catch {
    // Telemetry is best-effort: the phase work has already completed.
  }

  return {
    phase,
    dryRun,
    durationMs: ledgerEntry?.durationMs ?? durationMs,
    itemsProcessed,
    notes,
    ledgerEntry,
  };
}

// ── Shared governance result mapping ──────────────────────────────────────────

export function summarizeGovernanceResultForDreams(
  govResult: {
    summary?: { scannedMemories?: number };
    proposedActions: unknown[];
    appliedActions: unknown[];
    reviewQueue: unknown[];
  },
  dryRun: boolean,
): { scannedMemories: number; appliedActionCount: number; notes?: string } {
  const proposedCount = govResult.proposedActions.length;
  const appliedCount = govResult.appliedActions.length;
  const scannedCount =
    typeof govResult.summary?.scannedMemories === "number" &&
    Number.isFinite(govResult.summary.scannedMemories)
      ? Math.max(0, Math.floor(govResult.summary.scannedMemories))
      : govResult.reviewQueue.length;
  return {
    scannedMemories: scannedCount,
    appliedActionCount: appliedCount,
    notes: dryRun
      ? `shadow mode: ${proposedCount} actions proposed`
      : `applied ${appliedCount} actions`,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function listMemoryFiles(memoryDir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const root = await lstat(memoryDir);
    if (root.isSymbolicLink()) {
      throw new Error(`memoryDir must not be a symlink: ${memoryDir}`);
    }
    if (!root.isDirectory()) return out;
  } catch (err) {
    if (err instanceof Error && /must not be a symlink/.test(err.message)) {
      throw err;
    }
    return out;
  }

  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as typeof entries;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip state/ and archive/ subdirs.
        if (
          entry.name === "state" ||
          entry.name === "archive" ||
          entry.name === "namespaces" ||
          entry.name === ".git"
        ) continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }

  await walk(memoryDir);
  return out;
}
