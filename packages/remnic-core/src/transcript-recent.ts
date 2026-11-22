
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import type { TranscriptEntry } from "./types.js";

const RECENT_TAIL_CHUNK_BYTES = 1 << 18;
export const RECENT_SKEW_MS = 3_600_000;

const ISO_STAMP = /^\d{4}-\d\d-\d\dT/;

/** True when the first complete line in `chunk` (which starts mid-line) is stamped before `cutoffMs`. */
function firstLineBefore(chunk: Buffer, cutoffMs: number): boolean {
  const from = chunk.indexOf(0x0a) + 1;
  const to = chunk.indexOf(0x0a, from);
  if (from === 0 || to < 0) return false;
  try {
    // SAFETY: only `.timestamp` is read, and it is used only if it is an ISO string (the test coerces null, numbers
    // and other shapes to text that fails); new Date(null) is the epoch and would stop the scan early.
    const stamp = (JSON.parse(chunk.toString("utf-8", from, to)) as TranscriptEntry).timestamp;
    return ISO_STAMP.test(stamp) && new Date(stamp).getTime() < cutoffMs;
  } catch {
    return false;
  }
}

function countNewlines(chunk: Buffer): number {
  let n = 0;
  for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, i + 1)) n++;
  return n;
}

const FS_CONCURRENCY = 48;

/** `items.map(fn)` with at most FS_CONCURRENCY in flight (the libuv pool is shared); results keep input order. */
export async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FS_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * Lines of a daily transcript file that can be stamped at or after `cutoffMs`.
 * Files are appended in write order, so the recent window is the file's tail:
 * read 256 KiB chunks from the end and stop once the first complete line in hand is
 * older than the cutoff, or (with `maxLines`) once `maxLines` complete lines are in hand,
 * returning at most the last `maxLines`. A file not modified since the cutoff holds nothing in the window.
 * shortcut: assumes a file's timestamps never run backwards by more than the
 * RECENT_SKEW_MS the caller subtracts, and that its last `maxLines` lines hold its newest
 * `maxLines` entries (the newest-N path has no skew margin: a writer stamping entries late can change which N are returned); widen the margin if writers can lag further.
 */
export async function readLinesSince(filePath: string, cutoffMs: number, maxLines = Infinity): Promise<string[]> {
  const { size, mtimeMs } = await stat(filePath);
  if (mtimeMs < cutoffMs) return [];
  const fh = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let pos = size;
    let newlines = 0;
    while (pos > 0) {
      const buf = Buffer.allocUnsafe(Math.min(RECENT_TAIL_CHUNK_BYTES, pos));
      pos -= buf.length;
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead !== buf.length) throw new Error(`short read on ${filePath}`); // a gap would silently drop lines
      chunks.unshift(buf);
      newlines += countNewlines(chunks[0]);
      // One newline ends the partial first line; each further one ends a complete line.
      if (pos > 0 && (newlines > maxLines || firstLineBefore(chunks[0], cutoffMs))) break;
    }
    let text = Buffer.concat(chunks).toString("utf-8");
    if (pos > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    // Blank lines stay (only the final terminator goes): they count toward `maxLines` like the chunk stop counts them, and a blank fails to parse like any bad line.
    return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").slice(-maxLines);
  } finally {
    await fh.close();
  }
}

/** The newest `limit` entries in `[start, end)` from the given daily files (paths relative to `transcriptsDir`). */
export async function readNewestFromFiles(
  transcriptsDir: string,
  files: string[],
  start: Date,
  end: Date,
  limit: number,
): Promise<TranscriptEntry[]> {
  const startMs = start.getTime();
  const stamped = await mapLimited(files, async (f) => {
    const filePath = path.join(transcriptsDir, f);
    return { filePath, mtimeMs: await stat(filePath).then((s) => s.mtimeMs, () => -Infinity) };
  });
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let newest: TranscriptEntry[] = []; // ascending by timestamp, at most `limit`
  for (const { filePath, mtimeMs } of stamped) {
    // The Nth-newest timestamp so far; a file modified more than the skew before it holds nothing newer.
    const floorMs = newest.length >= limit ? new Date(newest[0].timestamp).getTime() : startMs;
    if (mtimeMs + RECENT_SKEW_MS < floorMs) break;
    let found: TranscriptEntry[] = [];
    // A bad line (torn append, no timestamp, future-dated) takes a slot without yielding an entry:
    // widen the tail until `limit` entries are found or the file's window is exhausted.
    for (let cap = limit; ; cap *= 2) {
      const lines = await readLinesSince(filePath, floorMs - RECENT_SKEW_MS, cap).catch(() => []);
      found = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as TranscriptEntry;
          const entryTime = new Date(entry.timestamp);
          if (entryTime >= start && entryTime < end) found.push(entry);
        } catch {
          log.debug(`skipped malformed transcript line in ${filePath}`);
        }
      }
      if (found.length >= limit || lines.length < cap) break;
    }
    newest = [...newest, ...found].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()).slice(-limit);
  }
  return newest;
}
