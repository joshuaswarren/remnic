import path from "node:path";
import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";

/**
 * Ports over the StorageManager surface the profile mutation domain needs.
 * Kept as ports so this module stays out of the storage.ts god-file (issue
 * #1533/#1995) while sharing ONE serialization domain per baseDir: the
 * `profile:<baseDir>` key is the in-process FIFO and `profile.md.lock` is the
 * cross-process gate, matching updateMetaSerialized's meta.json.lock shape
 * (bounded, fail-closed BEFORE any read/write, no LLM inside).
 */
export interface ProfileMutationPorts {
  readonly baseDir: string;
  readProfile(): Promise<string>;
  writeProfile(content: string): Promise<void>;
}

export type ProfileCommitOutcome = "committed" | "conflict";

function normalizeForDedup(s: string): string {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if a new bullet is a fuzzy duplicate of any existing bullet.
 * Returns true if the new bullet should be skipped.
 */
function isFuzzyDuplicate(newNorm: string, existingNorms: string[]): boolean {
  for (const existing of existingNorms) {
    // Exact normalized match
    if (newNorm === existing) return true;

    // Containment check: shorter must be >60% length of longer
    const shorter = newNorm.length <= existing.length ? newNorm : existing;
    const longer = newNorm.length > existing.length ? newNorm : existing;
    if (shorter.length > 20 && shorter.length / longer.length > 0.6 && longer.includes(shorter)) {
      return true;
    }
  }
  return false;
}

async function appendToProfileUnlocked(ports: ProfileMutationPorts, updates: string[]): Promise<void> {
  // Filter out non-string entries that the LLM may return
  updates = updates.filter((u) => typeof u === "string" && u.trim().length > 0);
  if (updates.length === 0) return;
  const existing = await ports.readProfile();

  const existingNorms = (existing ? existing.split("\n") : [])
    .filter((l) => l.startsWith("- "))
    .map((l) => normalizeForDedup(l.slice(2).trim()));
  const newBullets = updates.filter((u) => {
    const norm = normalizeForDedup(u);
    return !isFuzzyDuplicate(norm, existingNorms);
  });
  if (newBullets.length === 0) return;

  await ports.writeProfile(
    existing
      ? existing.trimEnd() + "\n" + newBullets.map((b) => `- ${b}`).join("\n") + "\n"
      : ["# Behavioral Profile", "", ...newBullets.map((b) => `- ${b}`), ""].join("\n"),
  );
}

/**
 * Cross-process profile mutation domain: fail-closed `profile.md.lock` for the
 * brief mutation window only. Lock contention throws (`profile update skipped:
 * profile.md.lock not acquired`) — never a silent unlocked RMW; callers treat
 * it like a meta lock skip (retain and retry).
 */
async function withProfileMutationLock<T>(ports: ProfileMutationPorts, task: () => Promise<T>): Promise<T> {
  return withHeldFileLock(
    path.join(ports.baseDir, "profile.md.lock"),
    // Bounded: a profile RMW is a short read-merge-write, never a scan.
    { staleMs: 5_000, maxWaitMs: 2_000, pollMs: 50 },
    async (acquired) => {
      if (!acquired) {
        throw new Error(`profile update skipped: profile.md.lock not acquired (${ports.baseDir})`);
      }
      return task();
    },
  );
}

export async function appendToProfileSerialized(ports: ProfileMutationPorts, updates: string[]): Promise<void> {
  // Per-dir in-process chain, then the cross-process lock around the whole
  // RMW: serialized, the second append re-reads after the first's write.
  // Errors propagate: the extraction retry path retains the accepted turns.
  await serializeMutations(`profile:${ports.baseDir}`, () =>
    withProfileMutationLock(ports, () => appendToProfileUnlocked(ports, updates)),
  );
}

/**
 * Commit an LLM profile consolidation only if the profile is unchanged since
 * `baseline` was read; when a concurrent append landed during the LLM call,
 * return "conflict" and leave the file untouched (the append survives and the
 * line cap re-triggers consolidation on fresh data next pass). The LLM call
 * itself stays OUTSIDE this serialization domain; only this short
 * read-compare-write is serialized + locked.
 */
export async function commitConsolidatedProfileSerialized(
  ports: ProfileMutationPorts,
  baseline: string,
  consolidated: string,
): Promise<ProfileCommitOutcome> {
  return serializeMutations(`profile:${ports.baseDir}`, () =>
    withProfileMutationLock(ports, async () => {
      const current = await ports.readProfile();
      if (current !== baseline) return "conflict";
      await ports.writeProfile(consolidated);
      return "committed";
    }),
  );
}
