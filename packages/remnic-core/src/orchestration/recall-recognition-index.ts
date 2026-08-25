/**
 * Recognition-index write-path maintenance (issue #2975).
 *
 * Sibling of recall-recognition-search.ts at the memory write-path seam:
 * when recallRecognitionTier is enabled, a namespace write upserts (or
 * removes) that memory's id in `<memoryDir>/state/index_recognition.json`
 * so the recall slice's loadRecognitionIndex sees a fresh entry. Off-path
 * (`enabled !== true`) returns immediately — zero index I/O.
 *
 * Descriptions: layer 1 has no generator. This slice keeps ids current and
 * fills description from the first non-empty body line (the compact
 * `id: description` form the tier already renders). Discriminability
 * rewrite is a later tidy pass.
 *
 * Serialization matches temporal-index: an in-process op chain per index
 * path plus a directory lock around load → mutate → save. saveRecognitionIndex
 * is single-writer and does not lock on its own.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildRecognitionIndex,
  loadRecognitionIndex,
  recognitionIndexPath,
  saveRecognitionIndex,
  type RecognitionIndexEntry,
} from "../recall-recognition-tier.js";

export type RecognitionIndexChange =
  | { readonly action: "upsert"; readonly id: string; readonly content: string }
  | { readonly action: "remove"; readonly id: string };

const writeChains = new Map<string, Promise<void>>();
const LOCK_POLL_MS = 10;
const LOCK_ATTEMPTS = 50;

/**
 * First non-empty line of a memory body. Layer 1 has no description
 * generator; this is the compact line the tier already renders.
 */
export function recognitionDescriptionFromContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return "";
  const newline = trimmed.indexOf("\n");
  return newline === -1 ? trimmed : trimmed.slice(0, newline).trimEnd();
}

function withIndexChain<T>(indexPath: string, op: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(indexPath) ?? Promise.resolve();
  const run = previous.then(op, op);
  const tail = run.then(() => undefined, () => undefined);
  writeChains.set(indexPath, tail);
  void tail.then(() => {
    if (writeChains.get(indexPath) === tail) writeChains.delete(indexPath);
  });
  return run;
}

async function withRecognitionIndexLock<T>(memoryDir: string, op: () => Promise<T>): Promise<T> {
  const lockDir = `${recognitionIndexPath(memoryDir)}.lock.d`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      await fsp.mkdir(lockDir);
      try {
        return await op();
      } finally {
        await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        await fsp.mkdir(path.dirname(lockDir), { recursive: true }).catch(() => undefined);
        continue;
      }
      if (code !== "EEXIST") throw error;
      await delay(LOCK_POLL_MS);
    }
  }
  throw new Error(`recognition index lock timed out at ${lockDir}`);
}

function applyChanges(
  entries: readonly RecognitionIndexEntry[],
  changes: readonly RecognitionIndexChange[],
): RecognitionIndexEntry[] {
  const next = entries.map((entry) => ({ id: entry.id, description: entry.description }));
  const byId = new Map(next.map((entry, index) => [entry.id, index]));
  for (const change of changes) {
    const id = change.id.trim();
    if (id.length === 0) continue;
    if (change.action === "remove") {
      const index = byId.get(id);
      if (index === undefined) continue;
      next.splice(index, 1);
      byId.delete(id);
      for (const [key, value] of byId) {
        if (value > index) byId.set(key, value - 1);
      }
      continue;
    }
    const description = recognitionDescriptionFromContent(change.content);
    const existing = byId.get(id);
    if (existing !== undefined) {
      next[existing] = { id, description };
    } else {
      byId.set(id, next.length);
      next.push({ id, description });
    }
  }
  return next;
}

function meaningfulChanges(changes: readonly RecognitionIndexChange[]): RecognitionIndexChange[] {
  return changes.filter((change) => change.id.trim().length > 0);
}

/**
 * Incrementally maintain a namespace recognition index after memory writes.
 * `enabled: false` is a proven no-op: no reads, no writes, no locks.
 */
export async function maintainRecognitionIndexAfterWrite(args: {
  memoryDir: string;
  enabled: boolean;
  changes: readonly RecognitionIndexChange[];
}): Promise<void> {
  if (args.enabled !== true) return;
  const changes = meaningfulChanges(args.changes);
  if (changes.length === 0) return;

  const indexPath = recognitionIndexPath(args.memoryDir);
  await withIndexChain(indexPath, () =>
    withRecognitionIndexLock(args.memoryDir, async () => {
      const loaded = await loadRecognitionIndex(args.memoryDir);
      const entries = applyChanges(loaded?.entries ?? [], changes);
      await saveRecognitionIndex(args.memoryDir, buildRecognitionIndex(entries));
    }),
  );
}
