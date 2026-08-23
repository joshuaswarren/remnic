import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAbstractionNodeStoreDir, validateAbstractionNode, type AbstractionNode } from "./abstraction-nodes.js";
import { listJsonFilesStrict, readJsonFile, withJsonStoreMutationLock, writeJsonFileAtomic } from "./json-store.js";
import { compareDeterministicStrings, mergeSortedUniqueStrings } from "./deterministic-order.js";
import { isNotFoundError } from "./utils/errno.js";
import {
  assertIsoRecordedAt,
  assertSafePathSegment,
  assertString,
  isRecord,
  optionalStringArray,
  validateStringRecord,
} from "./store-contract.js";

export type CueAnchorType = "entity" | "file" | "tool" | "outcome" | "constraint" | "date";

export interface CueAnchor {
  schemaVersion: 1;
  anchorId: string;
  anchorType: CueAnchorType;
  anchorValue: string;
  normalizedCue: string;
  recordedAt: string;
  sessionKey: string;
  nodeRefs: string[];
  sourceMemoryIdsByNodeRef?: Record<string, string[]>;
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface CueAnchorStoreStatus {
  enabled: boolean;
  anchorsEnabled: boolean;
  rootDir: string;
  anchors: {
    total: number;
    valid: number;
    invalid: number;
    byType: Partial<Record<CueAnchorType, number>>;
    totalNodeRefs: number;
    latestAnchorId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestAnchor?: CueAnchor;
  invalidAnchors: Array<{
    path: string;
    error: string;
  }>;
}

function validateAnchorType(raw: unknown): CueAnchorType {
  const value = assertString(raw, "anchorType");
  if (!["entity", "file", "tool", "outcome", "constraint", "date"].includes(value)) {
    throw new Error("anchorType must be one of entity|file|tool|outcome|constraint|date");
  }
  return value as CueAnchorType;
}

function validateNodeRefs(raw: unknown): string[] {
  const nodeRefs = optionalStringArray(raw, "nodeRefs");
  if (!nodeRefs || nodeRefs.length === 0) {
    throw new Error("nodeRefs must contain at least one node reference");
  }
  return nodeRefs.map((nodeRef, index) => assertSafePathSegment(nodeRef, `nodeRefs[${index}]`));
}

function validateSourceMemoryIdsByNodeRef(raw: unknown): Record<string, string[]> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error("sourceMemoryIdsByNodeRef must be an object of string arrays");
  const entries: Array<[string, string[]]> = [];
  for (const [rawNodeRef, rawSourceMemoryIds] of Object.entries(raw)) {
    const nodeRef = assertSafePathSegment(
      assertString(rawNodeRef, "sourceMemoryIdsByNodeRef key"),
      "sourceMemoryIdsByNodeRef.nodeRef"
    );
    const sourceMemoryIds = optionalStringArray(rawSourceMemoryIds, `sourceMemoryIdsByNodeRef.${nodeRef}`);
    if (sourceMemoryIds) entries.push([nodeRef, mergeSortedUniqueStrings(sourceMemoryIds)]);
  }
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.sort(([left], [right]) => compareDeterministicStrings(left, right)));
}

function mergeSourceMemoryIdsByNodeRef(
  existing: Record<string, string[]> | undefined,
  incoming: Record<string, string[]> | undefined
): Record<string, string[]> | undefined {
  const merged = new Map<string, string[]>();
  for (const [nodeRef, sourceMemoryIds] of Object.entries(existing ?? {})) {
    merged.set(nodeRef, [...sourceMemoryIds]);
  }
  for (const [nodeRef, sourceMemoryIds] of Object.entries(incoming ?? {})) {
    merged.set(nodeRef, mergeSortedUniqueStrings(merged.get(nodeRef), sourceMemoryIds));
  }
  return validateSourceMemoryIdsByNodeRef(Object.fromEntries(merged));
}

function boundSourceMemoryIdsByNodeRef(
  sourceMemoryIdsByNodeRef: Record<string, string[]> | undefined,
  nodeRefs: string[],
  liveNodes?: Map<string, AbstractionNode>
): Record<string, string[]> | undefined {
  if (!sourceMemoryIdsByNodeRef) return undefined;
  const retained = Object.fromEntries(
    nodeRefs.flatMap((nodeRef) => {
      const sourceMemoryIds = sourceMemoryIdsByNodeRef[nodeRef];
      if (!sourceMemoryIds) return [];
      const liveSourceMemoryIds = liveNodes?.get(nodeRef)?.sourceMemoryIds;
      if (liveNodes && !liveSourceMemoryIds) return [];
      const retainedSourceMemoryIds = mergeSortedUniqueStrings(sourceMemoryIds).filter((sourceMemoryId) =>
        liveSourceMemoryIds ? liveSourceMemoryIds.includes(sourceMemoryId) : true
      );
      return retainedSourceMemoryIds.length > 0 ? [[nodeRef, retainedSourceMemoryIds] as const] : [];
    })
  );
  return validateSourceMemoryIdsByNodeRef(retained);
}

export function resolveCueAnchorStoreDir(abstractionNodeStoreDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(abstractionNodeStoreDir, "anchors");
}

export function validateCueAnchor(raw: unknown): CueAnchor {
  if (!isRecord(raw)) throw new Error("cue anchor must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  return {
    schemaVersion: 1,
    anchorId: assertSafePathSegment(assertString(raw.anchorId, "anchorId"), "anchorId"),
    anchorType: validateAnchorType(raw.anchorType),
    anchorValue: assertString(raw.anchorValue, "anchorValue"),
    normalizedCue: assertString(raw.normalizedCue, "normalizedCue"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    nodeRefs: validateNodeRefs(raw.nodeRefs),
    sourceMemoryIdsByNodeRef: validateSourceMemoryIdsByNodeRef(raw.sourceMemoryIdsByNodeRef),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
  };
}

export async function recordCueAnchor(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  cueAnchorStoreDir?: string;
  anchor: CueAnchor;
}): Promise<string> {
  const abstractionNodeStoreDir = options.abstractionNodeStoreDir?.trim().length
    ? options.abstractionNodeStoreDir.trim()
    : path.join(options.memoryDir, "state", "abstraction-nodes");
  const rootDir = resolveCueAnchorStoreDir(abstractionNodeStoreDir, options.cueAnchorStoreDir);
  const validated = validateCueAnchor(options.anchor);
  const boundedNodeRefs = boundNodeRefs(validated.nodeRefs);
  const bounded = validateCueAnchor({
    ...validated,
    nodeRefs: boundedNodeRefs,
    sourceMemoryIdsByNodeRef: boundSourceMemoryIdsByNodeRef(validated.sourceMemoryIdsByNodeRef, boundedNodeRefs),
  });
  const anchorDir = path.join(rootDir, bounded.anchorType);
  const filePath = path.join(anchorDir, `${bounded.anchorId}.json`);
  await mkdir(anchorDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(bounded, null, 2), "utf8");
  return filePath;
}

function mergeSortedValues(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  return mergeSortedUniqueStrings(existing, incoming);
}

function boundNodeRefs(nodeRefs: string[], liveNodes?: Map<string, AbstractionNode>): string[] {
  const uniqueRefs = mergeSortedUniqueStrings(nodeRefs);
  if (!liveNodes) return uniqueRefs.slice(0, 50);
  return uniqueRefs
    .filter((nodeRef) => liveNodes.has(nodeRef))
    .sort(
      (left, right) =>
        Date.parse(liveNodes.get(right)?.recordedAt ?? "") - Date.parse(liveNodes.get(left)?.recordedAt ?? "") ||
        compareDeterministicStrings(left, right)
    )
    .slice(0, 50);
}

async function readLiveNodes(nodesDir: string): Promise<Map<string, AbstractionNode> | undefined> {
  const liveNodes = new Map<string, AbstractionNode>();
  let nodeFiles: string[];
  try {
    nodeFiles = await listJsonFilesStrict(nodesDir);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
  for (const filePath of nodeFiles) {
    const node = validateAbstractionNode(await readJsonFile(filePath));
    const previous = liveNodes.get(node.nodeId);
    if (
      !previous ||
      Date.parse(previous.recordedAt) < Date.parse(node.recordedAt) ||
      (Date.parse(previous.recordedAt) === Date.parse(node.recordedAt) &&
        compareDeterministicStrings(previous.sessionKey, node.sessionKey) < 0)
    ) {
      liveNodes.set(node.nodeId, node);
    }
  }
  return liveNodes;
}

export async function upsertCueAnchors(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  cueAnchorStoreDir?: string;
  anchors: CueAnchor[];
}): Promise<string[]> {
  const abstractionNodeStoreDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const incomingAnchors = options.anchors.map(validateCueAnchor);
  if (incomingAnchors.length === 0) return [];

  return withJsonStoreMutationLock(abstractionNodeStoreDir, async () => {
    const rootDir = resolveCueAnchorStoreDir(abstractionNodeStoreDir, options.cueAnchorStoreDir);
    const liveNodes = await readLiveNodes(path.join(abstractionNodeStoreDir, "nodes"));
    const incomingByKey = new Map<string, CueAnchor[]>();
    for (const anchor of incomingAnchors) {
      const key = `${anchor.anchorType}\u0000${anchor.anchorId}`;
      const grouped = incomingByKey.get(key) ?? [];
      grouped.push(anchor);
      incomingByKey.set(key, grouped);
    }
    const filePaths: string[] = [];
    for (const key of [...incomingByKey.keys()].sort(compareDeterministicStrings)) {
      const grouped = incomingByKey.get(key) ?? [];
      grouped.sort(compareIncomingCueAnchors);
      const incoming = grouped.shift();
      if (!incoming) throw new Error(`cue anchor batch has no anchor: ${key}`);
      const filePath = path.join(rootDir, incoming.anchorType, `${incoming.anchorId}.json`);
      let existing: CueAnchor | undefined;
      try {
        existing = validateCueAnchor(await readJsonFile(filePath));
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      let merged = mergeCueAnchors(existing, incoming, liveNodes);
      for (const next of grouped) merged = mergeCueAnchors(merged, next, liveNodes);
      await writeJsonFileAtomic(filePath, merged);
      filePaths.push(filePath);
    }
    return filePaths;
  });
}

function compareIncomingCueAnchors(left: CueAnchor, right: CueAnchor): number {
  const recordedAtComparison = Date.parse(left.recordedAt) - Date.parse(right.recordedAt);
  if (recordedAtComparison < 0) return -1;
  if (recordedAtComparison > 0) return 1;
  return compareDeterministicStrings(canonicalCueAnchorKey(left), canonicalCueAnchorKey(right));
}

function canonicalMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).sort(([left], [right]) => compareDeterministicStrings(left, right))
  );
}

function canonicalCueAnchorKey(anchor: CueAnchor): string {
  return JSON.stringify({
    ...anchor,
    metadata: canonicalMetadata(anchor.metadata),
  });
}

function mergeCueAnchors(
  existing: CueAnchor | undefined,
  incoming: CueAnchor,
  liveNodes: Map<string, AbstractionNode> | undefined
): CueAnchor {
  const incomingIsNewest = !existing || Date.parse(existing.recordedAt) <= Date.parse(incoming.recordedAt);
  const newest = incomingIsNewest ? incoming : existing;
  const older = incomingIsNewest ? existing : incoming;
  const mergedMetadata = canonicalMetadata({
    ...(older?.metadata ?? {}),
    ...(newest.metadata ?? {}),
  });
  const nodeRefs = boundNodeRefs(mergeSortedValues(existing?.nodeRefs, incoming.nodeRefs), liveNodes);
  return validateCueAnchor({
    ...newest,
    nodeRefs,
    sourceMemoryIdsByNodeRef: boundSourceMemoryIdsByNodeRef(
      mergeSourceMemoryIdsByNodeRef(existing?.sourceMemoryIdsByNodeRef, incoming.sourceMemoryIdsByNodeRef),
      nodeRefs,
      liveNodes
    ),
    tags: mergeSortedValues(existing?.tags, incoming.tags),
    metadata: mergedMetadata,
  });
}

export async function upsertCueAnchor(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  cueAnchorStoreDir?: string;
  anchor: CueAnchor;
}): Promise<string> {
  const [filePath] = await upsertCueAnchors({ ...options, anchors: [options.anchor] });
  if (!filePath) throw new Error("cue anchor upsert did not write a file");
  return filePath;
}

export async function pruneOrphanCueAnchors(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  cueAnchorStoreDir?: string;
}): Promise<number> {
  const abstractionNodeStoreDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  return withJsonStoreMutationLock(abstractionNodeStoreDir, async () => {
    const cueAnchorStoreDir = resolveCueAnchorStoreDir(abstractionNodeStoreDir, options.cueAnchorStoreDir);
    const liveNodes = (await readLiveNodes(path.join(abstractionNodeStoreDir, "nodes"))) ?? new Map();
    let removed = 0;
    const anchorFiles = await listJsonFilesStrict(cueAnchorStoreDir, {
      allowMissingDirectory: true,
    });
    for (const filePath of anchorFiles) {
      let anchor: CueAnchor;
      try {
        anchor = validateCueAnchor(await readJsonFile(filePath));
      } catch {
        continue;
      }
      const nodeRefs = boundNodeRefs(anchor.nodeRefs, liveNodes);
      const sourceMemoryIdsByNodeRef = boundSourceMemoryIdsByNodeRef(
        anchor.sourceMemoryIdsByNodeRef,
        nodeRefs,
        liveNodes
      );
      if (nodeRefs.length === 0) {
        try {
          await unlink(filePath);
          removed++;
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
        continue;
      }
      if (
        nodeRefs.length !== anchor.nodeRefs.length ||
        nodeRefs.some((nodeRef, index) => nodeRef !== anchor.nodeRefs[index]) ||
        JSON.stringify(sourceMemoryIdsByNodeRef) !== JSON.stringify(anchor.sourceMemoryIdsByNodeRef)
      ) {
        await writeJsonFileAtomic(filePath, validateCueAnchor({ ...anchor, nodeRefs, sourceMemoryIdsByNodeRef }));
      }
    }
    return removed;
  });
}

export async function getCueAnchorStoreStatus(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  cueAnchorStoreDir?: string;
  enabled: boolean;
  anchorsEnabled: boolean;
}): Promise<CueAnchorStoreStatus> {
  const abstractionNodeStoreDir = options.abstractionNodeStoreDir?.trim().length
    ? options.abstractionNodeStoreDir.trim()
    : path.join(options.memoryDir, "state", "abstraction-nodes");
  const rootDir = resolveCueAnchorStoreDir(abstractionNodeStoreDir, options.cueAnchorStoreDir);
  const files = await listJsonFilesStrict(rootDir, { allowMissingDirectory: true });
  const anchors: CueAnchor[] = [];
  const invalidAnchors: Array<{ path: string; error: string }> = [];

  for (const filePath of files) {
    try {
      anchors.push(validateCueAnchor(await readJsonFile(filePath)));
    } catch (error) {
      invalidAnchors.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  anchors.sort(
    (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || compareDeterministicStrings(a.anchorId, b.anchorId)
  );

  const byType: Partial<Record<CueAnchorType, number>> = {};
  let totalNodeRefs = 0;
  for (const anchor of anchors) {
    byType[anchor.anchorType] = (byType[anchor.anchorType] ?? 0) + 1;
    totalNodeRefs += anchor.nodeRefs.length;
  }

  return {
    enabled: options.enabled,
    anchorsEnabled: options.anchorsEnabled,
    rootDir,
    anchors: {
      total: files.length,
      valid: anchors.length,
      invalid: invalidAnchors.length,
      byType,
      totalNodeRefs,
      latestAnchorId: anchors[0]?.anchorId,
      latestRecordedAt: anchors[0]?.recordedAt,
      latestSessionKey: anchors[0]?.sessionKey,
    },
    latestAnchor: anchors[0],
    invalidAnchors,
  };
}
