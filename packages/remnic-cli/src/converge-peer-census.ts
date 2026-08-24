import { createHash } from "node:crypto";
import { parseFrontmatter } from "@remnic/core/storage.js";
import {
  buildReconcileManifest,
  RECONCILE_MANIFEST_FORMAT,
  RECONCILE_MANIFEST_SCHEMA_VERSION,
  type ReconcileManifest,
  type ReconcileManifestFile,
} from "@remnic/core/reconcile/manifest.js";
import {
  fetchPeerFileContent,
  fetchPeerManifestStream,
  fetchPeerSnapshot,
  type PeerFileContent,
} from "./converge-peer-transport.js";
import type { ConvergePlanCache } from "./converge-plan-cache.js";
import type { ConvergePlanProgressEvent } from "./converge-plan-cache.js";
import { censusWatermark } from "./converge-plan-cache.js";
import {
  parseTombstoneEvidence,
  TOMBSTONE_PATHS,
  TombstoneEvidence,
  tombstonedFileDigests,
} from "./converge-tombstones.js";

/**
 * Peer-side census phase for one namespace (issue #2803, extracted from
 * converge.ts): snapshot + manifest with resumable per-namespace
 * checkpointing, plus the load-bearing tombstone-evidence fetch.
 */

export interface PeerCensusArgs {
  peerUrl: string;
  namespace: string;
  index: number;
  total: number;
  resolvedToken: string | undefined;
  fetchFn: typeof fetch;
  timeoutMs: number;
  /** Peer advertised the streaming manifest route (capabilities). */
  manifestStream: boolean;
  /** Peer-advertised manifest revision; `undefined` = unversioned peer. */
  peerManifestRevision: string | undefined;
  /** Warm per-file cache from the local manifest, for the per-file fallback path. */
  localManifestFiles: readonly ReconcileManifestFile[] | undefined;
  cache: ConvergePlanCache | null;
  signal?: AbortSignal;
  onProgress?: (event: ConvergePlanProgressEvent) => void;
  citationTemplate?: string;
}

export interface PeerCensusResult {
  manifest: ReconcileManifest;
  tombstones: Set<string>;
}

export async function planPeerNamespaceCensus(args: PeerCensusArgs): Promise<PeerCensusResult> {
  const { peerUrl, ns } = { peerUrl: args.peerUrl, ns: args.namespace };
  args.signal?.throwIfAborted();
  const peerData = await fetchPeerSnapshot(peerUrl, ns, args.resolvedToken, args.fetchFn, args.timeoutMs);
  const priorPeerEntry = args.cache ? await args.cache.readEntry("peer", ns) : null;
  // Streamed rows carry the PEER's identity semantics. Client-built rows
  // (legacy per-file fallback) carry this client's parser and are safe
  // to reuse as a SHA-keyed warm base, including watermark hits.
  const revisionTrusted =
    args.peerManifestRevision !== undefined &&
    priorPeerEntry?.peerManifestRevision === args.peerManifestRevision;
  const clientBuiltPrior = priorPeerEntry?.clientBuilt === true;
  const reusableEntry = revisionTrusted || clientBuiltPrior ? priorPeerEntry : null;
  const priorPeerFiles = reusableEntry?.files;
  const watermark = censusWatermark(peerData.files);
  let peerManifest: ReconcileManifest | null = null;
  let clientBuilt = clientBuiltPrior;
  if (reusableEntry && reusableEntry.watermark === watermark && reusableEntry.fileCount === peerData.files.length) {
    // Cache hit: the peer census is byte-identical to the one this manifest
    // was built from. Overlay fresh mtime/bytes (newest-wins conflict
    // resolution reads them) and skip the manifest fetch.
    const freshByPath = new Map(peerData.files.map((file) => [file.path, file]));
    peerManifest = {
      format: RECONCILE_MANIFEST_FORMAT,
      schemaVersion: RECONCILE_MANIFEST_SCHEMA_VERSION,
      files: reusableEntry.files.map((file) => {
        const fresh = freshByPath.get(file.path);
        return fresh ? { ...file, mtimeMs: fresh.mtimeMs, bytes: fresh.bytes } : file;
      }),
    };
  } else {
    const streamedManifest = args.manifestStream
      ? await fetchPeerManifestStream(peerUrl, ns, args.resolvedToken, args.fetchFn, args.timeoutMs)
      : null;
    peerManifest = streamedManifest;
    if (!peerManifest) {
      clientBuilt = true;
      let readFailure: Error | undefined;
      peerManifest = await buildReconcileManifest({
        files: peerData.files,
        parseMemory: parseFrontmatter,
        citationTemplate: args.citationTemplate,
        // Older peers need one content request per memory file; prior cache
        // rows (sha-keyed) skip the ones already fetched.
        cachedFiles: priorPeerFiles ?? args.localManifestFiles,
        readFile: async (file) => {
          let remote: PeerFileContent | null;
          try {
            remote = await fetchPeerFileContent(
              peerUrl,
              ns,
              file.path,
              args.resolvedToken,
              args.fetchFn,
              args.timeoutMs
            );
          } catch (error) {
            readFailure = error instanceof Error ? error : new Error(String(error));
            throw readFailure;
          }
          if (!remote || remote.sha256 !== file.sha256) {
            readFailure = new Error(`failed to read peer reconciliation manifest file: ${file.path}`);
            throw readFailure;
          }
          return remote.content;
        },
      });
      if (readFailure) throw readFailure;
    }
  }
  const peerManifests = peerManifest;
  const evidence: TombstoneEvidence = { contentHashes: new Set(), fileSha256: new Set() };
  for (const tombstonePath of TOMBSTONE_PATHS) {
    const state = peerData.files.find((file) => file.path === tombstonePath);
    if (!state) continue;
    const remote = await fetchPeerFileContent(
      peerUrl,
      ns,
      tombstonePath,
      args.resolvedToken,
      args.fetchFn,
      args.timeoutMs
    );
    // A transport-level failure here is FATAL on purpose: tombstone evidence
    // is what stops a plan from pushing a peer-retracted memory back
    // (resurrection). There is no safe "empty evidence" fallback — the
    // snapshot response carries no tombstone digest array today.
    if (!remote) {
      throw new Error(`failed to read peer tombstone evidence: ${tombstonePath}`);
    }
    if (remote.sha256.toLowerCase() !== state.sha256.toLowerCase()) {
      // A LIVE peer appends tombstones while the plan runs, so the file can
      // legitimately differ from the snapshot listing that scheduled this
      // fetch. Tombstone stores are append-only by design, so the fetch is
      // consistent with the listing exactly when the listed revision is a
      // byte-prefix of the fetched content. The comparison is BYTES
      // throughout: state.bytes is a byte count and hashing the buffer
      // directly avoids UTF-16 code-unit slicing on non-ASCII logs (review
      // round 1).
      const listedBytes = typeof state.bytes === "number" ? state.bytes : -1;
      const prefixMatches =
        listedBytes >= 0 &&
        remote.content.length >= listedBytes &&
        createHash("sha256").update(remote.content.subarray(0, listedBytes)).digest("hex") ===
          state.sha256.toLowerCase();
      if (!prefixMatches) {
        throw new Error(`failed to read peer tombstone evidence: ${tombstonePath}`);
      }
    }
    const parsed = parseTombstoneEvidence(remote.content.toString("utf8"));
    for (const value of parsed.contentHashes) evidence.contentHashes.add(value);
    for (const value of parsed.fileSha256) evidence.fileSha256.add(value);
  }
  const mapped = tombstonedFileDigests(evidence, peerManifests);
  for (const digest of peerData.tombstones) mapped.add(digest);
  if (args.cache) {
    const priorByPath = new Map((priorPeerFiles ?? []).map((file) => [file.path, file.sha256.toLowerCase()]));
    let reused = 0;
    for (const file of peerManifests.files) {
      if (priorByPath.get(file.path) === file.sha256.toLowerCase()) reused += 1;
    }
    args.onProgress?.({
      side: "peer",
      namespace: ns,
      index: args.index,
      total: args.total,
      reused,
      computed: peerManifests.files.length - reused,
    });
    // Checkpoint per completed namespace: a transient failure later in the
    // run leaves every earlier namespace's manifest work durable.
    await args.cache.writeEntry({
      version: 1,
      scope: args.cache.scope,
      side: "peer",
      namespace: ns,
      watermark,
      fileCount: peerManifests.files.length,
      capturedAtMs: Date.now(),
      savedAt: new Date().toISOString(),
      ...(args.peerManifestRevision !== undefined
        ? { peerManifestRevision: args.peerManifestRevision }
        : {}),
      ...(clientBuilt ? { clientBuilt: true } : {}),
      files: peerManifests.files,
    });
  }
  return { manifest: peerManifests, tombstones: mapped };
}
