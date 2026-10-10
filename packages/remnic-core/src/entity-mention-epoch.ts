import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Entity-mention freshness, separate from the hot-memories corpus sentinel.
 *
 * Every memory write bumps the corpus version so the hot cache stays coherent.
 * The entity mention index does not depend on heat, decay, lifecycle, or
 * lastValidatedAt, so those rewrites must not force a fact-file rescan.
 * Content, entityRef, and origin changes bump this epoch. Metadata-only
 * frontmatter rewrites run inside `hold()` and leave it alone.
 *
 * The on-disk sentinel is the byte size of `state/.entity-mention-epoch.log`
 * (same pattern as the other version logs). A failed append adds one to an
 * in-process extra, and `current` is the file size plus that extra. A later
 * successful append, including one from another process, grows the file and
 * moves `current` past those failed bumps. `reset` drops caches that
 * registered at load (the mention index).
 */
const fallbackByDir = new Map<string, { extra: number; disk: number }>();
const suppression = new AsyncLocalStorage<true>();
let onReset: (() => void) | null = null;

type MentionFrontmatter = {
  entityRef?: unknown;
  origin?: unknown;
};

function epochFile(dir: string): string {
  return path.join(path.resolve(dir), "state", ".entity-mention-epoch.log");
}

function mentionField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function diskSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function localEpoch(key: string, disk: number): { extra: number; disk: number } {
  const existing = fallbackByDir.get(key);
  if (existing) return existing;
  const created = { extra: 0, disk };
  fallbackByDir.set(key, created);
  return created;
}

function bump(dir: string): void {
  const key = path.resolve(dir);
  const filePath = epochFile(dir);
  const before = diskSize(filePath);
  let appended = false;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, "x");
    appended = true;
  } catch {
    // The file can still be stat-able (read-only, or the disk is full). The
    // in-process counter has to move or this process keeps serving a stale index.
  }
  const after = diskSize(filePath);
  const local = localEpoch(key, before);
  if (!appended || after <= before) local.extra += 1;
  noteDisk(local, after);
}

function noteDisk(local: { extra: number; disk: number }, disk: number): void {
  if (disk < local.disk) local.extra += local.disk - disk;
  local.disk = disk;
}

function current(dir: string): number {
  const key = path.resolve(dir);
  const disk = diskSize(epochFile(dir));
  const local = fallbackByDir.get(key);
  if (!local) return disk;
  noteDisk(local, disk);
  // Failed appends stay ahead of the file. A peer's later successful append
  // grows `disk` and must not land on the same number as those local failures.
  return disk + local.extra;
}

function suppressed(): boolean {
  return suppression.getStore() === true;
}

function hold<T>(fn: () => T): T {
  return suppression.run(true, fn);
}

function registerReset(fn: () => void): void {
  onReset = fn;
}

function reset(): void {
  onReset?.();
}

function neutral(before: MentionFrontmatter, after: MentionFrontmatter): boolean {
  return (
    mentionField(before.entityRef) === mentionField(after.entityRef) &&
    mentionField(before.origin) === mentionField(after.origin)
  );
}

export const entityMentionEpoch = {
  bump,
  current,
  suppressed,
  hold,
  neutral,
  registerReset,
  reset,
};
