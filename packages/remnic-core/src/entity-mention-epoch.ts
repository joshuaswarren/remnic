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
 * (same pattern as the other version logs). A failed append falls back to an
 * in-process counter so a single process still invalidates.
 */
const fallbackByDir = new Map<string, number>();
const suppression = new AsyncLocalStorage<true>();

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

function bump(dir: string): void {
  const key = path.resolve(dir);
  const filePath = epochFile(dir);
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, "x");
    fallbackByDir.set(key, statSync(filePath).size);
  } catch {
    fallbackByDir.set(key, (fallbackByDir.get(key) ?? 0) + 1);
  }
}

function current(dir: string): number {
  try {
    return statSync(epochFile(dir)).size;
  } catch {
    return fallbackByDir.get(path.resolve(dir)) ?? 0;
  }
}

function suppressed(): boolean {
  return suppression.getStore() === true;
}

function hold<T>(fn: () => T): T {
  return suppression.run(true, fn);
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
};
