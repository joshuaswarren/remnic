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
 * reads for encrypted files. `maxDecryptBytes` bounds the whole-file decrypt:
 * when set, an encrypted file at/over it is refused before decryption with an
 * actionable error. The ceiling is OPT-IN so it applies ONLY to callers with a
 * compaction-backed remedy (the lifecycle ledger). Callers with no bounded
 * maintenance path — e.g. the memory-actions ledger — omit it and keep the
 * prior unbounded read (issue #1910).
 */
export async function* readMaybeEncryptedLines(
  filePath: string,
  readEncryptedFile: () => Promise<string>,
  maxDecryptBytes?: number,
): AsyncGenerator<string> {
  const file = await open(filePath, "r");
  const header = Buffer.alloc(MAGIC_HEADER_SIZE);
  try {
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (isEncryptedFile(header.subarray(0, bytesRead))) {
      if (maxDecryptBytes !== undefined) {
        const { size } = await file.stat();
        if (size >= maxDecryptBytes) {
          throw new Error(
            `encrypted state file ${filePath} is ${size} bytes, over the ${maxDecryptBytes}-byte `
            + `whole-file decrypt limit. Run 'remnic rebuild-memory-lifecycle-ledger --write' (or 'remnic doctor') `
            + `to compact it.`,
          );
        }
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
 * Shared by the tail reader and the per-memory reader so both apply the EXACT
 * same fail-open guard as `readAllLifecycleEventsFromLedger` (`eventType` is any
 * string). Governance reads via `readMemoryLifecycleEvents(MAX_SAFE_INTEGER)`
 * must be byte-for-byte identical to `readAllMemoryLifecycleEvents`, so this
 * MUST NOT restrict `eventType` to a handled allow-list — an unknown type is
 * still admitted here and sorted deterministically by `lifecycleEventSortRank`
 * (issue #1910).
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
 * Bounded min-heap that retains the `limit` rows that rank highest under
 * `compare`, breaking ties by append order (later rows win). Heap use is
 * O(limit); each row costs O(log limit). Used for the per-memory timeline
 * fallback, which must keep the last `limit` events in canonical
 * timestamp/event order — not merely the last `limit` appended rows.
 */
class BoundedLifecycleTopN {
  private readonly heap: Array<{ event: MemoryLifecycleEvent; seq: number }> = [];

  constructor(
    private readonly limit: number,
    private readonly compare: (a: MemoryLifecycleEvent, b: MemoryLifecycleEvent) => number,
  ) {}

  private less(
    a: { event: MemoryLifecycleEvent; seq: number },
    b: { event: MemoryLifecycleEvent; seq: number },
  ): boolean {
    const c = this.compare(a.event, b.event);
    return c !== 0 ? c < 0 : a.seq < b.seq;
  }

  add(event: MemoryLifecycleEvent, seq: number): void {
    const item = { event, seq };
    if (this.heap.length < this.limit) {
      this.heap.push(item);
      this.siftUp(this.heap.length - 1);
    } else if (this.heap.length > 0 && this.less(this.heap[0], item)) {
      this.heap[0] = item;
      this.siftDown(0);
    }
  }

  /** Kept rows in ascending canonical order (append order breaks ties). */
  drainSorted(): MemoryLifecycleEvent[] {
    return this.heap
      .slice()
      .sort((a, b) => (this.less(a, b) ? -1 : this.less(b, a) ? 1 : 0))
      .map((item) => item.event);
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(this.heap[i], this.heap[parent])) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    const n = this.heap.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.less(this.heap[left], this.heap[smallest])) smallest = left;
      if (right < n && this.less(this.heap[right], this.heap[smallest])) smallest = right;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}

/**
 * Bounded tail read for lifecycle-event rows, mirroring
 * `readMemoryActionEventRowsFromLines`: heap use is O(limit) rather than
 * O(rows), no matter how large the ledger is. When `memoryId` is supplied,
 * only rows for that memory are considered, so the per-memory timeline
 * fallback never materializes the whole ledger either.
 *
 * Without `compare`, the retained rows are the last `limit` *appended* rows
 * (returned oldest→newest of that tail); callers apply
 * `sortMemoryLifecycleEvents` for canonical ordering. With `compare`, the
 * retained rows are the `limit` rows that rank highest under `compare` (ties
 * broken by append order), returned in ascending `compare` order — preserving
 * the prior "filter → canonical sort → last N" semantics without loading the
 * whole file.
 */
export async function readMemoryLifecycleEventsFromLines(
  lines: AsyncIterable<string>,
  limit: number,
  memoryId?: string,
  compare?: (a: MemoryLifecycleEvent, b: MemoryLifecycleEvent) => number,
): Promise<MemoryLifecycleEvent[]> {
  if (limit <= 0) return [];
  const top = compare ? new BoundedLifecycleTopN(limit, compare) : null;
  const ring: MemoryLifecycleEvent[] = [];
  let writeIndex = 0;
  let seq = 0;
  for await (const row of lines) {
    const line = row.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<MemoryLifecycleEvent>;
      if (memoryId !== undefined && parsed.memoryId !== memoryId) continue;
      if (!isValidLifecycleEventRow(parsed)) continue;
      if (top) {
        top.add(parsed, seq++);
      } else if (ring.length < limit) {
        ring.push(parsed);
      } else {
        ring[writeIndex] = parsed;
        writeIndex = (writeIndex + 1) % limit;
      }
    } catch {
      // Ignore malformed rows (fail-open).
    }
  }
  if (top) return top.drainSorted();
  return writeIndex === 0 ? ring : [...ring.slice(writeIndex), ...ring.slice(0, writeIndex)];
}
