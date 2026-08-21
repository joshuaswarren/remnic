import path from "node:path";
import { listJsonFilesStrict, readJsonFile } from "./json-store.js";
import { throwIfAborted } from "./abort-error.js";
import { inferMemoryStatus, toMemoryPathRel } from "./memory-lifecycle-ledger-utils.js";
 import {
   HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY,
   resolveAbstractionNodeStoreDir,
   validateAbstractionNode,
   type AbstractionNode,
 } from "./abstraction-nodes.js";
import { resolveCueAnchorStoreDir, validateCueAnchor, type CueAnchor, type CueAnchorType } from "./cue-anchors.js";
import { compareDeterministicStrings } from "./deterministic-order.js";
import { countRecallTokenOverlap, normalizeRecallTokens } from "./recall-tokenization.js";
import { stripAttributesSuffix } from "./structured-attributes.js";
import { isValidityExpiredNow } from "./temporal-validity.js";
import { isRecord } from "./store-contract.js";
import type { MemoryFile } from "./types.js";

type SourceMemoryMap = Map<string, MemoryFile>;

async function readSourceMemories(options: {
  memoryDir: string;
  abortSignal?: AbortSignal;
}): Promise<SourceMemoryMap> {
  const sourceMemories: SourceMemoryMap = new Map();
 try {
 const { StorageManager } = await import("./storage.js");
 const storage = new StorageManager(options.memoryDir);
 const [hotMemories, coldMemories] = await Promise.all([
 storage.readAllMemories({ abortSignal: options.abortSignal }),
 storage.readAllColdMemories(),
 ]);
 for (const memory of [...hotMemories, ...coldMemories]) {
      throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
      sourceMemories.set(memory.frontmatter.id, memory);
    }
  } catch {
    throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
    // Source validation fails closed when the authorized memory directory is
    // unreadable. Source-less nodes remain eligible for retrieval.
    sourceMemories.clear();
  }
  return sourceMemories;
}

function parseSourceMemoryInsertedAt(node: AbstractionNode): Map<string, string> {
  const insertedAtById = new Map<string, string>();
  const insertedAtRaw = node.metadata?.[HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY];
  if (!insertedAtRaw) return insertedAtById;
  try {
    const parsed = JSON.parse(insertedAtRaw) as unknown;
    if (!isRecord(parsed)) return insertedAtById;
    for (const [memoryId, value] of Object.entries(parsed)) {
      if (typeof value === "string") insertedAtById.set(memoryId, value);
    }
  } catch {
    // Malformed insertion metadata leaves ordering on the recordedAt fallback.
  }
  return insertedAtById;
}

function projectSourceBackedNode(
  node: AbstractionNode,
  sourceMemories: SourceMemoryMap,
  memoryDir: string,
  temporalExpiredInInjection: boolean,
  nowMs: number
): AbstractionNode | null {
  const sourceMemoryIds = node.sourceMemoryIds ?? [];
  if (sourceMemoryIds.length === 0) return node;

  const activeSourceMemoryIds = sourceMemoryIds.filter((memoryId) => {
    const memory = sourceMemories.get(memoryId);
    return (
      memory !== undefined &&
      inferMemoryStatus(memory.frontmatter, toMemoryPathRel(memoryDir, memory.path)) === "active" &&
      (temporalExpiredInInjection || !isValidityExpiredNow(memory.frontmatter, nowMs))
    );
  });
  if (activeSourceMemoryIds.length === 0) return null;

 // Newest-first source order keeps the projected title and summary on the most
 // recently inserted facts. Equal or missing timestamps fall back to ascending
 // id order, which matches the stored sourceMemoryIds order.
 const insertedAtById = parseSourceMemoryInsertedAt(node);
 const insertedAtMs = (memoryId: string): number => {
   const parsedMs = Date.parse(insertedAtById.get(memoryId) ?? "");
   return Number.isFinite(parsedMs) ? parsedMs : Date.parse(node.recordedAt);
 };
 activeSourceMemoryIds.sort(
   (left, right) =>
     insertedAtMs(right) - insertedAtMs(left) || compareDeterministicStrings(left, right)
 );

  const activeMemories = activeSourceMemoryIds.flatMap((memoryId) => {
    const memory = sourceMemories.get(memoryId);
    return memory ? [memory] : [];
  });
  const activeContents = activeMemories.map((memory) =>
    memory.frontmatter.structuredAttributes ? stripAttributesSuffix(memory.content) : memory.content
  );
 let metadata: Record<string, string> | undefined;
 const activeInsertedAt = activeSourceMemoryIds.flatMap((memoryId) => {
   const value = insertedAtById.get(memoryId);
   return typeof value === "string" ? [[memoryId, value] as const] : [];
 });
 if (activeInsertedAt.length > 0) {
   metadata = {
     [HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY]: JSON.stringify(Object.fromEntries(activeInsertedAt)),
   };
  }

 return {
   ...node,
   sourceMemoryIds: activeSourceMemoryIds,
   title: activeContents[0]?.slice(0, 80) ?? node.title,
   summary: activeContents.slice(0, 3).join("; ").slice(0, 400),
   tags: [...new Set(activeMemories.flatMap((memory) => memory.frontmatter.tags))].sort(compareDeterministicStrings),
   entityRefs: [
     ...new Set(
       activeMemories.flatMap((memory) =>
         typeof memory.frontmatter.entityRef === "string" ? [memory.frontmatter.entityRef] : []
       )
     ),
   ].sort(compareDeterministicStrings),
   metadata,
 };
}

function anchorMatchesProjectedNode(
  anchor: CueAnchor,
  nodeRef: string,
  node: AbstractionNode,
  allowLegacyAttribution: boolean
): boolean {
  const activeSourceMemoryIds = node.sourceMemoryIds ?? [];
  if (activeSourceMemoryIds.length === 0) return true;
  if (!anchor.sourceMemoryIdsByNodeRef) return allowLegacyAttribution;
  const anchorSourceMemoryIds = anchor.sourceMemoryIdsByNodeRef[nodeRef] ?? [];
  return anchorSourceMemoryIds.some((sourceMemoryId) => activeSourceMemoryIds.includes(sourceMemoryId));
}

export interface HarmonicMatchedAnchor {
  anchorId: string;
  anchorType: CueAnchorType;
  anchorValue: string;
}

export interface HarmonicRetrievalResult {
  node: AbstractionNode;
  score: number;
  nodeScore: number;
  anchorScore: number;
  matchedFields: string[];
  matchedAnchors: HarmonicMatchedAnchor[];
}

interface HarmonicCandidate {
  node: AbstractionNode;
  nodeScore: number;
  anchorScore: number;
  matchedFields: Set<string>;
  matchedAnchors: Map<string, HarmonicMatchedAnchor>;
}

function scoreNode(node: AbstractionNode, queryTokens: Set<string>): { score: number; matchedFields: string[] } {
  const matchedFields: string[] = [];
  let score = 0;

  const titleMatches = countRecallTokenOverlap(queryTokens, node.title);
  if (titleMatches > 0) {
    score += titleMatches * 3;
    matchedFields.push("title");
  }

  const summaryMatches = countRecallTokenOverlap(queryTokens, node.summary);
  if (summaryMatches > 0) {
    score += summaryMatches * 3;
    matchedFields.push("summary");
  }

  const tagMatches = countRecallTokenOverlap(queryTokens, node.tags?.join(" "));
  if (tagMatches > 0) {
    score += tagMatches * 2;
    matchedFields.push("tags");
  }

  const entityMatches = countRecallTokenOverlap(queryTokens, node.entityRefs?.join(" "));
  if (entityMatches > 0) {
    score += entityMatches * 2;
    matchedFields.push("entityRefs");
  }

  const kindMatches = countRecallTokenOverlap(queryTokens, `${node.kind} ${node.abstractionLevel}`);
  if (kindMatches > 0) {
    score += kindMatches;
    matchedFields.push("kind");
  }

  return { score, matchedFields };
}

function scoreAnchor(
  anchor: CueAnchor,
  queryTokens: Set<string>,
  eligibleNodeTags: readonly string[]
): { score: number; matchedFields: string[] } {
  const matchedFields: string[] = [];
  let score = 0;

  const valueMatches = countRecallTokenOverlap(queryTokens, anchor.anchorValue);
  const normalizedMatches = countRecallTokenOverlap(queryTokens, anchor.normalizedCue);
  const cueMatches = Math.max(valueMatches, normalizedMatches);
  if (cueMatches > 0) {
    score += cueMatches * 4;
    if (valueMatches > 0) matchedFields.push("anchorValue");
    if (normalizedMatches > 0) matchedFields.push("anchor");
  }

  const typeMatches = countRecallTokenOverlap(queryTokens, anchor.anchorType);
  if (typeMatches > 0) {
    score += typeMatches;
    matchedFields.push("anchorType");
  }

  const tagMatches = countRecallTokenOverlap(queryTokens, eligibleNodeTags.join(" "));
  if (tagMatches > 0) {
    score += tagMatches * 2;
    matchedFields.push("anchorTags");
  }

  return { score, matchedFields };
}

export async function readAbstractionNodes(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
}): Promise<AbstractionNode[]> {
  const rootDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const files = await listJsonFilesStrict(path.join(rootDir, "nodes"), { allowMissingDirectory: true });
  const nodes: AbstractionNode[] = [];
  for (const filePath of files) {
    try {
      nodes.push(validateAbstractionNode(await readJsonFile(filePath)));
    } catch {
      // fail-open: invalid artifacts stay visible via status tooling instead of recall
    }
  }
  return nodes;
}

export async function readCueAnchors(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
}): Promise<CueAnchor[]> {
  const abstractionRoot = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const rootDir = resolveCueAnchorStoreDir(abstractionRoot);
  const files = await listJsonFilesStrict(rootDir, { allowMissingDirectory: true });
  const anchors: CueAnchor[] = [];
  for (const filePath of files) {
    try {
      anchors.push(validateCueAnchor(await readJsonFile(filePath)));
    } catch {
      // fail-open: invalid artifacts stay visible via status tooling instead of recall
    }
  }
  return anchors;
}

export interface ProjectedHarmonicGraph {
  nodes: AbstractionNode[];
  anchors: CueAnchor[];
}

/**
 * Read nodes + anchors and project BOTH against the namespace's current active
 * memories. This is the single projection every graph reader shares: a raw
 * `readAbstractionNodes` / `readCueAnchors` pair still carries the stored title,
 * summary, tags, and anchor attribution of a memory that was later rejected,
 * quarantined, or otherwise moved out of the active set, so a second reader
 * that skipped the projection could leak governed metadata even when the
 * memory itself is excluded from the final results.
 *
 * - A node whose every source memory left the active set is dropped.
 * - A surviving node's title/summary/tags/entityRefs are rebuilt from its
 *   active sources only.
 * - An anchor keeps a node reference only while its attribution runs through
 *   one of that node's surviving active sources, and is dropped once no
 *   reference survives.
 */
export async function readProjectedHarmonicGraph(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  anchorsEnabled: boolean;
  abortSignal?: AbortSignal;
  temporalExpiredInInjection?: boolean;
  nowMs?: number;
}): Promise<ProjectedHarmonicGraph> {
  throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
  const nodes = await readAbstractionNodes(options);
  const sourceBacked = nodes.some((node) => (node.sourceMemoryIds?.length ?? 0) > 0);
  const sourceMemories: SourceMemoryMap = sourceBacked
    ? await readSourceMemories(options)
    : new Map<string, MemoryFile>();
  const nowMs = options.nowMs ?? Date.now();
  // A node whose full stored source set survived projection keeps legacy
  // anchor attribution (an anchor written before per-node source ids existed).
  const legacyCompatibleNodeRefs = new Set<string>();
  const projectedNodes = nodes.flatMap((node) => {
    const projected = projectSourceBackedNode(
      node,
      sourceMemories,
      options.memoryDir,
      options.temporalExpiredInInjection === true,
      nowMs
    );
    if (
      projected &&
      (node.sourceMemoryIds?.length ?? 0) > 0 &&
      projected.sourceMemoryIds?.length === node.sourceMemoryIds?.length
    ) {
      legacyCompatibleNodeRefs.add(node.nodeId);
    }
    return projected ? [projected] : [];
  });
  if (!options.anchorsEnabled) return { nodes: projectedNodes, anchors: [] };
  throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
  const nodeIndex = new Map(projectedNodes.map((node) => [node.nodeId, node]));
  const anchors = (await readCueAnchors(options)).flatMap((anchor) => {
    throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
    const nodeRefs = anchor.nodeRefs.filter((nodeRef) => {
      const node = nodeIndex.get(nodeRef);
      return (
        node !== undefined &&
        anchorMatchesProjectedNode(anchor, nodeRef, node, legacyCompatibleNodeRefs.has(nodeRef))
      );
    });
    return nodeRefs.length > 0 ? [{ ...anchor, nodeRefs }] : [];
  });
  return { nodes: projectedNodes, anchors };
}

export async function searchHarmonicRetrieval(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  query: string;
  maxResults: number;
  sessionKey?: string;
  anchorsEnabled: boolean;
  abortSignal?: AbortSignal;
  temporalExpiredInInjection?: boolean;
}): Promise<HarmonicRetrievalResult[]> {
  throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
  const queryTokens = new Set(normalizeRecallTokens(options.query, ["what", "which"]));
  if (queryTokens.size === 0 || options.maxResults <= 0) return [];

  // One projection for every graph reader: nodes and anchors both arrive
  // already narrowed to the namespace's current active memories.
  const { nodes: eligibleNodes, anchors } = await readProjectedHarmonicGraph(options);
  const candidates = new Map<string, HarmonicCandidate>();

  for (const node of eligibleNodes) {
    throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
    const { score, matchedFields } = scoreNode(node, queryTokens);
    if (score <= 0) continue;
    candidates.set(node.nodeId, {
      node,
      nodeScore: score,
      anchorScore: 0,
      matchedFields: new Set(matchedFields),
      matchedAnchors: new Map(),
    });
  }

  if (options.anchorsEnabled) {
    throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
    const nodeIndex = new Map(eligibleNodes.map((node) => [node.nodeId, node]));
    for (const anchor of anchors) {
      throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
      // `nodeRefs` are the projection's surviving references already.
      const eligibleNodeRefs = anchor.nodeRefs;
      const eligibleNodeTags = new Set(eligibleNodeRefs.flatMap((nodeRef) => nodeIndex.get(nodeRef)?.tags ?? []));
      const eligibleAnchorTags = anchor.tags?.filter((tag) => eligibleNodeTags.has(tag)) ?? [];
      const { score, matchedFields } = scoreAnchor(anchor, queryTokens, eligibleAnchorTags);
      if (score <= 0) continue;
      for (const nodeRef of eligibleNodeRefs) {
        const node = nodeIndex.get(nodeRef);
        if (!node) continue;
        const existing = candidates.get(nodeRef) ?? {
          node,
          nodeScore: 0,
          anchorScore: 0,
          matchedFields: new Set<string>(),
          matchedAnchors: new Map<string, HarmonicMatchedAnchor>(),
        };
        existing.anchorScore += score;
        existing.matchedFields.add("anchor");
        for (const field of matchedFields) existing.matchedFields.add(field);
        existing.matchedAnchors.set(anchor.anchorId, {
          anchorId: anchor.anchorId,
          anchorType: anchor.anchorType,
          anchorValue: anchor.anchorValue,
        });
        candidates.set(nodeRef, existing);
      }
    }
  }

  return [...candidates.values()]
    .map((candidate) => {
      let score = candidate.nodeScore + candidate.anchorScore;
      if (options.sessionKey && candidate.node.sessionKey === options.sessionKey) score += 0.5;
      return {
        node: candidate.node,
        score,
        nodeScore: candidate.nodeScore,
        anchorScore: candidate.anchorScore,
        matchedFields: [...candidate.matchedFields].sort(),
        matchedAnchors: [...candidate.matchedAnchors.values()].sort(
          (left, right) =>
            left.anchorType.localeCompare(right.anchorType) || left.anchorValue.localeCompare(right.anchorValue)
        ),
      };
    })
    .filter((result) => result.nodeScore > 0 || result.anchorScore > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.anchorScore - left.anchorScore ||
        right.node.recordedAt.localeCompare(left.node.recordedAt)
    )
    .slice(0, options.maxResults);
}
