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
 * (same pattern as the other version logs). A failed append still advances an
 * in-process counter, and `current` is the max of that counter and the file
 * size, so a readable but unwritable sentinel cannot freeze the epoch.
 * `reset` drops caches that registered at load (the mention index).
 */
const fallbackByDir = new Map<string, number>();
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

function bump(dir: string): void {
  const key = path.resolve(dir);
  const filePath = epochFile(dir);
  const next = current(dir) + 1;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, "x");
  } catch {
    // The file can still be stat-able (read-only, or the disk is full). The
    // in-process counter has to move or this process keeps serving a stale index.
  }
  fallbackByDir.set(key, Math.max(next, diskSize(filePath)));
}

function current(dir: string): number {
  const key = path.resolve(dir);
  return Math.max(diskSize(epochFile(dir)), fallbackByDir.get(key) ?? 0);
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
