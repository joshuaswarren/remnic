import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  backupAndWriteRebuiltObservations,
  toHourBucketIso,
} from "./observation-ledger-utils.js";

interface CanonicalObservationRow {
  sessionKey: string;
  hour: string;
  turnCount: number;
  userTurns: number;
  assistantTurns: number;
}

type JsonRecord = Record<string, unknown>;

export interface MigrateObservationsOptions {
  memoryDir: string;
  dryRun?: boolean;
  now?: Date;
}

export interface MigrateObservationsResult {
  dryRun: boolean;
  scannedFiles: number;
  parsedRows: number;
  malformedLines: number;
  migratedRows: number;
  outputPath: string;
  backupPath?: string;
  sourceRelativePaths: string[];
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  if (normalized < 0) return null;
  return normalized;
}

function toHourIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return toHourBucketIso(value);
}

function toSessionKey(row: JsonRecord): string | null {
  const candidates = [row.sessionKey, row.session, row.session_id, row.sessionId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function toLegacyHour(row: JsonRecord): string | null {
  const candidates = [row.hour, row.hourStart, row.timestamp, row.time];
  for (const candidate of candidates) {
    const hour = toHourIso(candidate);
    if (hour) return hour;
  }
  return null;
}

function toCounts(row: JsonRecord): { turnCount: number; userTurns: number; assistantTurns: number } | null {
  const role = row.role === "user" || row.role === "assistant" ? row.role : null;
  const explicitTurnCount =
    toNonNegativeInt(row.turnCount) ??
    toNonNegativeInt(row.turns) ??
    toNonNegativeInt(row.totalTurns);
  const explicitUserTurns =
    toNonNegativeInt(row.userTurns) ??
    toNonNegativeInt(row.user) ??
    toNonNegativeInt(row.userCount);
  const explicitAssistantTurns =
    toNonNegativeInt(row.assistantTurns) ??
    toNonNegativeInt(row.assistant) ??
    toNonNegativeInt(row.assistantCount);

  let turnCount = explicitTurnCount ?? 0;
  let userTurns = explicitUserTurns ?? 0;
  let assistantTurns = explicitAssistantTurns ?? 0;

  if (turnCount === 0 && userTurns === 0 && assistantTurns === 0 && role) {
    turnCount = 1;
    if (role === "user") userTurns = 1;
    if (role === "assistant") assistantTurns = 1;
  }

  if (turnCount === 0 && (userTurns > 0 || assistantTurns > 0)) {
    turnCount = userTurns + assistantTurns;
  }
  if (turnCount < userTurns + assistantTurns) {
    turnCount = userTurns + assistantTurns;
  }
  if (turnCount === 0) return null;
  return { turnCount, userTurns, assistantTurns };
}

async function listLegacyObservationFiles(root: string): Promise<string[]> {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Array<{
      name: string;
      isFile(): boolean;
    }>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code === "ENOENT") return [];
    throw err;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .filter((name) => name !== "rebuilt-observations.jsonl")
    .sort((a, b) => a.localeCompare(b));
  return files;
}

export async function migrateObservations(
  options: MigrateObservationsOptions,
): Promise<MigrateObservationsResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const ledgerRoot = path.join(options.memoryDir, "state", "observation-ledger");
  const outputPath = path.join(ledgerRoot, "rebuilt-observations.jsonl");
  const legacyFiles = await listLegacyObservationFiles(ledgerRoot);
  const sourceRelativePaths = legacyFiles.map((name) => path.join("state", "observation-ledger", name));

  const byKey = new Map<string, CanonicalObservationRow>();
  let parsedRows = 0;
  let malformedLines = 0;

  for (const file of legacyFiles) {
    const full = path.join(ledgerRoot, file);
    const raw = await readFile(full, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: JsonRecord;
      try {
        const candidate = JSON.parse(line);
        if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) {
          malformedLines += 1;
          continue;
        }
        parsed = candidate as JsonRecord;
      } catch {
        malformedLines += 1;
        continue;
      }

      const sessionKey = toSessionKey(parsed);
      const hour = toLegacyHour(parsed);
      const counts = toCounts(parsed);
      if (!sessionKey || !hour || !counts) {
        malformedLines += 1;
        continue;
      }

      const key = `${sessionKey}\u0000${hour}`;
      const existing = byKey.get(key) ?? {
        sessionKey,
        hour,
        turnCount: 0,
        userTurns: 0,
        assistantTurns: 0,
      };
      existing.turnCount += counts.turnCount;
      existing.userTurns += counts.userTurns;
      existing.assistantTurns += counts.assistantTurns;
      if (existing.turnCount < existing.userTurns + existing.assistantTurns) {
        existing.turnCount = existing.userTurns + existing.assistantTurns;
      }
      byKey.set(key, existing);
      parsedRows += 1;
    }
  }

  const aggregates = Array.from(byKey.values()).sort((a, b) => {
    if (a.sessionKey !== b.sessionKey) return a.sessionKey.localeCompare(b.sessionKey);
    return a.hour.localeCompare(b.hour);
  });

  if (!dryRun && legacyFiles.length === 0) {
    return {
      dryRun,
      scannedFiles: legacyFiles.length,
      parsedRows,
      malformedLines,
      migratedRows: aggregates.length,
      outputPath,
      sourceRelativePaths,
    };
  }

  let backupPath: string | undefined;
  if (!dryRun) {
    backupPath = await backupAndWriteRebuiltObservations({
      memoryDir: options.memoryDir,
      outputPath,
      rows: aggregates,
      now,
    });
  }

  return {
    dryRun,
    scannedFiles: legacyFiles.length,
    parsedRows,
    malformedLines,
    migratedRows: aggregates.length,
    outputPath,
    backupPath,
    sourceRelativePaths,
  };
}
