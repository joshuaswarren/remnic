/**
 * Enrichment audit trail (issue #365).
 *
 * Append-only JSONL log for every enrichment candidate that was evaluated.
 * Each entry records whether the candidate was accepted or rejected, the
 * provider that produced it, and an optional reason string.
 */

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrichmentAuditEntry {
  timestamp: string;
  entityName: string;
  provider: string;
  candidateText: string;
  sourceUrl?: string;
  accepted: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const AUDIT_FILENAME = "enrichment-audit.jsonl";

function auditFilePath(auditDir: string): string {
  return path.join(auditDir, AUDIT_FILENAME);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single audit entry to the JSONL log. Creates the audit directory
 * and file if they do not exist.
 */
export async function appendAuditEntry(
  auditDir: string,
  entry: EnrichmentAuditEntry,
): Promise<void> {
  await mkdir(auditDir, { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  await appendFile(auditFilePath(auditDir), line, "utf-8");
}

/**
 * Read the audit log and return entries, optionally filtered to entries at
 * or after `since` (ISO 8601 timestamp, half-open interval).
 */
export async function readAuditLog(
  auditDir: string,
  since?: string,
): Promise<EnrichmentAuditEntry[]> {
  const filePath = auditFilePath(auditDir);
  if (!existsSync(filePath)) return [];
  const sinceMs = since === undefined ? undefined : Date.parse(since);
  if (since !== undefined && !Number.isFinite(sinceMs)) {
    throw new Error(`Invalid enrichment audit since timestamp: ${since}`);
  }

  const raw = await readFile(filePath, "utf-8");
  const entries: EnrichmentAuditEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "timestamp" in parsed &&
        "entityName" in parsed
      ) {
        const entry = parsed as EnrichmentAuditEntry;
        if (typeof entry.timestamp !== "string") continue;
        const entryMs = Date.parse(entry.timestamp);
        if (!Number.isFinite(entryMs)) continue;
        if (sinceMs !== undefined && entryMs < sinceMs) continue;
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}
