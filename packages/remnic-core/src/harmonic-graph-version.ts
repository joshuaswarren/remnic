import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { MEMORY_CORPUS_VERSION_SENTINEL } from "./memory-corpus-version.js";

/**
 * Append-only sentinel in the abstraction node store root. The byte size is the
 * version of the node and cue anchor stores, the same scheme the memory corpus
 * sentinel uses, so a bump in one process is seen by every other process.
 */
export const HARMONIC_GRAPH_VERSION_SENTINEL = ".harmonic-graph-version.log";

// Names must match StorageManager.versionFilePath("memory-status" | "cold-write").
const MEMORY_STATUS_VERSION_SENTINEL = ".memory-status-version.log";
const COLD_WRITE_VERSION_SENTINEL = ".cold-write-version.log";

/**
 * Record that a node or cue anchor was written. Fail-open: a failed bump must not
 * fail the write; the harmonic graph cache TTL bounds the stale window.
 */
export function bumpHarmonicGraphVersion(abstractionNodeStoreDir: string): void {
  try {
    mkdirSync(abstractionNodeStoreDir, { recursive: true });
    appendFileSync(path.join(abstractionNodeStoreDir, HARMONIC_GRAPH_VERSION_SENTINEL), "x");
  } catch {
    /* fail-open */
  }
}

function sentinelSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Four stats; changes whenever a memory, a node or a cue anchor is written. */
export function readHarmonicGraphStamp(memoryDir: string, abstractionNodeStoreDir: string): string {
  const stateDir = path.join(memoryDir, "state");
  return [
    sentinelSize(path.join(stateDir, MEMORY_CORPUS_VERSION_SENTINEL)),
    sentinelSize(path.join(stateDir, MEMORY_STATUS_VERSION_SENTINEL)),
    sentinelSize(path.join(stateDir, COLD_WRITE_VERSION_SENTINEL)),
    sentinelSize(path.join(abstractionNodeStoreDir, HARMONIC_GRAPH_VERSION_SENTINEL)),
  ].join(":");
}
