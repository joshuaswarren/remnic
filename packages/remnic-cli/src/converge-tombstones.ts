import * as fs from "node:fs";
import * as path from "node:path";
import type { ReconcileManifest } from "@remnic/core/reconcile/manifest.js";

/**
 * Tombstone evidence shared by the converge census phases (#2150 retraction
 * semantics, extracted from converge.ts for the #2803 sibling-module split).
 * A tombstone is a deliberate retraction: its digests are what stop a plan
 * from pushing a peer-retracted memory back (resurrection).
 */

export interface TombstoneEvidence {
  contentHashes: Set<string>;
  fileSha256: Set<string>;
}

export const TOMBSTONE_PATHS = ["state/tombstones.jsonl", "tombstones.jsonl"] as const;

export function parseTombstoneEvidence(content: string): TombstoneEvidence {
  const contentHashes = new Set<string>();
  const fileSha256 = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as { contentHash?: unknown; fileSha256?: unknown };
      if (typeof record.contentHash === "string" && /^[0-9a-f]{64}$/i.test(record.contentHash)) {
        contentHashes.add(record.contentHash.toLowerCase());
      }
      if (typeof record.fileSha256 === "string" && /^[0-9a-f]{64}$/i.test(record.fileSha256)) {
        fileSha256.add(record.fileSha256.toLowerCase());
      }
    } catch {
      continue;
    }
  }
  return { contentHashes, fileSha256 };
}

export function tombstonedFileDigests(
  evidence: TombstoneEvidence,
  manifest: ReconcileManifest | undefined
): Set<string> {
  const result = new Set(evidence.fileSha256);
  for (const file of manifest?.files ?? []) {
    if (file.memory && evidence.contentHashes.has(file.memory.contentHash.toLowerCase())) {
      result.add(file.sha256.toLowerCase());
    }
  }
  return result;
}

export async function readLocalTombstoneEvidence(rootDir: string): Promise<TombstoneEvidence> {
  const merged: TombstoneEvidence = { contentHashes: new Set(), fileSha256: new Set() };
  for (const relativePath of TOMBSTONE_PATHS) {
    let content: string;
    try {
      content = await fs.promises.readFile(path.join(rootDir, relativePath), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const parsed = parseTombstoneEvidence(content);
    for (const value of parsed.contentHashes) merged.contentHashes.add(value);
    for (const value of parsed.fileSha256) merged.fileSha256.add(value);
  }
  return merged;
}
