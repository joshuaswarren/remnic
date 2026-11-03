/**
 * Record (de)serialization, validation, and touch-fold helpers for the
 * namespace catalog. Extracted from catalog.ts in #3298 to keep the catalog
 * class under its file-size ceiling; pure functions over NamespaceRecord.
 */
import type { NamespaceRecord } from "./catalog.js";
import { normalizeNamespaceIdentity, namespaceIdentityToken } from "./identity.js";

/** Later of two optional ISO timestamps (undefined-safe). */
function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const am = Date.parse(a);
  const bm = Date.parse(b);
  if (!Number.isFinite(am)) return b;
  if (!Number.isFinite(bm)) return a;
  return bm > am ? b : a;
}

/**
 * Fold the touch fields (lastReadAt / lastWriteAt / lastMaintenanceAt) from a
 * freshly re-read on-disk record into the rebuilt record, taking the LATER
 * timestamp per field (round 5 cross-process re-merge). Disk-derived fields
 * (storageDir, kind, discoveredBy, createdAt, principal hints) are owned by the
 * rebuilt record and left untouched — we only recover touch recency that a
 * concurrent (possibly cross-process) writer recorded after our initial load.
 */
export function mergeNewerTouchFields(base: NamespaceRecord, fresh: NamespaceRecord): NamespaceRecord {
  const merged: NamespaceRecord = { ...base };
  const lr = laterIso(base.lastReadAt, fresh.lastReadAt);
  if (lr) merged.lastReadAt = lr;
  const lw = laterIso(base.lastWriteAt, fresh.lastWriteAt);
  if (lw) merged.lastWriteAt = lw;
  if (base.lastMaintenanceAt || fresh.lastMaintenanceAt) {
    const jobs = { ...(base.lastMaintenanceAt ?? {}) };
    for (const [job, ts] of Object.entries(fresh.lastMaintenanceAt ?? {})) {
      const latest = laterIso(jobs[job], ts);
      if (latest) jobs[job] = latest;
    }
    if (Object.keys(jobs).length > 0) merged.lastMaintenanceAt = jobs;
  }
  return merged;
}

/**
 * Serialize a record with sorted keys (CLAUDE.md rule #38) so byte output is
 * stable across runs — required for idempotent rebuilds.
 */
export function serializeRecord(record: NamespaceRecord): string {
  const ordered: Record<string, string | Record<string, string>> = {};
  const fields: Array<keyof NamespaceRecord> = [
    "namespace",
    "identityToken",
    "kind",
    "createdAt",
    "storageDir",
    "discoveredBy",
    "lastReadAt",
    "lastWriteAt",
    "lastMaintenanceAt",
  ];
  fields.sort();
  for (const key of fields) {
    const value = record[key];
    if (value === undefined) continue;
    if (key === "lastMaintenanceAt") {
      if (!record.lastMaintenanceAt) continue;
      const jobs = record.lastMaintenanceAt;
      const sortedJobs: Record<string, string> = {};
      for (const jobKey of Object.keys(jobs).sort()) {
        sortedJobs[jobKey] = jobs[jobKey]!;
      }
      ordered[key] = sortedJobs;
      continue;
    }
    // SAFETY: the remaining fields are all plain strings in NamespaceRecord.
    ordered[key] = value as string;
  }
  return JSON.stringify(ordered);
}

