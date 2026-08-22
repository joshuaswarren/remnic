/**
 * Graph JSONL rewrite primitives (sibling of graph.ts, kept out so graph.ts
 * stays under the 1200-LOC new-work cap of issue #1995).
 *
 * `appendEdge` in graph.ts is append-only by design. These helpers are the
 * REPLACE path: callers that re-write an existing node's edges (the
 * judge-merged target of issue #2330) must first drop the node's prior
 * from-side edges or every re-write duplicates them.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { graphFilePath, readEdgesStrict, withGraphWriteLock, type GraphEdge } from "./graph.js";

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
 * Remove an existing node's prior from-side entity edges so a RE-write of the
 * same node (a judge-merged memory, issue #2330) replaces its entity edges
 * instead of re-appending them. `onMemoryWritten` is append-only, so without
 * this a second merge of the same target duplicates every entity edge:
 * `spreadingActivation` sums each duplicate into the score (ranking
 * inflation) and entity.jsonl grows without bound (round N+6 finding B).
 * Only `from`-side entity edges are removed — the node's to-side edges were
 * appended by OTHER nodes' writes and only this node's own write recreates
 * the from-side set. Read and rewrite run under the same per-file write lock
 * as `appendEdge` so a concurrent append cannot be dropped (issue #729).
 * Returns the number of edges removed.
 */
export async function removeEntityEdgesFromNode(
  memoryDir: string,
  memoryPath: string,
): Promise<number> {
  const filePath = graphFilePath(memoryDir, "entity");
  return withGraphWriteLock(filePath, async () => {
    const edges = await readEdgesStrict(memoryDir, "entity");
    const kept = edges.filter((edge) => edge.from !== memoryPath);
    if (kept.length === edges.length) return 0;
    await writeGraphJsonlAtomic(filePath, kept);
    return edges.length - kept.length;
  });
}
