import path from "node:path";
import { raceAbort } from "./abort-error.js";
import { entityMentionEpoch } from "./entity-mention-epoch.js";
import { log } from "./logger.js";

/**
 * In-memory entity mention index.
 *
 * Scope (namespaces, dirs, secure-store key, alias map, native revision) is
 * the cache key. Mention epoch and entity-file mutation are identity inside
 * the slot, not part of the key:
 *
 * - metadata-only corpus bumps do not move the epoch, so the next recall hits
 * - entity-file changes rebuild from entity files before the recall returns,
 *   reusing memory snippets (no fact scan). A new entity is visible on that
 *   recall; its memory snippets arrive with the next full reconcile. Callers
 *   share one scan. One caller's abort stops that caller waiting and leaves
 *   the scan running for the others
 * - memory create/edit/delete moves the epoch. The recall serves the last
 *   index immediately and one background reconcile runs, plus at most one
 *   follow-up if that scan overlaps a later write. A recall during either
 *   scan does not grant another follow-up. Further rescans wait for the
 *   next recall. After writes quiesce and `settleEntityMentionIndex`
 *   finishes, the index matches a full rebuild
 * - secure-store key, alias map, and native revision stay in the key, so a
 *   change is a miss and awaits a full rebuild. A locked store never reads
 *   another key's plaintext
 */

const MAX_SLOTS = 32;
const SETTLE_ROUNDS = 8;

export type EntityMentionIdentity = {
  mentionEpoch: string;
  entityMutation: string;
};

type ScopedStorage = {
  dir: string;
  hotCacheKeyId?(): string;
  entityAliases?: Readonly<Record<string, string>> | null;
  getEntityMutationVersion?(): number;
};

type Slot = {
  scopeKey: string;
  index: unknown;
  identity: EntityMentionIdentity;
  token: number;
  rebuild: Promise<void> | null;
  entityJob: Promise<void> | null;
  again: boolean;
  followUps: number;
  currentIdentity: () => EntityMentionIdentity;
  buildFull: (abortSignal?: AbortSignal) => Promise<unknown>;
};

const slots = new Map<string, Slot>();
const rebuildsByScope = new Map<string, number>();
let cacheGeneration = 0;

function throwIfMentionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("entity mention rebuild aborted");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deduped(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function sameIdentity(left: EntityMentionIdentity, right: EntityMentionIdentity): boolean {
  return left.mentionEpoch === right.mentionEpoch && left.entityMutation === right.entityMutation;
}

function noteRebuild(scopeKey: string): void {
  rebuildsByScope.set(scopeKey, (rebuildsByScope.get(scopeKey) ?? 0) + 1);
}

function scopeFamily(scopeKey: string): string {
  const nsEnd = scopeKey.indexOf("\u001e");
  const storageEnd = nsEnd === -1 ? -1 : scopeKey.indexOf("\u001e", nsEnd + 1);
  const namespaceKey = nsEnd === -1 ? scopeKey : scopeKey.slice(0, nsEnd);
  const storageKey = nsEnd === -1 || storageEnd === -1 ? "" : scopeKey.slice(nsEnd + 1, storageEnd);
  const dirs = storageKey
    .split("\u001f")
    .map((part) => part.split("\u001d")[0] ?? "")
    .join("\u001f");
  return `${namespaceKey}\u001e${dirs}`;
}

function forgetScope(scopeKey: string): void {
  const slot = slots.get(scopeKey);
  if (slot) {
    slot.token += 1;
    slot.again = false;
  }
  slots.delete(scopeKey);
  rebuildsByScope.delete(scopeKey);
}

function evictOldest(scopeKey: string): void {
  if (slots.size < MAX_SLOTS || slots.has(scopeKey)) return;
  const oldest = slots.keys().next().value;
  if (typeof oldest === "string") forgetScope(oldest);
}

function evictSameFamily(scopeKey: string): void {
  const family = scopeFamily(scopeKey);
  for (const key of [...slots.keys()]) {
    if (key !== scopeKey && scopeFamily(key) === family) forgetScope(key);
  }
}

function armRebuild(slot: Slot): void {
  // A recall that arrives while a scan is already running must not grant
  // another follow-up. The chain stops after the one already armed.
  if (!slot.rebuild) slot.followUps = 1;
  startRebuild(slot);
}

function startRebuild(slot: Slot): void {
  if (slot.rebuild) {
    slot.again = true;
    return;
  }
  const token = slot.token;
  noteRebuild(slot.scopeKey);
  const started = slot.currentIdentity();
  slot.again = false;
  const handle: { pending: Promise<void> | null } = { pending: null };
  handle.pending = slot
    .buildFull(undefined)
    .then((index) => {
      if (slot.token !== token) return;
      const ended = slot.currentIdentity();
      slot.index = index;
      if (sameIdentity(started, ended)) {
        slot.identity = ended;
        return;
      }
      // Scan overlapped later writes. Keep the start identity so the next
      // recall stays stale and exactly one follow-up reconcile runs.
      slot.identity = started;
      slot.again = true;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`entity mention index rebuild failed: ${message}`);
    })
    .finally(() => {
      if (slot.rebuild === handle.pending) slot.rebuild = null;
      // One automatic follow-up per caller-started rebuild. A store that keeps
      // changing during every scan waits for the next recall (or settle) instead
      // of chaining full scans with nobody waiting.
      if (!slot.again || slot.followUps <= 0) return;
      slot.again = false;
      slot.followUps -= 1;
      startRebuild(slot);
    });
  slot.rebuild = handle.pending;
}

export function entityMentionScopeKey(
  namespaces: readonly string[] | undefined,
  storages: readonly ScopedStorage[],
  nativeRevision: string,
): string {
  const namespaceKey = deduped(namespaces ?? []).join("\u001f");
  const storageKey = storages
    .map((storage) => {
      const aliases = Object.entries(storage.entityAliases ?? {}).sort(([left], [right]) =>
        compareStrings(left, right),
      );
      return `${path.resolve(storage.dir)}\u001d${storage.hotCacheKeyId?.() ?? ""}\u001d${JSON.stringify(aliases)}`;
    })
    .join("\u001f");
  return `${namespaceKey}\u001e${storageKey}\u001e${nativeRevision}`;
}

export function entityMentionIdentity(storages: readonly ScopedStorage[]): EntityMentionIdentity {
  return {
    mentionEpoch: storages.map((storage) => String(entityMentionEpoch.current(storage.dir))).join("\u001f"),
    entityMutation: storages.map((storage) => String(storage.getEntityMutationVersion?.() ?? 0)).join("\u001f"),
  };
}

export function entityMentionFullRebuildsStarted(scopeKey: string): number {
  return rebuildsByScope.get(scopeKey) ?? 0;
}

export function entityMentionIndexScopeKeys(): string[] {
  return [...slots.keys()];
}

export function dropEntityMentionIndexCache(scopeKey?: string): void {
  cacheGeneration += 1;
  if (scopeKey === undefined) {
    for (const key of [...slots.keys()]) forgetScope(key);
    return;
  }
  forgetScope(scopeKey);
}

export async function settleEntityMentionIndex(scopeKey?: string): Promise<void> {
  const matches = (slot: Slot) => scopeKey === undefined || slot.scopeKey === scopeKey;
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    for (const slot of slots.values()) {
      if (!matches(slot)) continue;
      if (!slot.rebuild && slot.again) {
        slot.again = false;
        startRebuild(slot);
      }
    }
    const pending = [...slots.values()].filter((slot) => matches(slot) && slot.rebuild).map((slot) => slot.rebuild!);
    if (pending.length === 0) return;
    await Promise.all(pending);
  }
}

export async function resolveEntityMentionIndex<T>(options: {
  scopeKey: string;
  currentIdentity: () => EntityMentionIdentity;
  buildFull: (abortSignal?: AbortSignal) => Promise<T>;
  rebuildEntities: (previous: T, abortSignal?: AbortSignal) => Promise<T>;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const live = options.currentIdentity();
  const existing = slots.get(options.scopeKey);
  if (!existing) {
    evictSameFamily(options.scopeKey);
    evictOldest(options.scopeKey);
    noteRebuild(options.scopeKey);
    const generation = cacheGeneration;
    const started = options.currentIdentity();
    const index = await options.buildFull(options.abortSignal);
    // clearAllStaticCaches during this first scan must not publish the pre-clear index.
    if (generation !== cacheGeneration) return index;
    const ended = options.currentIdentity();
    evictSameFamily(options.scopeKey);
    evictOldest(options.scopeKey);
    const slot: Slot = {
      scopeKey: options.scopeKey,
      index,
      identity: sameIdentity(started, ended) ? ended : started,
      token: 0,
      rebuild: null,
      entityJob: null,
      again: false,
      followUps: 0,
      currentIdentity: options.currentIdentity,
      buildFull: options.buildFull,
    };
    slots.set(options.scopeKey, slot);
    if (!sameIdentity(started, ended)) armRebuild(slot);
    return index;
  }
  existing.currentIdentity = options.currentIdentity;
  existing.buildFull = options.buildFull;
  while (existing.identity.entityMutation !== options.currentIdentity().entityMutation) {
    throwIfMentionAborted(options.abortSignal);
    const pending = existing.entityJob;
    if (pending) {
      await raceAbort(pending, options.abortSignal, "entity mention rebuild aborted");
      continue;
    }
    const liveNow = options.currentIdentity();
    const epochBefore = existing.identity.mentionEpoch;
    const mutationBefore = liveNow.entityMutation;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    existing.entityJob = gate;
    existing.token += 1;
    existing.again = false;
    // Shared scan. This caller's abort stops its wait and leaves the scan
    // running. Publish when the scan settles, even if this caller has left.
    const scan = options.rebuildEntities(existing.index as T, undefined);
    void scan
      .then(
        (rebuilt) => {
          const now = options.currentIdentity();
          existing.index = rebuilt;
          const epochStable = epochBefore === liveNow.mentionEpoch && epochBefore === now.mentionEpoch;
          const mutationStable = mutationBefore === now.entityMutation;
          existing.identity = {
            entityMutation: mutationStable ? now.entityMutation : mutationBefore,
            mentionEpoch: epochStable ? now.mentionEpoch : epochBefore,
          };
          if (existing.identity.mentionEpoch !== now.mentionEpoch) armRebuild(existing);
        },
        () => {},
      )
      .finally(() => {
        if (existing.entityJob === gate) existing.entityJob = null;
        release();
      });
    const rebuilt = await raceAbort(scan, options.abortSignal, "entity mention rebuild aborted");
    throwIfMentionAborted(options.abortSignal);
    return rebuilt;
  }
  if (existing.identity.mentionEpoch !== live.mentionEpoch) {
    armRebuild(existing);
    return existing.index as T;
  }
  return existing.index as T;
}

entityMentionEpoch.registerReset(() => {
  dropEntityMentionIndexCache();
});
