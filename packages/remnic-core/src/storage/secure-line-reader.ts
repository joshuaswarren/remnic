import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

import { isEncryptedFile, MAGIC_HEADER_SIZE } from "../secure-store/secure-fs.js";
import type { MemoryActionEvent, MemoryLifecycleEvent } from "../types.js";

/**
 * Whole-file decrypt ceiling for encrypted state files. V8's max string length
 * is ~512MB; a decrypted body that approaches it throws an opaque
 * `Invalid string length` on every read (the 691MB lifecycle-ledger incident).
 * We refuse at a size comfortably under the cap and point the operator at the
 * compaction remedy instead of letting the runtime crash. Plaintext streaming
 * is unaffected at any size.
 */
export const STATE_FILE_MAX_DECRYPT_BYTES = 400 * 1024 * 1024;

/**
 * Stream plaintext files by line while preserving authenticated whole-file
 * reads for encrypted files.
 */
export async function* readMaybeEncryptedLines(
  filePath: string,
  readEncryptedFile: () => Promise<string>,
): AsyncGenerator<string> {
  const file = await open(filePath, "r");
  const header = Buffer.alloc(MAGIC_HEADER_SIZE);
  try {
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (isEncryptedFile(header.subarray(0, bytesRead))) {
      const { size } = await file.stat();
      if (size >= STATE_FILE_MAX_DECRYPT_BYTES) {
        throw new Error(
          `encrypted state file ${filePath} is ${size} bytes, over the ${STATE_FILE_MAX_DECRYPT_BYTES}-byte `
          + `whole-file decrypt limit. Run 'remnic rebuild-memory-lifecycle-ledger --write' (or 'remnic doctor') `
          + `to compact it.`,
        );
      }
      yield* (await readEncryptedFile()).split("\n");
      return;
    }

    const input = createReadStream(filePath, {
      autoClose: false,
      encoding: "utf8",
      fd: file.fd,
      start: 0,
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) yield line;
    } finally {
      lines.close();
    }
  } finally {
    await file.close();
  }
}

export async function readMemoryActionEventRowsFromLines(
  lines: AsyncIterable<string>,
  limit: number,
): Promise<Array<{ line: number; event: MemoryActionEvent }>> {
  const out: Array<{ line: number; event: MemoryActionEvent }> = [];
  let writeIndex = 0;
  let lineNumber = 0;
  for await (const row of lines) {
    lineNumber += 1;
    const line = row.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<MemoryActionEvent>;
      const outcome = parsed.outcome === "applied" || parsed.outcome === "skipped" || parsed.outcome === "failed"
        ? parsed.outcome
        : null;
      if (
        typeof parsed.timestamp === "string" &&
        typeof parsed.action === "string" &&
        outcome !== null
      ) {
        const entry = {
          line: lineNumber,
          event: { ...parsed, outcome } as MemoryActionEvent,
        };
        if (out.length < limit) {
          out.push(entry);
        } else {
          out[writeIndex] = entry;
          writeIndex = (writeIndex + 1) % limit;
        }
      }
    } catch {
      // Ignore malformed rows (fail-open).
    }
  }
  return writeIndex === 0 ? out : [...out.slice(writeIndex), ...out.slice(0, writeIndex)];
}

/**
 * Validate that a parsed row carries every required lifecycle-event field.
 * Shared by the tail reader and the per-memory reader so both apply the exact
 * same fail-open guard as `readAllMemoryLifecycleEvents`.
 */
function isValidLifecycleEventRow(
  parsed: Partial<MemoryLifecycleEvent>,
): parsed is MemoryLifecycleEvent {
  return (
    typeof parsed.eventId === "string" &&
    typeof parsed.memoryId === "string" &&
    typeof parsed.eventType === "string" &&
    typeof parsed.timestamp === "string" &&
    typeof parsed.actor === "string" &&
    typeof parsed.ruleVersion === "string"
  );
}

/**
 * Bounded tail read for lifecycle-event rows, mirroring
 * `readMemoryActionEventRowsFromLines`: keeps only a `limit`-sized ring so heap
 * use is O(limit) rather than O(rows), no matter how large the ledger is. When
 * `memoryId` is supplied, only rows for that memory are considered, so the
 * per-memory timeline fallback never materializes the whole ledger either.
 *
 * Returns the retained rows in append order (oldest→newest of the kept tail);
 * callers apply `sortMemoryLifecycleEvents` to get canonical ordering.
 */
export async function readMemoryLifecycleEventsFromLines(
  lines: AsyncIterable<string>,
  limit: number,
  memoryId?: string,
): Promise<MemoryLifecycleEvent[]> {
  const out: MemoryLifecycleEvent[] = [];
  if (limit <= 0) return out;
  let writeIndex = 0;
  for await (const row of lines) {
    const line = row.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<MemoryLifecycleEvent>;
      if (memoryId !== undefined && parsed.memoryId !== memoryId) continue;
      if (isValidLifecycleEventRow(parsed)) {
        if (out.length < limit) {
          out.push(parsed);
        } else {
          out[writeIndex] = parsed;
          writeIndex = (writeIndex + 1) % limit;
        }
      }
    } catch {
      // Ignore malformed rows (fail-open).
    }
  }
  return writeIndex === 0 ? out : [...out.slice(writeIndex), ...out.slice(0, writeIndex)];
}
