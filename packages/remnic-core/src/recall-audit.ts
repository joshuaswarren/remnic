import type { Dirent } from "node:fs";
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

export interface RecallAuditEntry {
  ts: string;
  sessionKey: string;
  agentId: string;
  trigger: string;
  queryText: string;
  candidateMemoryIds: string[];
  summary: string | null;
  injectedChars: number;
  toggleState: "enabled" | "disabled-primary" | "disabled-secondary";
  latencyMs?: number;
  plannerMode?: string;
  requestedMode?: string;
  fallbackUsed?: boolean;
}

function formatIsoDate(ts: string): string {
  const normalized = new Date(ts);
  if (Number.isNaN(normalized.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return normalized.toISOString().slice(0, 10);
}

export function buildRecallAuditPath(rootDir: string, ts: string, sessionKey: string): string {
  const safeSessionKey = encodeURIComponent(sessionKey);
  return path.join(rootDir, "transcripts", formatIsoDate(ts), `${safeSessionKey}.jsonl`);
}

export async function appendRecallAuditEntry(
  rootDir: string,
  entry: RecallAuditEntry,
): Promise<string> {
  const filePath = buildRecallAuditPath(rootDir, entry.ts, entry.sessionKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return filePath;
}

export async function pruneRecallAuditEntries(
  rootDir: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<string[]> {
  const transcriptsDir = path.join(rootDir, "transcripts");
  const removed: string[] = [];
  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(1, Math.floor(retentionDays)));
  let entries: Dirent[];
  try {
    entries = await readdir(transcriptsDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const day = new Date(`${entry.name}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime()) || day >= cutoff) continue;
    const dirPath = path.join(transcriptsDir, entry.name);
    await rm(dirPath, { recursive: true, force: true });
    removed.push(dirPath);
  }

  return removed;
}
