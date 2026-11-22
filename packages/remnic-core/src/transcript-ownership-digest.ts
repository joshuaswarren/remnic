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
