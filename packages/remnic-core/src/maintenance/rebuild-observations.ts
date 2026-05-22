import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  backupAndWriteRebuiltObservations,
  toHourBucketIso,
} from "./observation-ledger-utils.js";

interface TranscriptLikeEntry {
  timestamp?: string;
  role?: string;
  sessionKey?: string;
}

interface ObservationAggregate {
  sessionKey: string;
  hour: string;
  turnCount: number;
  userTurns: number;
  assistantTurns: number;
}

export interface RebuildObservationsOptions {
  memoryDir: string;
  dryRun?: boolean;
  now?: Date;
  readTranscriptFile?: (file: string) => Promise<string>;
}

export interface RebuildObservationsResult {
  dryRun: boolean;
  scannedFiles: number;
  parsedTurns: number;
  malformedLines: number;
  rebuiltRows: number;
  outputPath: string;
  backupPath?: string;
}

function toSortableKey(sessionKey: string, hour: string): string {
  return `${sessionKey}\u0000${hour}`;
}

async function listTranscriptFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code === "ENOENT") return out;
    throw err;
  }

  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTranscriptFiles(full)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function buildLedgerRows(linesByFile: string[]): {
  aggregates: ObservationAggregate[];
  parsedTurns: number;
  malformedLines: number;
} {
  const byKey = new Map<string, ObservationAggregate>();
  let parsedTurns = 0;
  let malformedLines = 0;

  for (const rawFile of linesByFile) {
    for (const line of rawFile.split("\n")) {
      if (!line.trim()) continue;
      let parsed: TranscriptLikeEntry;
      try {
        const candidate = JSON.parse(line);
        if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) {
          malformedLines += 1;
          continue;
        }
        parsed = candidate as TranscriptLikeEntry;
      } catch {
        malformedLines += 1;
        continue;
      }

      if (typeof parsed.sessionKey !== "string" || parsed.sessionKey.length === 0) continue;
      if (parsed.role !== "user" && parsed.role !== "assistant") continue;
      if (typeof parsed.timestamp !== "string") continue;
      const hour = toHourBucketIso(parsed.timestamp);
      if (!hour) continue;

      const key = toSortableKey(parsed.sessionKey, hour);
      const existing = byKey.get(key) ?? {
        sessionKey: parsed.sessionKey,
        hour,
        turnCount: 0,
        userTurns: 0,
        assistantTurns: 0,
      };
      existing.turnCount += 1;
      if (parsed.role === "user") existing.userTurns += 1;
      if (parsed.role === "assistant") existing.assistantTurns += 1;
      byKey.set(key, existing);
      parsedTurns += 1;
    }
  }

  const aggregates = Array.from(byKey.values()).sort((a, b) => {
    if (a.sessionKey !== b.sessionKey) return a.sessionKey.localeCompare(b.sessionKey);
    return a.hour.localeCompare(b.hour);
  });

  return { aggregates, parsedTurns, malformedLines };
}

export async function rebuildObservations(
  options: RebuildObservationsOptions,
): Promise<RebuildObservationsResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const transcriptsRoot = path.join(options.memoryDir, "transcripts");
  const outputPath = path.join(
    options.memoryDir,
    "state",
    "observation-ledger",
    "rebuilt-observations.jsonl",
  );

  const transcriptFiles = await listTranscriptFiles(transcriptsRoot);
  const contents: string[] = [];
  const readTranscriptFile =
    options.readTranscriptFile ?? ((file: string) => readFile(file, "utf-8"));
  for (const file of transcriptFiles) {
    try {
      contents.push(await readTranscriptFile(file));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read transcript file ${file}: ${message}`);
    }
  }
  const { aggregates, parsedTurns, malformedLines } = buildLedgerRows(contents);

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
    scannedFiles: transcriptFiles.length,
    parsedTurns,
    malformedLines,
    rebuiltRows: aggregates.length,
    outputPath,
    backupPath,
  };
}
