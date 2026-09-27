// Embedding-index generation semantics for offline sync (issue #3146, PR
// #3148). Extracted from offline-sync.ts so the god-file line-count ratchet
// does not grow when the rules gain behavior. The snapshot walker treats
// every `state/embeddings/` shard set — or a legacy `state/embeddings.json`
// marker — as ONE generation, in both directions:
//
//   1. Atomic replacement (apply side): an incoming generation is staged
//      complete, verified byte-for-byte, and published through the store's
//      single backup-swap state machine. A crash or write failure can never
//      leave a mix of the local and incoming generation on disk, and a
//      local-only shard of a replaced generation is removed by the swap, not
//      merged into the incoming set.
//   2. Filter-to-omit, never filter-to-delete (push side): when an exclusion
//      filter removes ANY member of a local generation from a push, the
//      WHOLE generation is omitted — files and deletion metadata — and the
//      receiver keeps its copy. A filtered generation must never look
//      deleted, and a partially filtered snapshot must never look like a
//      complete generation.
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type EmbeddingIndexFile,
  EmbeddingIndexFileStore,
  type EmbeddingIndexIdentity,
  type EmbeddingIndexStoreIo,
  EmbeddingIndexStorageError,
  parseEmbeddingIndexDocument,
  serializeEmbeddingShard,
  shardEntriesForIndex,
} from "./embedding-index-storage.js";
import type { OfflineSyncExcludeFile, OfflineSyncFileTarget } from "./offline-sync-file-io.js";
import { EMBEDDING_SHARD_FILE_PATTERN } from "./offline-sync-runtime-state.js";
import type {
  OfflineSyncFileDeleteTarget,
  OfflineSyncFileStagingReadTarget,
  OfflineSyncFileStagingWriteTarget,
  OfflineSyncFileState,
} from "./offline-sync.js";
import { type SafeArchiveRoot, resolveSafeArchiveTarget } from "./transfer/fs-utils.js";

const EMBEDDING_MARKER_BASENAME = "embeddings.json";
export const EMBEDDING_SHARD_DIR_BASENAME = "embeddings";

/**
 * Canonical `state` dir prefix ("state" or "namespaces/<ns>/state") for a
 * path's segments, or null when the path is not canonical runtime state.
 */
function canonicalStateDirPrefix(parts: string[]): string | null {
  if (parts[0] === "state") return "state";
  if (parts[0] === "namespaces" && parts.length >= 4 && parts[2] === "state") {
    return `namespaces/${parts[1]}/state`;
  }
  return null;
}

/** The sharded-generation directory when `relPath` is one of its shards. */
export function embeddingShardDirOf(relPath: string): string | null {
  const parts = relPath.split("/");
  if (parts.length < 3) return null;
  if (!EMBEDDING_SHARD_FILE_PATTERN.test(parts[parts.length - 1] ?? "")) return null;
  if (parts[parts.length - 2] !== EMBEDDING_SHARD_DIR_BASENAME) return null;
  if (canonicalStateDirPrefix(parts) === null) return null;
  return parts.slice(0, -1).join("/");
}

/**
 * True when `dirPath` is a canonical embeddings generation dir
 * (`state/embeddings` or `namespaces/<ns>/state/embeddings`). Encodes the
 * snapshot-field shape contract without a ReDoS-shaped literal (issue #2439).
 */
export function isEmbeddingGenerationDirPath(dirPath: string): boolean {
  const membership = embeddingGenerationMembership(`${dirPath}/shard-0000.json`);
  return membership !== null && membership.shardDir === dirPath;
}

/** The state dir when `relPath` is the legacy single-file marker. */
export function embeddingMarkerDirOf(relPath: string): string | null {
  const parts = relPath.split("/");
  if ((parts[parts.length - 1] ?? "") !== EMBEDDING_MARKER_BASENAME) return null;
  if (canonicalStateDirPrefix(parts) === null) return null;
  return parts.slice(0, -1).join("/");
}

/**
 * Membership of `relPath` in an embedding generation: shards belong to their
 * `.../embeddings` directory, the legacy marker belongs to the sibling
 * `.../embeddings` directory of its state dir.
 */
export function embeddingGenerationMembership(relPath: string): { kind: "shard" | "marker"; shardDir: string } | null {
  const shardDir = embeddingShardDirOf(relPath);
  if (shardDir) return { kind: "shard", shardDir };
  const markerDir = embeddingMarkerDirOf(relPath);
  if (markerDir) return { kind: "marker", shardDir: `${markerDir}/${EMBEDDING_SHARD_DIR_BASENAME}` };
  return null;
}

export interface IncomingEmbeddingGenerations {
  /** Generation dirs with at least one incoming shard. */
  shardDirs: Set<string>;
  /** State dirs whose incoming snapshot carries the legacy marker. */
  legacyMarkerDirs: Set<string>;
}

/** Classify incoming snapshot paths into embedding generations. */
export function detectIncomingEmbeddingGenerations(incomingPaths: Iterable<string>): IncomingEmbeddingGenerations {
  const shardDirs = new Set<string>();
  const legacyMarkerDirs = new Set<string>();
  for (const relPath of incomingPaths) {
    const membership = embeddingGenerationMembership(relPath);
    if (!membership) continue;
    if (membership.kind === "shard") shardDirs.add(membership.shardDir);
    else legacyMarkerDirs.add(membership.shardDir);
  }
  return { shardDirs, legacyMarkerDirs };
}

function shardRelPath(shardDirRel: string, shardIndex: number): string {
  return `${shardDirRel}/shard-${String(shardIndex).padStart(4, "0")}.json`;
}

function describeIndexReadFailure(
  read: { outcome: "absent" } | { outcome: "foreign" } | { outcome: "unreadable"; reason: string }
): string {
  if (read.outcome === "unreadable") return read.reason;
  if (read.outcome === "foreign") return "unrecognized index format";
  return "generation document is absent";
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await lstat(absPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export interface EmbeddingGenerationTransactionIo {
  /** Storage-backed local read: hydrates unchanged shards (metadata-only
   * pulls skip their content) and decrypts secure-store files. */
  readFile?: (target: OfflineSyncFileTarget) => Promise<Buffer>;
  writeStagingFile?: (target: OfflineSyncFileStagingWriteTarget) => Promise<void>;
  readStagingFile?: (target: OfflineSyncFileStagingReadTarget) => Promise<Buffer>;
  deleteFile?: (target: OfflineSyncFileDeleteTarget) => Promise<void>;
}

export interface EmbeddingGenerationTransactionInput {
  root: SafeArchiveRoot;
  /** The generation dir, e.g. `state/embeddings`. */
  shardDirRel: string;
  /** Incoming shard rel paths — the complete incoming sharded generation. */
  incomingShardPaths: string[];
  /** Incoming legacy marker (rel path + verified content), when the
   * incoming generation is legacy-layout. Mutually exclusive with
   * `incomingShardPaths`. */
  incomingMarker: { path: string; buffer: Buffer } | null;
  /** True when the incoming snapshot ALSO carries the legacy marker while
   * shards form the generation (mixed remote): the per-file loop then writes
   * the marker as the inert remote artifact, so this transaction must NOT
   * remove a local marker. */
  incomingMarkerPresent: boolean;
  /** Incoming shard records (sha256 for local hydration of unchanged
   * metadata-only pulls). */
  incomingShardStates: ReadonlyMap<string, OfflineSyncFileState>;
  /** Verified incoming content by rel path (absent for shards the metadata
   * hydration skipped because the local hash already matches). */
  incomingBuffers: ReadonlyMap<string, Buffer>;
  io: EmbeddingGenerationTransactionIo;
  now: number;
}

export interface EmbeddingGenerationTransactionResult {
  upserted: number;
  deleted: number;
  /** nextBase states for files the transaction published. */
  writtenStates: Map<string, OfflineSyncFileState>;
  /** nextBase paths the transaction removed (stale shards, demoted marker). */
  removedPaths: Set<string>;
  /** Paths the per-file apply loop must skip — all handled here. */
  handledPaths: Set<string>;
}

/**
 * Apply ONE incoming embedding generation atomically (issue #3148, round 4):
 * recover an interrupted replacement, validate the complete incoming
 * generation (legacy markers are converted to the sharded layout so the
 * one-way layout is preserved), stage it, verify the staged bytes, then
 * publish through the shared backup-swap. Any failure before the swap leaves
 * the local generation untouched; a crash in the swap gap is rolled back by
 * the store's recovery on next use.
 */
export async function applyEmbeddingGenerationTransaction(
  input: EmbeddingGenerationTransactionInput
): Promise<EmbeddingGenerationTransactionResult> {
  const { root, shardDirRel, io } = input;
  const stateDirRel = shardDirRel.slice(0, -`/${EMBEDDING_SHARD_DIR_BASENAME}`.length);
  const markerRel = `${stateDirRel}/${EMBEDDING_MARKER_BASENAME}`;
  const shardDirAbs = await resolveSafeArchiveTarget(root, shardDirRel);
  const markerAbs = await resolveSafeArchiveTarget(root, markerRel);
  const store = new EmbeddingIndexFileStore(
    markerAbs,
    shardDirAbs,
    await resolveSafeArchiveTarget(root, `${stateDirRel}/embedding-fallback-status.json`)
  );

  // 1. Close a pending rename gap (old generation restored) before staging:
  //    the swap below must never build on a half-replaced generation. The
  //    fixed backup path is validated first: a planted symlink (or any
  //    escape) must fail closed instead of being renamed into the published
  //    position or removed through. The restored target is re-resolved so a
  //    symlinked restoration cannot slip past the subsequent IO.
  const backupRel = `${stateDirRel}/embeddings.pre-replace.tmp`;
  await resolveSafeArchiveTarget(root, backupRel);
  if (await store.recoverIfInterrupted()) {
    await resolveSafeArchiveTarget(root, shardDirRel);
  }

  // 2. Build the complete incoming generation (final rel path → plaintext
  //    bytes) and validate every document BEFORE touching local state.
  const published = new Map<string, Buffer>();
  let identity: EmbeddingIndexIdentity | null = null;
  if (input.incomingMarker) {
    const read = parseEmbeddingIndexDocument(input.incomingMarker.buffer.toString("utf-8"));
    if (read.outcome !== "ok") {
      throw new EmbeddingIndexStorageError(
        `refusing incoming embedding index generation ${markerRel}: ${describeIndexReadFailure(read)}; local generation preserved`
      );
    }
    identity = { provider: read.file.provider, model: read.file.model };
    const groups = shardEntriesForIndex(read.file);
    for (const [shardIndex, entries] of groups) {
      if (Object.keys(entries).length === 0) continue;
      published.set(
        shardRelPath(shardDirRel, shardIndex),
        Buffer.from(serializeEmbeddingShard(read.file, shardIndex, entries), "utf-8")
      );
    }
  } else {
    for (const relPath of input.incomingShardPaths) {
      let buffer = input.incomingBuffers.get(relPath);
      if (!buffer) {
        // Metadata-only pulls skip content whose local hash already matches
        // the incoming record: the LOCAL bytes ARE the incoming content, so
        // read and hash-verify them instead of failing (codex round 5).
        const state = input.incomingShardStates.get(relPath);
        if (!state) {
          throw new EmbeddingIndexStorageError(`missing incoming content for ${relPath}`);
        }
        const local = input.io.readFile
          ? await input.io.readFile({ root: root.abs, path: relPath, filePath: await resolveSafeArchiveTarget(root, relPath) })
          : await readFile(await resolveSafeArchiveTarget(root, relPath));
        if (sha256Hex(local) !== state.sha256) {
          throw new EmbeddingIndexStorageError(
            `cannot hydrate unchanged embedding index shard ${relPath}: local digest does not match the incoming record; local generation preserved`,
          );
        }
        buffer = local;
      }
      const read = parseEmbeddingIndexDocument(buffer.toString("utf-8"));
      if (read.outcome !== "ok") {
        throw new EmbeddingIndexStorageError(
          `refusing incoming embedding index shard ${relPath}: ${describeIndexReadFailure(read)}; local generation preserved`
        );
      }
      const shardIdentity = { provider: read.file.provider, model: read.file.model };
      if (!identity) identity = shardIdentity;
      if (identity.provider !== shardIdentity.provider || identity.model !== shardIdentity.model) {
        throw new EmbeddingIndexStorageError(
          `refusing mixed-identity incoming embedding index generation in ${shardDirRel}: ${relPath} is ${shardIdentity.provider}/${shardIdentity.model} but the generation is ${identity.provider}/${identity.model}; local generation preserved`
        );
      }
      published.set(relPath, buffer);
    }
    if (published.size === 0) {
      throw new EmbeddingIndexStorageError(
        `incoming embedding index generation ${shardDirRel} is empty; local generation preserved`
      );
    }
  }

  const stagingRel = `${stateDirRel}/embeddings.staging.tmp-sync-${process.pid}-${input.now}-${randomBytes(8).toString("hex")}`;
  const stagingAbs = await resolveSafeArchiveTarget(root, stagingRel);
  try {
    await mkdir(stagingAbs, { recursive: true });

    // 3. Stage the complete generation. With storage-backed IO the staged
    //    ciphertext binds its FINAL canonical path (`aadRelPath`), so after
    //    the directory swap it decrypts at the published path — a physical
    //    staging-path AAD would make the published generation unreadable.
    for (const [relPath, buffer] of published) {
      const stagedRel = `${stagingRel}/${path.basename(relPath)}`;
      const stagedAbs = await resolveSafeArchiveTarget(root, stagedRel);
      const finalAbs = await resolveSafeArchiveTarget(root, relPath);
      if (io.writeStagingFile) {
        await io.writeStagingFile({
          root: root.abs,
          path: stagedRel,
          filePath: stagedAbs,
          content: buffer,
          finalAadFilePath: finalAbs,
        });
      } else {
        await writeFile(stagedAbs, buffer, { mode: 0o600 });
      }
    }

    // 4. Verify the staged bytes against the incoming content before the
    //    published generation is touched at all.
    for (const [relPath, buffer] of published) {
      const stagedRel = `${stagingRel}/${path.basename(relPath)}`;
      const stagedAbs = await resolveSafeArchiveTarget(root, stagedRel);
      const staged = io.readStagingFile
        ? await io.readStagingFile({
            root: root.abs,
            path: stagedRel,
            filePath: stagedAbs,
            finalAadFilePath: await resolveSafeArchiveTarget(root, relPath),
          })
        : await readFile(stagedAbs);
      if (!staged.equals(buffer)) {
        throw new EmbeddingIndexStorageError(
          `staged embedding index file ${stagedRel} does not match the incoming content; local generation preserved`
        );
      }
    }

    // 5. Publish with the ONE swap state machine shared with persist(). The
    //    old directory moves aside wholesale, so local shards absent from
    //    the incoming generation are removed by the swap — never merged.
    const localShardRels = (
      await readdir(shardDirAbs).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
        throw err;
      })
    )
      .filter((name) => EMBEDDING_SHARD_FILE_PATTERN.test(name))
      .map((name) => `${shardDirRel}/${name}`)
      .sort();
    await store.publishSwappedGeneration(stagingAbs);

    const writtenStates = new Map<string, OfflineSyncFileState>();
    for (const [relPath, buffer] of published) {
      writtenStates.set(relPath, {
        path: relPath,
        sha256: sha256Hex(buffer),
        bytes: buffer.length,
        mtimeMs: input.now,
      });
    }
    const removedPaths = new Set<string>(localShardRels.filter((rel) => !published.has(rel)));
    let deleted = removedPaths.size;
    if ((await pathExists(markerAbs)) && !input.incomingMarker && !input.incomingMarkerPresent) {
      // A sharded incoming generation replaces the local legacy generation
      // wholesale: the demoted marker is stale bytes beside a published
      // directory that never reads it. Remove it through the same delete
      // hook the per-file deletion path uses.
      if (io.deleteFile) {
        await io.deleteFile({ root: root.abs, path: markerRel, filePath: markerAbs });
      } else {
        await rm(markerAbs, { force: true });
      }
      removedPaths.add(markerRel);
      deleted += 1;
    }
    return {
      upserted: published.size,
      deleted,
      writtenStates,
      removedPaths,
      handledPaths: new Set([...published.keys(), ...removedPaths]),
    };
  } catch (err) {
    await rm(stagingAbs, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Push-side whole-generation omission
// ---------------------------------------------------------------------------

export interface EmbeddingGenerationOmissionOptions {
  rootAbs: string;
  userExcludeRegexps?: readonly RegExp[];
  excludeFile?: OfflineSyncExcludeFile;
  /**
   * Per-path push exclusion predicate (structural + node-local defaults +
   * user regexps), owned by offline-sync.ts so the filter semantics can
   * never drift from the walk that consumes the result.
   */
  isExcludedRelPath: (relPath: string) => boolean;
}

export interface EmbeddingGenerationOmission {
  /** Existing member paths omitted because their generation is partial. */
  omittedPaths: Set<string>;
  /** Generation dirs whose members are omitted (snapshot field value). */
  omittedDirs: string[];
}

/**
 * Compute the push-side whole-generation omission set: when ANY on-disk
 * member of an embedding generation is excluded by a push filter, EVERY
 * member of that generation is omitted (issue #3148, round 4).
 */
export async function computeOmittedEmbeddingGenerationPaths(
  options: EmbeddingGenerationOmissionOptions
): Promise<EmbeddingGenerationOmission> {
  const omittedPaths = new Set<string>();
  const omittedDirs: string[] = [];
  const stateDirs = ["state"];
  let namespaceNames: string[] = [];
  try {
    namespaceNames = (await readdir(path.join(options.rootAbs, "namespaces"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // no namespaces
  }
  for (const ns of namespaceNames) stateDirs.push(`namespaces/${ns}/state`);

  for (const stateDir of stateDirs) {
    const markerRel = `${stateDir}/${EMBEDDING_MARKER_BASENAME}`;
    const shardDirRel = `${stateDir}/${EMBEDDING_SHARD_DIR_BASENAME}`;
    const shardDirAbs = path.join(options.rootAbs, ...shardDirRel.split("/"));
    const memberRels: string[] = [];
    if (await pathExists(path.join(options.rootAbs, ...markerRel.split("/")))) {
      memberRels.push(markerRel);
    }
    let shardNames: string[] = [];
    try {
      shardNames = (await readdir(shardDirAbs, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && EMBEDDING_SHARD_FILE_PATTERN.test(entry.name))
        .map((entry) => entry.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const name of shardNames) memberRels.push(`${shardDirRel}/${name}`);
    if (memberRels.length === 0) continue;

    const excludedMembers: string[] = [];
    for (const relPath of memberRels) {
      let excluded = options.isExcludedRelPath(relPath);
      if (!excluded && options.excludeFile) {
        excluded = await options.excludeFile({
          root: options.rootAbs,
          path: relPath,
          filePath: path.join(options.rootAbs, ...relPath.split("/")),
        });
      }
      if (excluded) excludedMembers.push(relPath);
    }
    if (excludedMembers.length === 0) continue;
    omittedDirs.push(shardDirRel);
    for (const relPath of memberRels) omittedPaths.add(relPath);
  }
  return { omittedPaths, omittedDirs };
}

/** True when `relPath` belongs to a generation the push omitted. */
export function isPathInOmittedEmbeddingGeneration(relPath: string, omittedDirs: ReadonlySet<string>): boolean {
  const membership = embeddingGenerationMembership(relPath);
  return membership !== null && omittedDirs.has(membership.shardDir);
}

export type { EmbeddingIndexFile };

import { matchesOfflineSyncDefaultExclude } from "./offline-sync-exclude-globs.js";
import type { OfflineSyncDeletionRevision } from "./offline-sync.js";

export interface PushEmbeddingGenerationState {
  /** Generation dirs omitted by the push filters (snapshot header value). */
  omittedDirs: string[];
  /** All omitted member paths (walk skip set). */
  omittedPaths: Set<string>;
  /** Deletions with whole-generation suppression applied. */
  deletions: OfflineSyncDeletionRevision[];
}

/**
 * One-call push-side generation state for streaming snapshot builders: the
 * whole-generation omission set (from user regexps, excludeFile, and default
 * excludes) plus the deletion list with omitted-generation revisions
 * suppressed — including revisions for members that are already absent, so a
 * filtered generation can never be announced as deleted.
 */
export async function resolvePushEmbeddingGenerationState(options: {
  rootAbs: string;
  includeTranscripts: boolean;
  userExcludeRegexps?: readonly RegExp[];
  excludeFile?: OfflineSyncExcludeFile;
  deletions: readonly OfflineSyncDeletionRevision[];
}): Promise<PushEmbeddingGenerationState> {
  const omission = await computeOmittedEmbeddingGenerationPaths({
    rootAbs: options.rootAbs,
    userExcludeRegexps: options.userExcludeRegexps,
    excludeFile: options.excludeFile,
    isExcludedRelPath: (relPath) =>
      matchesOfflineSyncDefaultExclude(relPath) ||
      Boolean(options.userExcludeRegexps?.some((re) => re.test(relPath))),
  });
  const omittedDirs = new Set(omission.omittedDirs);
  const deletions = options.deletions.filter((deletion) => {
    if (matchesOfflineSyncDefaultExclude(deletion.path)) return false;
    if (options.userExcludeRegexps?.some((re) => re.test(deletion.path))) return false;
    const membership = embeddingGenerationMembership(deletion.path);
    if (membership && omittedDirs.has(membership.shardDir)) return false;
    return true;
  });
  return { omittedDirs: omission.omittedDirs, omittedPaths: omission.omittedPaths, deletions };
}


interface StorageBackedIndexIoHost {
  readOfflineSyncFile(filePath: string, opts?: { aadFilePath?: string }): Promise<Buffer>;
  writeOfflineSyncStagingFile(
    filePath: string,
    content: Buffer,
    opts?: { aadFilePath?: string },
  ): Promise<void>;
}

/**
 * Daemon wiring for the index store IO backed by a StorageManager:
 * canonical-path secure reads/writes, so sync-published encrypted shards
 * decrypt in the daemon and daemon-written shards decrypt on sync. Shard
 * STAGING writes bind the FINAL published path.
 */
export function storageBackedIndexStoreIo(storage: StorageBackedIndexIoHost): EmbeddingIndexStoreIo {
  return {
    readUtf8: async (filePath) => (await storage.readOfflineSyncFile(filePath)).toString("utf-8"),
    writeUtf8: (filePath, contents, opts) =>
      storage.writeOfflineSyncStagingFile(
        filePath,
        Buffer.from(contents, "utf-8"),
        opts?.finalAadFilePath === undefined ? undefined : { aadFilePath: opts.finalAadFilePath },
      ),
  };
}
