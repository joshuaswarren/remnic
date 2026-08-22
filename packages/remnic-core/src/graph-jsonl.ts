/**
 * Graph JSONL rewrite primitives (sibling of graph.ts, kept out so graph.ts
 * stays under the 1200-LOC new-work cap of issue #1995).
 *
 * `appendEdge` in graph.ts is append-only by design. These helpers are the
 * REPLACE path: callers that re-write an existing node's edges (the
 * judge-merged target of issue #2330) must first drop the node's prior
 * generated edges or every re-write duplicates them.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { log } from "./logger.js";
import { graphFilePath, readEdgesStrict, withGraphWriteLock, type GraphEdge, type GraphType } from "./graph.js";
import { assertGraphLockHeld, yieldForLockHeartbeat } from "./graph-write-lock.js";

/**
 * Write a graph JSONL file atomically using temp+rename (gotcha #54: never
 * delete-then-rename; rename is atomic on the same filesystem). Shared by
 * the edge-decay rewrite and node-edge replacement so every JSONL rewrite
 * path serializes on the same lock and the same atomic-write discipline.
 */
/** Serialize batch size at which body building yields to the event loop
 * (round N+19 A): one `map+join` over a large corpus blocks the loop past
 * the lock's heartbeat window. */
const EDGE_SERIALIZE_YIELD_BATCH = 5_000;

export async function writeGraphJsonlAtomic(filePath: string, edges: GraphEdge[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  // Chunked with event-loop yields: the caller holds the graph write lock,
  // and its mtime heartbeat is a timer that cannot fire while a single
  // synchronous stringify pass over a multi-hundred-thousand-row corpus
  // blocks the loop (round N+19 A).
  let body = "";
  for (let i = 0; i < edges.length; i += EDGE_SERIALIZE_YIELD_BATCH) {
    if (i > 0) await yieldForLockHeartbeat();
    const end = Math.min(i + EDGE_SERIALIZE_YIELD_BATCH, edges.length);
    for (let j = i; j < end; j += 1) {
      body += `${JSON.stringify(edges[j])}\n`;
    }
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, body, "utf-8");
  await rename(tempPath, filePath);
}

/**
 * Which edges a node's OWN write generates, per graph type (round N+7 G):
 *  - entity: the node is the `from` side (node → entity siblings);
 *  - time/causal: the node is the `to` side (predecessor → node) — the
 *    write links BACK to its predecessor, so the inbound edge is the one
 *    this node's write created. The node's outbound time/causal edges
 *    (node → later nodes) belong to those LATER nodes' writes and are never
 *    touched here.
 */
function isNodeGeneratedEdge(edge: GraphEdge, type: GraphType, memoryPath: string): boolean {
  return type === "entity" ? edge.from === memoryPath : edge.to === memoryPath;
}

/** The edges one removal dropped from one graph file, kept for restoration. */
export interface RemovedNodeEdges {
  type: GraphType;
  filePath: string;
  removed: GraphEdge[];
}

/**
 * Remove an existing node's prior generated edges across the given graph
 * types so a RE-write of the same node (a judge-merged memory, issue #2330)
 * REPLACES them instead of re-appending them into the append-only JSONL —
 * duplicates `spreadingActivation` sums into candidate scores and that grow
 * without bound. One shared routine covers every enabled type; there is no
 * per-type copy. Read and rewrite run under the same per-file write lock as
 * `appendEdge` so a concurrent append cannot be dropped (issue #729). The
 * removed edges are RETURNED so the caller can restore them when the
 * replacement build fails (round N+7 E).
 */
export async function removeNodeEdgesForRewrite(
  memoryDir: string,
  memoryPath: string,
  types: readonly GraphType[],
): Promise<RemovedNodeEdges[]> {
  const results: RemovedNodeEdges[] = [];
  for (const type of types) {
    const filePath = graphFilePath(memoryDir, type);
    let removed: GraphEdge[];
    try {
      removed = await withGraphWriteLock(filePath, async (lock) => {
        const edges = await readEdgesStrict(memoryDir, type);
        const removedEdges = edges.filter((edge) => isNodeGeneratedEdge(edge, type, memoryPath));
        if (removedEdges.length === 0) return [];
        // Round N+19 A: a peer may have stale-broken this lock while a large
        // parse blocked the loop — revalidate ownership before publishing the
        // replacement; a lost lock aborts (the catch below restores any
        // earlier committed types, then rethrows).
        await assertGraphLockHeld(filePath, lock);
        await writeGraphJsonlAtomic(
          filePath,
          edges.filter((edge) => !isNodeGeneratedEdge(edge, type, memoryPath)),
        );
        return removedEdges;
      });
    } catch (err) {
      // A partial pass (type 1 committed, type 2 failed) must not leave the
      // committed removal stranded: undo what already landed, then surface.
      for (const done of results) {
        await restoreRemovedNodeEdges(memoryDir, done).catch(() => undefined);
      }
      throw err;
    }
    if (removed.length > 0) results.push({ type, filePath, removed });
  }
  return results;
}

/**
 * Restore edges a {@link removeNodeEdgesForRewrite} pass dropped, after the
 * replacement build FAILED (round N+7 E): failure must leave either the old
 * or the new complete set, never none. Appends the removed edges back under
 * the same per-file lock, deduped on the exact JSON row so a retry that
 * partially succeeded cannot double them.
 */
export async function restoreRemovedNodeEdges(
  memoryDir: string,
  removed: RemovedNodeEdges,
): Promise<number> {
  if (removed.removed.length === 0) return 0;
  return withGraphWriteLock(removed.filePath, async (lock) => {
    const current = await readEdgesStrict(memoryDir, removed.type);
    const present = new Set(current.map((edge) => JSON.stringify(edge)));
    const toRestore = removed.removed.filter((edge) => !present.has(JSON.stringify(edge)));
    if (toRestore.length === 0) return 0;
    // Round N+19 A: revalidate ownership before restoring over the file —
    // a peer that broke the lock owns the file now, and restoring our older
    // snapshot over its write would clobber it. The throw leaves the current
    // (peer-owned) file intact; callers log the skipped restore.
    await assertGraphLockHeld(removed.filePath, lock);
    await writeGraphJsonlAtomic(removed.filePath, [...current, ...toRestore]);
    return toRestore.length;
  });
}

/**
 * Round N+10 (C) + N+14 companion to {@link removeNodeEdgesForRewrite}: the
 * replacement build FAILED or was superseded, possibly after appending SOME
 * of the node's new edges. Two duties, both scoped to what THIS writer did:
 *
 * 1. Remove the rows the failed build actually appended. When `appended` is
 *    provided the removal is surgical — by exact JSON row identity, per
 *    file, under the same per-file lock — so rows a NEWER writer appended
 *    after this writer's removal (never in this writer's snapshot) survive.
 *    Rows a newer writer already swept are simply absent and the removal is
 *    a no-op. Since round N+16 (A) a THROWING build carries its partial row
 *    set on `GraphEdgeAppendError`, so the surgical path holds on the throw
 *    too; only a build that neither returns rows nor wraps its failure
 *    falls back to the node-wide sweep of
 *    {@link removeNodeEdgesForRewrite}: identical outcome when no newer
 *    writer interleaved.
 * 2. Restore the snapshot the original removal dropped — but only for graph
 *    types whose file holds NO unexplained node rows after step 1. A type
 *    that still has node rows this writer cannot account for is owned by the
 *    newer writer's completed rebuild; restoring the older snapshot over it
 *    left the memory holding B's body while graph recall reflected the
 *    pre-A state (the N+14 finding). Types swept clean restore verbatim
 *    (N+7 E: failure leaves the old or the new complete set, never none).
 */
export async function rollbackNodeEdgeRewrite(
  memoryDir: string,
  memoryPath: string,
  types: readonly GraphType[],
  removed: RemovedNodeEdges[],
  nodeId: string,
  appended?: readonly GraphEdge[],
): Promise<void> {
  let residue = new Set<GraphType>();
  const cleanup = appended
    ? removeAppendedNodeEdges(memoryDir, memoryPath, types, appended)
    : removeNodeEdgesForRewrite(memoryDir, memoryPath, types).then((): Set<GraphType> => new Set());
  await cleanup
    .then((left) => {
      residue = left;
    })
    .catch((cleanErr) =>
      log.error(
        `semantic-merge: partial graph edge cleanup failed for ${nodeId} — edges from the failed rebuild remain; rebuild with graph health repair: ${cleanErr instanceof Error ? cleanErr.message : String(cleanErr)}`,
      ),
    );
  for (const entry of removed) {
    if (residue.has(entry.type)) {
      log.warn(
        `semantic-merge: skipped ${entry.type} snapshot restore for ${nodeId} — a newer writer's rebuilt edges are live in that graph`,
      );
      continue;
    }
    await restoreRemovedNodeEdges(memoryDir, entry).catch((restoreErr) =>
      log.error(
        `semantic-merge: graph edge restore failed for ${nodeId} ${entry.type} graph — the prior edges may be lost; rebuild with graph health repair: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
      ),
    );
  }
}

/**
 * Round N+14: remove exactly the rows a failed/superseded build appended,
 * then report which of the rewrite types still hold node-generated rows this
 * writer did NOT append (a newer writer's live rebuild) so the caller can
 * skip restoring its older snapshot over them.
 */
async function removeAppendedNodeEdges(
  memoryDir: string,
  memoryPath: string,
  types: readonly GraphType[],
  appended: readonly GraphEdge[],
): Promise<Set<GraphType>> {
  const mineByType = new Map<GraphType, string[]>();
  for (const edge of appended) {
    const list = mineByType.get(edge.type) ?? [];
    list.push(JSON.stringify(edge));
    mineByType.set(edge.type, list);
  }
  const residue = new Set<GraphType>();
  for (const type of types) {
    const filePath = graphFilePath(memoryDir, type);
    const mine = mineByType.get(type) ?? [];
    await withGraphWriteLock(filePath, async (lock) => {
      const edges = await readEdgesStrict(memoryDir, type);
      if (mine.length > 0) {
        const identities = new Set(mine);
        const kept = edges.filter((edge) => !identities.has(JSON.stringify(edge)));
        if (kept.length !== edges.length) {
          // Round N+19 A: lost lock — a peer owns the file. Cleaning it would
          // clobber the peer's write, so leave it, mark the type as residue,
          // and let the caller skip restoring its older snapshot over it
          // (our appended rows may survive as duplicates; graph health
          // repair reconciles). Never old-plus-partial-new over a peer.
          try {
            await assertGraphLockHeld(filePath, lock);
          } catch {
            residue.add(type);
            return;
          }
          await writeGraphJsonlAtomic(filePath, kept);
        }
      }
      if (edges.some((edge) => isNodeGeneratedEdge(edge, type, memoryPath) && !mine.includes(JSON.stringify(edge)))) {
        residue.add(type);
      }
    });
  }
  return residue;
}
