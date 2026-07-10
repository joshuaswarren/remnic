import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

import { isEncryptedFile, MAGIC_HEADER_SIZE } from "../secure-store/secure-fs.js";
import type { MemoryActionEvent } from "../types.js";

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
