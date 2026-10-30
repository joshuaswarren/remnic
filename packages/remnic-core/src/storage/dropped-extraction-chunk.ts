import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BufferTurn } from "../types.js";

/**
 * Persist a copy of extraction-buffer turns that are being DROPPED after repeated extraction failures (trigger-drain drop
 * path), so a destructive drop never loses content silently. Written under `<stateDir>/dropped/` through the store's secure
 * writer, so encrypted stores keep it encrypted (secure-fs encrypts the whole `state/dropped/` prefix). Returns the path.
 */
export async function saveDroppedExtractionChunk(
  stateDir: string,
  writeSecureFile: (filePath: string, content: string) => Promise<void>,
  bufferKey: string,
  reason: string,
  turns: readonly BufferTurn[],
): Promise<string> {
  const droppedDir = path.join(stateDir, "dropped");
  await mkdir(droppedDir, { recursive: true });
  const safeKey = bufferKey.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "default";
  // The random suffix keeps copies written in the same millisecond (or for keys that truncate to the same name) from
  // overwriting each other.
  const filePath = path.join(droppedDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeKey}.json`);
  const payload = { bufferKey, reason, droppedAt: new Date().toISOString(), turns };
  await writeSecureFile(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}
