import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Ownership of one JSONL file for one session key, derived from its bytes. */
export type JsonlOwnership = "empty" | "matches" | "foreign";

type VerifiedPrefix = { length: number; digest: string; matches: boolean };

const NEWLINE = 0x0a;

/** One entry per (session, daily file); ~250 B each, so well under 2 MiB. */
export const DEFAULT_OWNERSHIP_CACHE_ENTRIES = 4096;

function classify(bytes: Uint8Array, sessionKey: string): JsonlOwnership {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf-8");
  let matches = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).sessionKey !== sessionKey) return "foreign";
      matches = true;
    } catch {
      return "foreign";
    }
  }
  return matches ? "matches" : "empty";
}

/**
 * Parse cache for transcript directory ownership checks.
 *
 * Every {@link verify} call reads the file's exact bytes and hashes them; it
 * trusts no size, mtime, or earlier verdict that those bytes do not reproduce.
 * A cached entry records that the first `length` bytes (always ending on a
 * newline) hashed to `digest` and were all lines owned by the session. A call
 * reuses it only when the current bytes' prefix of that length hashes to the
 * same digest, then parses just the bytes after it. Anything else re-parses
 * from byte 0, so rewrites at equal size, prefix edits, and truncation all
 * fall back to a full, independent parse. Concurrent callers never share
 * verdicts; each reads and hashes for itself.
 *
 * Only owned prefixes are cached, never foreign or unreadable results, and the
 * map is an LRU capped at `maxEntries`. Keys hold the session key as a digest
 * so caller-chosen keys cannot inflate memory.
 */
export class JsonlOwnershipDigestCache {
  private readonly entries = new Map<string, VerifiedPrefix>();

  constructor(private readonly maxEntries: number = DEFAULT_OWNERSHIP_CACHE_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Rejects when the file cannot be read; callers must treat that as occupied. */
  async verify(filePath: string, sessionKey: string): Promise<JsonlOwnership> {
    const bytes = await readFile(filePath);
    const key = `${createHash("sha256").update(sessionKey).digest("hex")}\0${filePath}`;
    const hit = this.entries.get(key);

    let hash = createHash("sha256");
    let hashed = 0;
    let verified = 0;
    let matches = false;
    if (hit && hit.length <= bytes.length) {
      const probe = createHash("sha256").update(bytes.subarray(0, hit.length));
      if (probe.copy().digest("hex") === hit.digest) {
        hash = probe;
        hashed = verified = hit.length;
        matches = hit.matches;
      }
    }

    const completeEnd = bytes.lastIndexOf(NEWLINE) + 1;
    const complete = classify(bytes.subarray(verified, completeEnd), sessionKey);
    const partial = classify(bytes.subarray(completeEnd), sessionKey);
    if (complete === "foreign" || partial === "foreign") return "foreign";

    matches ||= complete === "matches";
    if (completeEnd > 0) {
      hash.update(bytes.subarray(hashed, completeEnd));
      this.remember(key, { length: completeEnd, digest: hash.digest("hex"), matches });
    }
    return matches || partial === "matches" ? "matches" : "empty";
  }

  private remember(key: string, prefix: VerifiedPrefix): void {
    this.entries.delete(key);
    this.entries.set(key, prefix);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}
