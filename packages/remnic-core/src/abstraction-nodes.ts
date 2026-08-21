import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { listJsonFilesStrict, readJsonFile, withJsonStoreMutationLock, writeJsonFileAtomic } from "./json-store.js";
import { compareDeterministicStrings, mergeSortedUniqueStrings } from "./deterministic-order.js";
import {
  assertIsoRecordedAt,
  assertSafePathSegment,
  assertString,
  isRecord,
  optionalStringArray,
  recordStoreDay,
  validateStringRecord,
} from "./store-contract.js";

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export type AbstractionNodeKind = "episode" | "topic" | "project" | "workflow" | "constraint";
export type AbstractionLevel = "micro" | "meso" | "macro";

export interface AbstractionNode {
  schemaVersion: 1;
  nodeId: string;
  recordedAt: string;
  sessionKey: string;
  kind: AbstractionNodeKind;
  abstractionLevel: AbstractionLevel;
  title: string;
  summary: string;
  sourceMemoryIds?: string[];
  entityRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface AbstractionNodeStoreStatus {
  enabled: boolean;
  anchorsEnabled: boolean;
  rootDir: string;
  nodesDir: string;
  nodes: {
    total: number;
    valid: number;
    invalid: number;
    byKind: Partial<Record<AbstractionNodeKind, number>>;
    byLevel: Partial<Record<AbstractionLevel, number>>;
    latestNodeId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestNode?: AbstractionNode;
  invalidNodes: Array<{
    path: string;
    error: string;
  }>;
}

function validateKind(raw: unknown): AbstractionNodeKind {
  const value = assertString(raw, "kind");
  if (!["episode", "topic", "project", "workflow", "constraint"].includes(value)) {
    throw new Error("kind must be one of episode|topic|project|workflow|constraint");
  }
  return value as AbstractionNodeKind;
}

function validateLevel(raw: unknown): AbstractionLevel {
  const value = assertString(raw, "abstractionLevel");
  if (!["micro", "meso", "macro"].includes(value)) {
    throw new Error("abstractionLevel must be one of micro|meso|macro");
  }
  return value as AbstractionLevel;
}

export function resolveAbstractionNodeStoreDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "abstraction-nodes");
}

export function validateAbstractionNode(raw: unknown): AbstractionNode {
  if (!isRecord(raw)) throw new Error("abstraction node must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  return {
    schemaVersion: 1,
    nodeId: assertSafePathSegment(assertString(raw.nodeId, "nodeId"), "nodeId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    kind: validateKind(raw.kind),
    abstractionLevel: validateLevel(raw.abstractionLevel),
    title: assertString(raw.title, "title"),
    summary: assertString(raw.summary, "summary"),
    sourceMemoryIds: optionalStringArray(raw.sourceMemoryIds, "sourceMemoryIds"),
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
  };
}

export async function recordAbstractionNode(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  node: AbstractionNode;
}): Promise<string> {
  const rootDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const validated = validateAbstractionNode(options.node);
  const day = recordStoreDay(validated.recordedAt);
  const nodesDir = path.join(rootDir, "nodes", day);
  const filePath = path.join(nodesDir, `${validated.nodeId}.json`);
  await mkdir(nodesDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

const MAX_ABSTRACTION_NODE_VALUES = 50;

function mergeSortedValues(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  return mergeSortedUniqueStrings(existing, incoming).slice(0, MAX_ABSTRACTION_NODE_VALUES);
}

export const HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY = "remnic.harmonic.sourceMemoryInsertedAt.v1";

function sourceMemoryInsertedAt(node: AbstractionNode | undefined): Map<string, string> {
  const insertedAtById = new Map<string, string>();
  if (!node) return insertedAtById;
  let stored: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(node.metadata?.[HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY] ?? "{}") as unknown;
    stored = isRecord(parsed) ? parsed : {};
  } catch {
    stored = {};
  }
  for (const memoryId of node.sourceMemoryIds ?? []) {
    const insertedAt = stored[memoryId];
    insertedAtById.set(
      memoryId,
      typeof insertedAt === "string" && Number.isFinite(Date.parse(insertedAt)) ? insertedAt : node.recordedAt
    );
  }
  return insertedAtById;
}

function mergeRecentSourceMemoryIds(
  existing: AbstractionNode | undefined,
  incoming: AbstractionNode
): { ids: string[]; insertedAtJson: string } {
  const insertedAtById = sourceMemoryInsertedAt(existing);
  const incomingSources = [...sourceMemoryInsertedAt(incoming).entries()].sort(
    ([leftId, leftAt], [rightId, rightAt]) =>
      Date.parse(leftAt) - Date.parse(rightAt) || compareDeterministicStrings(leftId, rightId)
  );
  let nextInsertedAtMs = Math.max(
    Date.now(),
    [...insertedAtById.values()].reduce((latest, insertedAt) => Math.max(latest, Date.parse(insertedAt) + 1), 0)
  );
  for (const [memoryId] of incomingSources) {
    if (insertedAtById.has(memoryId)) continue;
    insertedAtById.set(memoryId, new Date(nextInsertedAtMs).toISOString());
    nextInsertedAtMs++;
  }
  const retained = [...insertedAtById.entries()]
    .sort(
      ([leftId, leftAt], [rightId, rightAt]) =>
        Date.parse(rightAt) - Date.parse(leftAt) || compareDeterministicStrings(leftId, rightId)
    )
    .slice(0, MAX_ABSTRACTION_NODE_VALUES);
  const ids = retained.map(([memoryId]) => memoryId).sort(compareDeterministicStrings);
  const retainedInsertedAt = Object.fromEntries(ids.map((memoryId) => [memoryId, insertedAtById.get(memoryId)]));
  return { ids, insertedAtJson: JSON.stringify(retainedInsertedAt) };
}

type AbstractionNodeFile = {
  filePath: string;
  node: AbstractionNode;
};

function compareNodeFiles(left: AbstractionNodeFile, right: AbstractionNodeFile): number {
  return (
    Date.parse(right.node.recordedAt) - Date.parse(left.node.recordedAt) ||
    compareDeterministicStrings(left.filePath, right.filePath)
  );
}

function compareIncomingNodes(left: AbstractionNode, right: AbstractionNode): number {
  return (
    Date.parse(left.recordedAt) - Date.parse(right.recordedAt) ||
    compareDeterministicStrings(canonicalNodeKey(left), canonicalNodeKey(right))
  );
}

function canonicalMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).sort(([left], [right]) => compareDeterministicStrings(left, right))
  );
}

function canonicalNodeKey(node: AbstractionNode): string {
  return JSON.stringify({
    ...node,
    metadata: canonicalMetadata(node.metadata),
  });
}

function mergeAbstractionNodes(existing: AbstractionNode | undefined, incoming: AbstractionNode): AbstractionNode {
  const incomingIsNewest = !existing || Date.parse(existing.recordedAt) <= Date.parse(incoming.recordedAt);
  const newest = incomingIsNewest ? incoming : existing;
  const older = incomingIsNewest ? existing : incoming;
  if (!newest) throw new Error("abstraction node merge requires a node");
  const retainedSources = mergeRecentSourceMemoryIds(existing, incoming);
  const mergedMetadata = canonicalMetadata({
    ...(older?.metadata ?? {}),
    ...(newest.metadata ?? {}),
    [HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY]: retainedSources.insertedAtJson,
  });
  return validateAbstractionNode({
    ...newest,
    sourceMemoryIds: retainedSources.ids,
    entityRefs: mergeSortedValues(existing?.entityRefs, incoming.entityRefs),
    tags: mergeSortedValues(existing?.tags, incoming.tags),
    metadata: mergedMetadata,
  });
}

export async function upsertAbstractionNodes(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  nodes: AbstractionNode[];
}): Promise<string[]> {
  const rootDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const incomingNodes = options.nodes.map(validateAbstractionNode);
  if (incomingNodes.length === 0) return [];
  return withJsonStoreMutationLock(rootDir, async () => {
    const nodesDir = path.join(rootDir, "nodes");
    const nodeFiles = await listJsonFilesStrict(nodesDir, { allowMissingDirectory: true });
    const existingNodes = await Promise.all(
      nodeFiles.map(async (filePath) => ({
        filePath,
        node: validateAbstractionNode(await readJsonFile(filePath)),
      }))
    );
    const existingById = new Map<string, AbstractionNodeFile[]>();
    for (const existing of existingNodes) {
      const records = existingById.get(existing.node.nodeId) ?? [];
      records.push(existing);
      existingById.set(existing.node.nodeId, records);
    }
    const incomingById = new Map<string, AbstractionNode[]>();
    for (const incoming of incomingNodes) {
      const records = incomingById.get(incoming.nodeId) ?? [];
      records.push(incoming);
      incomingById.set(incoming.nodeId, records);
    }

    const filePaths: string[] = [];
    for (const nodeId of [...incomingById.keys()].sort(compareDeterministicStrings)) {
      const existing = (existingById.get(nodeId) ?? []).sort(compareNodeFiles);
      const incoming = (incomingById.get(nodeId) ?? []).sort(compareIncomingNodes);
      let merged: AbstractionNode | undefined;
      for (const next of [...existing].reverse()) merged = mergeAbstractionNodes(merged, next.node);
      for (const next of incoming) merged = mergeAbstractionNodes(merged, next);
      if (!merged) throw new Error(`abstraction node batch has no node: ${nodeId}`);
      const filePath =
        existing[0]?.filePath ?? path.join(nodesDir, recordStoreDay(merged.recordedAt), `${merged.nodeId}.json`);
      await writeJsonFileAtomic(filePath, merged);
      for (const duplicate of existing.slice(1)) {
        await unlink(duplicate.filePath).catch((error) => {
          if (!isNotFoundError(error)) throw error;
        });
      }
      filePaths.push(filePath);
    }
    return filePaths;
  });
}

export async function upsertAbstractionNode(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  node: AbstractionNode;
}): Promise<string> {
  const [filePath] = await upsertAbstractionNodes({ ...options, nodes: [options.node] });
  if (!filePath) throw new Error("abstraction node upsert did not write a file");
  return filePath;
}

export async function getAbstractionNodeStoreStatus(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  enabled: boolean;
  anchorsEnabled: boolean;
}): Promise<AbstractionNodeStoreStatus> {
  const rootDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const nodesDir = path.join(rootDir, "nodes");
  const files = await listJsonFilesStrict(nodesDir, { allowMissingDirectory: true });
  const nodes: AbstractionNode[] = [];
  const invalidNodes: Array<{ path: string; error: string }> = [];

  for (const filePath of files) {
    try {
      nodes.push(validateAbstractionNode(await readJsonFile(filePath)));
    } catch (error) {
      invalidNodes.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  nodes.sort(
    (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || compareDeterministicStrings(a.nodeId, b.nodeId)
  );

  const byKind: Partial<Record<AbstractionNodeKind, number>> = {};
  const byLevel: Partial<Record<AbstractionLevel, number>> = {};
  for (const node of nodes) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    byLevel[node.abstractionLevel] = (byLevel[node.abstractionLevel] ?? 0) + 1;
  }

  return {
    enabled: options.enabled,
    anchorsEnabled: options.anchorsEnabled,
    rootDir,
    nodesDir,
    nodes: {
      total: files.length,
      valid: nodes.length,
      invalid: invalidNodes.length,
      byKind,
      byLevel,
      latestNodeId: nodes[0]?.nodeId,
      latestRecordedAt: nodes[0]?.recordedAt,
      latestSessionKey: nodes[0]?.sessionKey,
    },
    latestNode: nodes[0],
    invalidNodes,
  };
}
