import path from "node:path";
import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";

export interface ProfileMutationPorts {
  readonly baseDir: string;
  readProfile(): Promise<string>;
  writeProfile(content: string): Promise<void>;
}

export type ProfileCommitOutcome = "committed" | "conflict";

function normalizeForDedup(s: string): string {
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
    if (newNorm === existing) return true;

    const shorter = newNorm.length <= existing.length ? newNorm : existing;
    const longer = newNorm.length > existing.length ? newNorm : existing;
    if (shorter.length > 20 && shorter.length / longer.length > 0.6 && longer.includes(shorter)) {
      return true;
    }
  }
  return false;
}

async function appendToProfileUnlocked(ports: ProfileMutationPorts, updates: string[]): Promise<void> {
  // Filter out empty entries the LLM may return (persist screens strings already).
  updates = updates.filter((u) => u.trim().length > 0);
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
