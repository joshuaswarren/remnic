// Node-local warm-cache generation marker (`<stateDir>/embeddings.generation`).
// Two-phase publication barrier: in-flight before a publication's first
// destructive write, fresh unique value after its last write (PR #3176), so a
// completed stamp is only ever stable while generation bytes are unchanged.
// Single owner of the atomic protocol and logging — the store's own mutations
// and the offline-sync direct write/delete paths (issue #3182) share it.
// Plain fs always (tmp + rename): the marker is node-local raw bytes, never
// sync traffic or secure-store content.
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { log } from "./logger.js";

export const GENERATION_MARKER_BASENAME = "embeddings.generation";

/** Reserved in-flight marker value; never equals a completion marker. */
export const GENERATION_MARKER_IN_FLIGHT = "in-flight";

export function generationMarkerPath(stateDirAbs: string): string {
  return path.join(stateDirAbs, GENERATION_MARKER_BASENAME);
}

/** Strict atomic marker write; recovery uses it for a fresh completed value. */
export async function writeGenerationMarkerRaw(markerAbs: string, value: string): Promise<void> {
  const tempPath = `${markerAbs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, value, "utf-8");
    await rename(tempPath, markerAbs);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Barrier first half: strict, so bytes can never change under a stable stamp. */
export async function beginGenerationMarker(markerAbs: string): Promise<void> {
  await writeGenerationMarkerRaw(markerAbs, GENERATION_MARKER_IN_FLIGHT);
}

/**
 * Barrier second half: written after the last content write. Best-effort:
 * a failure leaves the in-flight marker, whose stamp identityStamp()
 * never repeats, so cached probes revalidate on every search until a
 * publication completes.
 */
export async function completeGenerationMarker(markerAbs: string): Promise<void> {
  await writeGenerationMarkerRaw(markerAbs, randomUUID()).catch((err) => {
    log.warn(`embedding index: could not write generation completion marker: ${err instanceof Error ? err.message : String(err)}`);
  });
}
