
import { mkdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { log } from "./logger.js";
import { graphFilePath, readEdgesStrict, withGraphWriteLock, type GraphEdge, type GraphType } from "./graph.js";
import {
  assertGraphLockHeld,
  yieldForLockHeartbeat,
  type GraphWriteLockSection,
} from "./graph-write-lock.js";

const EDGE_SERIALIZE_YIELD_BATCH = 5_000;

export async function writeGraphJsonlAtomic(
  filePath: string,
  edges: GraphEdge[],
  lock: GraphWriteLockSection,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
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
  await assertGraphLockHeld(filePath, lock);
  await rename(tempPath, filePath);
}

function isNodeGeneratedEdge(edge: GraphEdge, type: GraphType, memoryPath: string): boolean {
  return type === "entity" ? edge.from === memoryPath : edge.to === memoryPath;
}

/** The edges one removal dropped from one graph file, kept for restoration. */
export interface RemovedNodeEdges {
  type: GraphType;
  filePath: string;
  removed: GraphEdge[];
}

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
        await assertGraphLockHeld(filePath, lock);
        await writeGraphJsonlAtomic(
          filePath,
          edges.filter((edge) => !isNodeGeneratedEdge(edge, type, memoryPath)),
          lock,
        );
        return removedEdges;
      });
    } catch (err) {
      for (const done of results) {
        await restoreRemovedNodeEdges(memoryDir, done).catch(() => undefined);
      }
      throw err;
    }
    if (removed.length > 0) results.push({ type, filePath, removed });
  }
  return results;
}

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
    await assertGraphLockHeld(removed.filePath, lock);
    await writeGraphJsonlAtomic(removed.filePath, [...current, ...toRestore], lock);
    return toRestore.length;
  });
}

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
          try {
            await assertGraphLockHeld(filePath, lock);
          } catch {
            residue.add(type);
            return;
          }
          await writeGraphJsonlAtomic(filePath, kept, lock);
        }
      }
      if (edges.some((edge) => isNodeGeneratedEdge(edge, type, memoryPath) && !mine.includes(JSON.stringify(edge)))) {
        residue.add(type);
      }
    });
  }
  return residue;
}
