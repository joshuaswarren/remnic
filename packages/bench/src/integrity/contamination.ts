/**
 * Dataset-contamination guard.
 *
 * Published benchmark results carry a `datasetHash` in `BenchmarkResult.meta`
 * so the publishing pipeline can reject results whose dataset hash is known
 * to appear in an LLM's training corpus. The contamination list starts empty
 * and is extended as new contamination reports arrive.
 *
 * Entries are SHA-256 hex digests. Callers pass a `ContaminationManifest`
 * rather than a bare array so provenance / justification can be attached
 * alongside the hash. This keeps the audit trail visible when a result is
 * rejected.
 */

import { isSha256Hex, safeHexEqual } from "./hash-verification.js";

export interface ContaminationEntry {
  /** SHA-256 of the dataset payload as published. */
  datasetHash: string;
  /** Human-readable reason the dataset is considered contaminated. */
  reason: string;
  /** Optional citation / URL documenting the contamination report. */
  reference?: string;
  /** ISO-8601 timestamp when the entry was added. */
  addedAt: string;
}

export interface ContaminationManifest {
  version: 1;
  entries: ContaminationEntry[];
}

export interface ContaminationCheckResult {
  /** The dataset hash examined. */
  datasetHash: string;
  /** True when the dataset hash is NOT present on the contamination list. */
  clean: boolean;
  /** When `clean === false`, the matching manifest entry. */
  matched?: ContaminationEntry;
}

/**
 * Start with an empty list; upstream tooling populates this as contamination
 * reports surface. Keeping the default list empty avoids hard-coding public
 * values that could become stale.
 */
export const EMPTY_CONTAMINATION_MANIFEST: ContaminationManifest = {
  version: 1,
  entries: [],
};

export function isContaminationManifest(value: unknown): value is ContaminationManifest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ContaminationManifest>;
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) {
    return false;
  }
  return candidate.entries.every(isContaminationEntry);
}

export function isContaminationEntry(value: unknown): value is ContaminationEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ContaminationEntry>;
  return (
    isSha256Hex(candidate.datasetHash) &&
    typeof candidate.reason === "string" &&
    candidate.reason.length > 0 &&
    typeof candidate.addedAt === "string" &&
    (candidate.reference === undefined || typeof candidate.reference === "string")
  );
}

export function checkDatasetContamination(
  datasetHash: string,
  manifest: ContaminationManifest = EMPTY_CONTAMINATION_MANIFEST,
): ContaminationCheckResult {
  if (!isSha256Hex(datasetHash)) {
    throw new Error("datasetHash must be a lowercase SHA-256 hex digest.");
  }
  const matched = manifest.entries.find((entry) => safeHexEqual(entry.datasetHash, datasetHash));
  if (matched) {
    return { datasetHash, clean: false, matched };
  }
  return { datasetHash, clean: true };
}

/**
 * Merge an additional contamination entry into an existing manifest. Duplicate
 * hashes are collapsed (first-write wins) so manifests can be safely merged
 * across sources without ballooning.
 */
export function addContaminationEntry(
  manifest: ContaminationManifest,
  entry: ContaminationEntry,
): ContaminationManifest {
  if (!isContaminationEntry(entry)) {
    throw new Error("Cannot add an invalid contamination entry to the manifest.");
  }
  const existing = manifest.entries.find((candidate) =>
    safeHexEqual(candidate.datasetHash, entry.datasetHash),
  );
  if (existing) {
    return manifest;
  }
  return {
    version: 1,
    entries: [...manifest.entries, entry],
  };
}

export function mergeContaminationManifests(
  ...manifests: ContaminationManifest[]
): ContaminationManifest {
  let merged: ContaminationManifest = EMPTY_CONTAMINATION_MANIFEST;
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      merged = addContaminationEntry(merged, entry);
    }
  }
  return merged;
}
