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

import { graphFilePath, readEdgesStrict, withGraphWriteLock, type GraphEdge, type GraphType } from "./graph.js";

/**
 * Write a graph JSONL file atomically using temp+rename (gotcha #54: never
 * delete-then-rename; rename is atomic on the same filesystem). Shared by
 * the edge-decay rewrite and node-edge replacement so every JSONL rewrite
 * path serializes on the same lock and the same atomic-write discipline.
 */
export async function writeGraphJsonlAtomic(filePath: string, edges: GraphEdge[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = edges.length === 0 ? "" : edges.map((e) => JSON.stringify(e)).join("\n") + "\n";
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
      removed = await withGraphWriteLock(filePath, async () => {
        const edges = await readEdgesStrict(memoryDir, type);
        const removedEdges = edges.filter((edge) => isNodeGeneratedEdge(edge, type, memoryPath));
        if (removedEdges.length === 0) return [];
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
  return withGraphWriteLock(removed.filePath, async () => {
    const current = await readEdgesStrict(memoryDir, removed.type);
    const present = new Set(current.map((edge) => JSON.stringify(edge)));
    const toRestore = removed.removed.filter((edge) => !present.has(JSON.stringify(edge)));
    if (toRestore.length === 0) return 0;
    await writeGraphJsonlAtomic(removed.filePath, [...current, ...toRestore]);
    return toRestore.length;
  });
}
