import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BufferTurn } from "../types.js";

/** Where and how a StorageManager writes secure state files. */
export interface DroppedChunkIo {
  stateDir: string;
  write(filePath: string, content: string): Promise<void>;
}

export type DroppedChunkArgs = [bufferKey: string, reason: string, turns: readonly BufferTurn[]];

/**
 * Save the recovery copy of a buffer chunk before it is dropped
 * (`<stateDir>/dropped/`, encrypted like buffer state). The random suffix keeps
 * copies written in the same millisecond, or for keys that truncate to the
 * same name, from overwriting each other.
 */
export async function saveDroppedChunk(io: DroppedChunkIo, ...[bufferKey, reason, turns]: DroppedChunkArgs): Promise<string> {
  const droppedDir = path.join(io.stateDir, "dropped");
  await mkdir(droppedDir, { recursive: true });
  const safeKey = bufferKey.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "default";
  const filePath = path.join(droppedDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeKey}.json`);
  await io.write(filePath, JSON.stringify({ bufferKey, reason, droppedAt: new Date().toISOString(), turns }, null, 2));
  return filePath;
}
