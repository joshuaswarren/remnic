// Changeset-side generation atomicity for offline sync (issue #3150).
// Split from offline-sync-embedding-generation.ts to respect the 1200-line
// new-file cap: the snapshot-side transaction machinery stays there, this
// module owns the CHANGESET protocol — the `embeddingGenerations` manifest
// (sender-side builder + receiver-side validation) and the routing that
// applies manifested generations through the shared locked atomic swap.
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import {
  EmbeddingIndexStorageError,
} from "./embedding-index-storage.js";
import {
  EMBEDDING_SHARD_DIR_BASENAME,
  applyEmbeddingGenerationRemoval,
  applyEmbeddingGenerationTransaction,
  embeddingGenerationMembership,
  embeddingShardDirOf,
  isEmbeddingGenerationDirPath,
  type EmbeddingGenerationTransactionInput,
  type EmbeddingGenerationTransactionIo,
  type EmbeddingGenerationTransactionResult,
} from "./offline-sync-embedding-generation.js";
import { EMBEDDING_SHARD_FILE_PATTERN } from "./offline-sync-runtime-state.js";
import type {
  OfflineSyncChange,
  OfflineSyncConflict,
  OfflineSyncFileDeleteTarget,
  OfflineSyncFileStagingReadTarget,
  OfflineSyncFileStagingWriteTarget,
  OfflineSyncFileState,
} from "./offline-sync.js";
import { type SafeArchiveRoot, resolveSafeArchiveTarget } from "./transfer/fs-utils.js";

const EMBEDDING_MARKER_BASENAME = "embeddings.json";

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await lstat(absPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Changeset-side generation atomicity (issue #3150)
//
// Inline changesets are DIFFS, not complete generations: a push that rewrites
// two of five shards carries only those two records. To reuse the snapshot
// path's single atomic swap without sweeping unchanged shards, the sender
// attaches an `embeddingGenerations` manifest — the COMPLETE post-change
// membership of every touched generation — and the receiver assembles the
// full incoming set: changed members ride inline, unchanged members carry
// over from local bytes hash-verified against the manifest, removed members
// are swept by the swap. Everything below shares the generation lock and the
// secure-staging rules with the snapshot path.
// ---------------------------------------------------------------------------

export interface OfflineSyncChangesetGenerationMember {
  path: string;
  sha256: string;
  bytes: number;
}

/** Complete post-change membership of ONE sharded generation. */
export interface OfflineSyncChangesetGeneration {
  /** The generation dir, e.g. `state/embeddings`. */
  shardDir: string;
  members: OfflineSyncChangesetGenerationMember[];
}

type OfflineSyncUpsertChange = Extract<OfflineSyncChange, { type: "upsert" }>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validate the optional `embeddingGenerations` changeset field (receiver
 * boundary). Returns undefined when the field is absent (legacy sender);
 * throws on any incoherence — duplicate dirs or member paths, noncanonical
 * dirs, members outside their dir, or a manifested generation that does not
 * account for every upserted shard — so bad manifests fail closed BEFORE any
 * apply-time write.
 */
export function normalizeChangesetGenerations(
  raw: unknown,
  changes: readonly OfflineSyncChange[],
): OfflineSyncChangesetGeneration[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("offline sync changeset embeddingGenerations must be an array");
  }
  const dirs = new Set<string>();
  const generations: OfflineSyncChangesetGeneration[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("offline sync changeset embeddingGenerations entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    const shardDir = typeof record.shardDir === "string" ? record.shardDir : "";
    if (!isEmbeddingGenerationDirPath(shardDir)) {
      throw new Error(`offline sync changeset embeddingGenerations shardDir must be a canonical embeddings generation dir: ${shardDir}`);
    }
    if (dirs.has(shardDir)) {
      throw new Error(`offline sync changeset embeddingGenerations has a duplicate shardDir: ${shardDir}`);
    }
    if (!Array.isArray(record.members) || record.members.length === 0) {
      throw new Error(`offline sync changeset embeddingGenerations ${shardDir} must list its complete member set`);
    }
    const memberPaths = new Set<string>();
    const members: OfflineSyncChangesetGenerationMember[] = [];
    for (const rawMember of record.members) {
      if (!rawMember || typeof rawMember !== "object" || Array.isArray(rawMember)) {
        throw new Error(`offline sync changeset embeddingGenerations ${shardDir} members must be objects`);
      }
      const member = rawMember as Record<string, unknown>;
      const memberPath = typeof member.path === "string" ? member.path : "";
      if (embeddingShardDirOf(memberPath) !== shardDir) {
        throw new Error(`offline sync changeset embeddingGenerations member ${memberPath} does not belong to generation ${shardDir}`);
      }
      if (memberPaths.has(memberPath)) {
        throw new Error(`offline sync changeset embeddingGenerations ${shardDir} has a duplicate member: ${memberPath}`);
      }
      if (typeof member.sha256 !== "string" || !SHA256_PATTERN.test(member.sha256)) {
        throw new Error(`offline sync changeset embeddingGenerations member ${memberPath} sha256 must be a lowercase sha256 hex digest`);
      }
      if (typeof member.bytes !== "number" || !Number.isInteger(member.bytes) || member.bytes < 0) {
        throw new Error(`offline sync changeset embeddingGenerations member ${memberPath} bytes must be a non-negative integer`);
      }
      memberPaths.add(memberPath);
      members.push({ path: memberPath, sha256: member.sha256, bytes: member.bytes });
    }
    dirs.add(shardDir);
    generations.push({ shardDir, members });
  }

  // Coherence with the change list: a manifest-bearing sender must account
  // for EVERY upserted shard, and no delete may target a surviving member.
  const memberByPath = new Map<string, OfflineSyncChangesetGenerationMember>();
  for (const generation of generations) {
    for (const member of generation.members) memberByPath.set(member.path, member);
  }
  for (const change of changes) {
    const membership = embeddingGenerationMembership(change.path);
    if (!membership) continue;
    const manifested = memberByPath.get(change.path);
    if (change.type === "upsert") {
      if (membership.kind !== "shard") continue;
      if (!manifested) {
        throw new Error(`offline sync changeset upserts of embedding shards require a manifest entry: ${change.path}`);
      }
      if (manifested.sha256 !== change.file.sha256 || manifested.bytes !== change.file.bytes) {
        throw new Error(`offline sync changeset manifest member ${change.path} does not match the upserted record`);
      }
      continue;
    }
    if (manifested) {
      throw new Error(`offline sync changeset delete of ${change.path} contradicts its manifest membership`);
    }
  }
  return generations;
}

/** Change-list conflicts for a deferred generation: visible, never silent. */
function deferGenerationConflicts(
  dirChanges: readonly OfflineSyncChange[],
  currentMap: ReadonlyMap<string, OfflineSyncFileState>,
  reason: OfflineSyncConflict["reason"],
): { conflicts: OfflineSyncConflict[]; conflictedPaths: Set<string> } {
  const conflicts: OfflineSyncConflict[] = [];
  const conflictedPaths = new Set<string>();
  for (const change of dirChanges) {
    conflictedPaths.add(change.path);
    conflicts.push({
      path: change.path,
      reason,
      ...(change.type === "upsert" ? { incomingSha256: change.file.sha256 } : {}),
      ...(change.baseSha256 !== undefined ? { baseSha256: change.baseSha256 } : {}),
      localSha256: currentMap.get(change.path)?.sha256,
    });
  }
  return { conflicts, conflictedPaths };
}

export interface ChangesetGenerationApplication {
  /** Paths the per-file apply loop must skip (published, swept, or removed). */
  transactionHandled: Set<string>;
  /** Conflicts for deferred generations — surfaced so the push side never
   * checkpoints a deferred generation as applied. */
  conflicts: OfflineSyncConflict[];
  conflictedPaths: Set<string>;
  appliedUpserts: number;
  appliedDeletes: number;
  /** Result-map updates for published members. */
  writtenStates: Map<string, OfflineSyncFileState>;
  /** Result-map removals for swept/removed members. */
  removedPaths: Set<string>;
}

export interface ChangesetGenerationApplyOptions {
  root: SafeArchiveRoot;
  /** NORMALIZED changeset (manifest validated by normalizeChangesetGenerations). */
  changeset: { changes: readonly OfflineSyncChange[]; embeddingGenerations?: readonly OfflineSyncChangesetGeneration[] };
  incomingBuffers: ReadonlyMap<string, Buffer>;
  currentMap: ReadonlyMap<string, OfflineSyncFileState>;
  io: EmbeddingGenerationTransactionIo;
  /** True when the caller supplied ANY custom storage IO — the staging-pair
   * fail-closed rule then applies (mirrors the snapshot apply). */
  customIoPresent: boolean;
  now: number;
}

/** Change-list maps scoped per generation dir. */
type OfflineSyncChangesByDir = Map<string, OfflineSyncChange[]>;

/**
 * Route a changeset's embedding-generation changes through the shared locked
 * transaction: manifested dirs publish atomically (changed members inline,
 * unchanged members carried over, removed members swept), manifested
 * shrink-deletes ride the same swap, full-evidence tombstones remove the
 * whole generation through the removal transaction, and everything that
 * cannot be proven (legacy manifest-less shard upserts, under-lock
 * divergence, remote-only members) is DEFERRED as conflicts with the disk
 * untouched — a mixed generation is never published and the push side never
 * checkpoints a deferred generation as applied.
 */
export async function applyChangesetEmbeddingGenerations(
  options: ChangesetGenerationApplyOptions,
): Promise<ChangesetGenerationApplication> {
  const result: ChangesetGenerationApplication = {
    transactionHandled: new Set(),
    conflicts: [],
    conflictedPaths: new Set(),
    appliedUpserts: 0,
    appliedDeletes: 0,
    writtenStates: new Map(),
    removedPaths: new Set(),
  };
  const manifest = new Map(
    (options.changeset.embeddingGenerations ?? []).map((generation) => [generation.shardDir, generation]),
  );
  const shardUpsertChanges: Map<string, OfflineSyncUpsertChange[]> = new Map();
  const markerUpsertChanges: Map<string, OfflineSyncUpsertChange[]> = new Map();
  const deleteChangesByDir = new Map<string, OfflineSyncChange[]>();
  const dirChanges = new Map<string, OfflineSyncChange[]>();
  for (const change of options.changeset.changes) {
    const membership = embeddingGenerationMembership(change.path);
    if (!membership) continue;
    const dir = membership.shardDir;
    if (!dirChanges.has(dir)) dirChanges.set(dir, []);
    dirChanges.get(dir)!.push(change);
    if (change.type === "upsert") {
      if (membership.kind === "shard") {
        if (!shardUpsertChanges.has(dir)) shardUpsertChanges.set(dir, []);
        shardUpsertChanges.get(dir)!.push(change);
      } else {
        if (!markerUpsertChanges.has(dir)) markerUpsertChanges.set(dir, []);
        markerUpsertChanges.get(dir)!.push(change);
      }
    } else {
      if (!deleteChangesByDir.has(dir)) deleteChangesByDir.set(dir, []);
      deleteChangesByDir.get(dir)!.push(change);
    }
  }

  // Fail closed BEFORE any publication: custom storage IO without the
  // staging pair would stage the incoming generation in plaintext (same rule
  // and message as the snapshot apply).
  if (
    (shardUpsertChanges.size > 0 || markerUpsertChanges.size > 0) &&
    options.customIoPresent &&
    !(options.io.writeStagingFile && options.io.readStagingFile)
  ) {
    throw new EmbeddingIndexStorageError(
      "refusing to replace embedding generation: custom storage IO requires both writeStagingFile and readStagingFile hooks; unencrypted raw staging would plaintext-downgrade the index",
    );
  }

  const runTransaction = async (
    shardDirRel: string,
    input: Omit<EmbeddingGenerationTransactionInput, "root" | "io" | "now">,
  ): Promise<EmbeddingGenerationTransactionResult> => {
    const transaction = await applyEmbeddingGenerationTransaction({
      ...input,
      root: options.root,
      io: options.io,
      now: options.now,
    });
    if (transaction.deferredLocalDivergence) {
      const deferred = deferGenerationConflicts(
        dirChanges.get(shardDirRel) ?? [],
        options.currentMap,
        "embedding_generation_diverged",
      );
      result.conflicts.push(...deferred.conflicts);
      for (const conflicted of deferred.conflictedPaths) result.conflictedPaths.add(conflicted);
      return transaction;
    }
    result.appliedUpserts += transaction.upserted;
    result.appliedDeletes += transaction.deleted;
    for (const [relPath, state] of transaction.writtenStates) {
      result.writtenStates.set(relPath, state);
      result.transactionHandled.add(relPath);
    }
    for (const relPath of transaction.removedPaths) {
      result.removedPaths.add(relPath);
      result.transactionHandled.add(relPath);
    }
    return transaction;
  };

  /** Incoming set + reconstructed shared base for ONE manifested generation. */
  const manifestedInput = (
    shardDirRel: string,
    generation: OfflineSyncChangesetGeneration,
  ): Omit<EmbeddingGenerationTransactionInput, "root" | "io" | "now"> => {
    const upsertByPath = new Map(
      (shardUpsertChanges.get(shardDirRel) ?? []).map((change: OfflineSyncUpsertChange) => [change.path, change]),
    );
    const memberByPath = new Map(generation.members.map((member) => [member.path, member]));
    const incomingShardPaths = generation.members.map((member) => member.path).sort();
    const tombstones = (deleteChangesByDir.get(shardDirRel) ?? [])
      .filter((change): change is Extract<OfflineSyncChange, { type: "delete" }> => change.type === "delete");
    const baseStates = new Map<string, { sha256: string }>();
    for (const member of generation.members) {
      const change = upsertByPath.get(member.path);
      if (change) {
        if (change.baseSha256 !== undefined) baseStates.set(member.path, { sha256: change.baseSha256 });
        continue;
      }
      // Unchanged member: the manifest digest IS its shared-base evidence.
      baseStates.set(member.path, { sha256: member.sha256 });
    }
    for (const change of tombstones) {
      baseStates.set(change.path, { sha256: change.baseSha256 });
    }
    return {
      shardDirRel,
      incomingShardPaths,
      incomingMarker: null,
      incomingMarkerPresent: markerUpsertChanges.has(shardDirRel),
      incomingShardStates: new Map(
        incomingShardPaths.map((relPath) => [relPath, {
          path: relPath,
          sha256: upsertByPath.get(relPath)?.file.sha256 ?? memberByPath.get(relPath)!.sha256,
          bytes: memberByPath.get(relPath)!.bytes,
          mtimeMs: options.now,
        } satisfies OfflineSyncFileState]),
      ),
      incomingBuffers: options.incomingBuffers,
      baseStates,
      // Manifested deletes are pre-authorized removals: the retry after a
      // response loss must re-apply idempotently instead of diverging
      // (#3150 review), and the swept members need their deletion revisions
      // recorded after the swap (the per-file loop never sees them).
      justifiedRemovals: new Set(tombstones.map((change) => change.path)),
      deletionMtimeByPath: new Map(
        tombstones
          .filter((change) => change.mtimeMs !== undefined)
          .map((change) => [change.path, change.mtimeMs as number]),
      ),
      // All-manifested members base-less = the sender claims a fresh
      // creation; an existing local generation must match exactly or defer.
      freshCreateClaim: baseStates.size === 0,
    };
  };

  const stateDirSuffix = `/${EMBEDDING_SHARD_DIR_BASENAME}`;
  const allDirs = new Set<string>([
    ...shardUpsertChanges.keys(),
    ...markerUpsertChanges.keys(),
    ...deleteChangesByDir.keys(),
  ]);
  for (const shardDirRel of [...allDirs].sort()) {
    const generation = manifest.get(shardDirRel);
    if (shardUpsertChanges.has(shardDirRel) || (generation && deleteChangesByDir.has(shardDirRel))) {
      if (!generation) {
        // Legacy sender: shard upserts without a manifest cannot prove
        // complete membership — defer instead of risking a mixed generation.
        const deferred = deferGenerationConflicts(
          dirChanges.get(shardDirRel) ?? [],
          options.currentMap,
          "embedding_generation_manifest_required",
        );
        result.conflicts.push(...deferred.conflicts);
        for (const conflicted of deferred.conflictedPaths) result.conflictedPaths.add(conflicted);
        continue;
      }
      await runTransaction(shardDirRel, manifestedInput(shardDirRel, generation));
      continue;
    }
    if (markerUpsertChanges.has(shardDirRel)) {
      // Cross-layout: an incoming legacy marker replaces the generation as a
      // whole. No manifest exists (post-change membership is the marker), so
      // base evidence comes from the marker change alone; a receiver-local
      // sharded generation the marker base cannot account for defers via the
      // transaction's under-lock census check rather than being swept.
      const markerChange = (markerUpsertChanges.get(shardDirRel) ?? [])[0] as OfflineSyncUpsertChange | undefined;
      if (!markerChange) continue;
      const stateDirRel = shardDirRel.slice(0, -stateDirSuffix.length);
      const markerRel = `${stateDirRel}/${EMBEDDING_MARKER_BASENAME}`;
      const transaction = await runTransaction(shardDirRel, {
        shardDirRel,
        incomingShardPaths: [],
        incomingMarker: {
          path: markerRel,
          sha256: markerChange.file.sha256,
          buffer: options.incomingBuffers.get(markerRel) ?? null,
        },
        incomingMarkerPresent: false,
        incomingShardStates: new Map(),
        incomingBuffers: options.incomingBuffers,
        baseStates: markerChange.baseSha256 === undefined
          ? undefined
          : new Map([[markerRel, { sha256: markerChange.baseSha256 }]]),
      });
      // The conversion consumes the marker change whole: on a published
      // transaction the per-file loop must not re-write the legacy marker
      // outside the atomic swap (#3150 review). On deferral the marker
      // change is already in conflictedPaths, so it stays uncheckpointed.
      if (!transaction.deferredLocalDivergence) result.transactionHandled.add(markerRel);
      continue;
    }
    // Delete-only without a manifest: whole-generation removal ONLY when the
    // changeset tombstones EVERY local member (complete evidence, mirrors the
    // snapshot rule). Incomplete manifest-less deletion evidence defers the
    // whole directory as `embedding_generation_manifest_required` conflicts;
    // the complete published generation survives and is never broken apart by
    // independent shard deletes. Only non-generation files keep per-file deletes.
    const deletes = deleteChangesByDir.get(shardDirRel) ?? [];
    const deletePaths = new Set(deletes.map((change) => change.path));
    const stateDirRel = shardDirRel.slice(0, -stateDirSuffix.length);
    const markerRel = `${stateDirRel}/${EMBEDDING_MARKER_BASENAME}`;
    const localMembers: string[] = [];
    if (await pathExists(await resolveSafeArchiveTarget(options.root, markerRel))) localMembers.push(markerRel);
    let localShardNames: string[] = [];
    try {
      localShardNames = (await readdir(await resolveSafeArchiveTarget(options.root, shardDirRel)))
        .filter((name) => EMBEDDING_SHARD_FILE_PATTERN.test(name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const name of localShardNames) localMembers.push(`${shardDirRel}/${name}`);
    if (localMembers.length === 0) continue;
    if (!localMembers.every((relPath) => deletePaths.has(relPath))) {
      // Incomplete deletion evidence: applying the evidenced subset would
      // break the local generation apart. Defer the WHOLE dir as conflicts —
      // the complete published generation survives and the push side cannot
      // checkpoint the deletes as applied.
      const deferred = deferGenerationConflicts(deletes, options.currentMap, "embedding_generation_manifest_required");
      result.conflicts.push(...deferred.conflicts);
      for (const conflicted of deferred.conflictedPaths) result.conflictedPaths.add(conflicted);
      continue;
    }
    const tombstones = deletes.filter((change): change is Extract<OfflineSyncChange, { type: "delete" }> => change.type === "delete");
    const removal = await applyEmbeddingGenerationRemoval({
      root: options.root,
      shardDirRel,
      io: { deleteFile: options.io.deleteFile, readFile: options.io.readFile },
      deletionMtimeByPath: new Map(
        tombstones
          .filter((change) => change.mtimeMs !== undefined)
          .map((change) => [change.path, change.mtimeMs as number]),
      ),
      baseStates: new Map(tombstones.map((change) => [change.path, { sha256: change.baseSha256 }])),
      now: options.now,
    });
    if (removal.deferredLocalDivergence) {
      const deferred = deferGenerationConflicts(deletes, options.currentMap, "embedding_generation_diverged");
      result.conflicts.push(...deferred.conflicts);
      for (const conflicted of deferred.conflictedPaths) result.conflictedPaths.add(conflicted);
      continue;
    }
    result.appliedDeletes += removal.deleted;
    for (const relPath of removal.removedPaths) {
      result.removedPaths.add(relPath);
      result.transactionHandled.add(relPath);
    }
  }
  return result;
}

export interface ChangesetGenerationManifestOptions {
  changes: readonly OfflineSyncChange[];
  /** The sender's complete current state (post-change generation members). */
  currentFiles: readonly OfflineSyncFileState[];
  baseFiles: readonly OfflineSyncFileState[];
  /** The exact exclusion predicate the change walk used — any member it
   * drops forces whole-generation omission (filter-to-omit, #3148). */
  isExcluded: (relPath: string) => boolean;
}

/**
 * Sender side: complete post-change membership for every generation touched
 * by the changeset. A touched generation with ANY excluded member is omitted
 * WHOLE — its changes are dropped by the caller contract below and no
 * manifest is emitted — so a filtered generation can never look like a
 * partial replacement on the receiver.
 */
export function buildChangesetGenerationManifest(
  options: ChangesetGenerationManifestOptions,
): OfflineSyncChangesetGeneration[] {
  const currentByPath = new Map(options.currentFiles.map((state) => [state.path, state]));
  const baseByPath = new Map(options.baseFiles.map((state) => [state.path, state]));
  const touchedDirs = new Map<string, OfflineSyncChange[]>();
  for (const change of options.changes) {
    const membership = embeddingGenerationMembership(change.path);
    if (membership) {
      if (!touchedDirs.has(membership.shardDir)) touchedDirs.set(membership.shardDir, []);
      touchedDirs.get(membership.shardDir)!.push(change);
    }
  }
  const generations: OfflineSyncChangesetGeneration[] = [];
  for (const [shardDirRel, changes] of [...touchedDirs].sort(([left], [right]) => left.localeCompare(right))) {
    const memberPaths = new Set<string>();
    for (const relPath of currentByPath.keys()) {
      const membership = embeddingGenerationMembership(relPath);
      if (membership?.shardDir === shardDirRel) memberPaths.add(relPath);
    }
    for (const relPath of baseByPath.keys()) {
      const membership = embeddingGenerationMembership(relPath);
      if (membership?.shardDir === shardDirRel) memberPaths.add(relPath);
    }
    for (const change of changes) memberPaths.add(change.path);
    // Filter-to-omit: one excluded member omits the whole generation.
    let omitted = false;
    for (const relPath of memberPaths) {
      if (options.isExcluded(relPath)) {
        omitted = true;
        break;
      }
    }
    if (omitted) continue;
    const members = [...memberPaths]
      .filter((relPath) => currentByPath.has(relPath))
      .sort()
      .map((relPath) => {
        const state = currentByPath.get(relPath)!;
        return { path: state.path, sha256: state.sha256, bytes: state.bytes };
      });
    if (members.length === 0) continue;
    generations.push({ shardDir: shardDirRel, members });
  }
  return generations;
}
