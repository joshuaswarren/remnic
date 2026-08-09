import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAbstractionNodeStoreDir, validateAbstractionNode, type AbstractionNode } from "./abstraction-nodes.js";
import { listJsonFilesStrict, readJsonFile, withJsonStoreMutationLock, writeJsonFileAtomic } from "./json-store.js";
import { compareDeterministicStrings, mergeSortedUniqueStrings } from "./deterministic-order.js";
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
  const bounded = validateCueAnchor({
    ...validated,
    nodeRefs: boundNodeRefs(validated.nodeRefs),
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

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
  );
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

export async function upsertCueAnchor(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  cueAnchorStoreDir?: string;
  anchor: CueAnchor;
}): Promise<string> {
  const abstractionNodeStoreDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  return withJsonStoreMutationLock(abstractionNodeStoreDir, async () => {
    const rootDir = resolveCueAnchorStoreDir(abstractionNodeStoreDir, options.cueAnchorStoreDir);
    const incoming = validateCueAnchor(options.anchor);
    const liveNodes = await readLiveNodes(path.join(abstractionNodeStoreDir, "nodes"));
    const filePath = path.join(rootDir, incoming.anchorType, `${incoming.anchorId}.json`);
    let existing: CueAnchor | undefined;
    try {
      existing = validateCueAnchor(await readJsonFile(filePath));
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    const newest =
      !existing || Date.parse(existing.recordedAt) <= Date.parse(incoming.recordedAt) ? incoming : existing;
    const older = newest === incoming ? existing : incoming;
    const merged = validateCueAnchor({
      ...newest,
      nodeRefs: boundNodeRefs(mergeSortedValues(existing?.nodeRefs, incoming.nodeRefs), liveNodes),
      tags: mergeSortedValues(existing?.tags, incoming.tags),
      metadata: {
        ...(older?.metadata ?? {}),
        ...(newest.metadata ?? {}),
      },
    });
    await writeJsonFileAtomic(filePath, merged);
    return filePath;
  });
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
        nodeRefs.some((nodeRef, index) => nodeRef !== anchor.nodeRefs[index])
      ) {
        await writeJsonFileAtomic(filePath, validateCueAnchor({ ...anchor, nodeRefs }));
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
