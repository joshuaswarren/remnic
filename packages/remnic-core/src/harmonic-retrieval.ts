import path from "node:path";
import { realpath } from "node:fs/promises";
import { listJsonFilesStrict, readJsonFile } from "./json-store.js";
import { raceAbort, throwIfAborted } from "./abort-error.js";
import { log } from "./logger.js";
import { readHarmonicGraphStamp } from "./harmonic-graph-version.js";
import { inferMemoryStatus, toMemoryPathRel } from "./memory-lifecycle-ledger-utils.js";
 import {
   HARMONIC_SOURCE_MEMORY_INSERTED_AT_KEY,
   resolveAbstractionNodeStoreDir,
   validateAbstractionNode,
   type AbstractionNode,
 } from "./abstraction-nodes.js";
import { resolveCueAnchorStoreDir, validateCueAnchor, type CueAnchor, type CueAnchorType } from "./cue-anchors.js";
import { compareDeterministicStrings } from "./deterministic-order.js";
import { normalizeRecallTokenSet, normalizeRecallTokens } from "./recall-tokenization.js";
import { stripAttributesSuffix } from "./structured-attributes.js";
import { isValidityExpiredNow } from "./temporal-validity.js";
import { assertSafePathSegment, isRecord } from "./store-contract.js";
import { isSupportPassportPrivateMemory } from "./support-passport/card-projection.js";
import type { MemoryFile } from "./types.js";
import { readProjectedMemoryStates } from "./memory-projection-batch.js";
import { SecureStoreLockedError } from "./secure-store/secure-fs.js";
import { StorageManager } from "./storage.js";
import { RECALL_FALLBACK_DIRS } from "./utils/category-dir.js";
import { readHarmonicSourceMemory, readUnresolvedHarmonicSources } from "./harmonic-source-lookup.js";
import { mapInBatches } from "./map-in-batches.js";


type SourceMemoryMap = Map<string, MemoryFile>;


const INDEX_MAX_AGE_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

function utcDaysSince(rebuiltMs: number, nowMs: number): string[] {
  const days: string[] = [];
  for (let day = Math.floor((rebuiltMs - DAY_MS) / DAY_MS) * DAY_MS; day <= nowMs; day += DAY_MS) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  return days;
}


function unprojectedCandidatePaths(memoryDir: string, id: string, days: string[]): string[] {
  const paths: string[] = [];
  for (const root of [memoryDir, path.join(memoryDir, "cold")]) {
    for (const dir of RECALL_FALLBACK_DIRS) {
      paths.push(path.join(root, dir, `${id}.md`));
      for (const day of days) paths.push(path.join(root, dir, day, `${id}.md`));
    }
  }
  return paths;
}

async function readIndexedSourceMemories(options: {
  memoryDir: string;
  abortSignal?: AbortSignal;
  sourceMemoryIds: string[];
  nowMs: number;
}): Promise<SourceMemoryMap | null> {
  const batch = readProjectedMemoryStates(options.memoryDir, options.sourceMemoryIds);
  const rebuiltMs = Date.parse(batch?.rebuiltAt ?? "");
  if (!batch?.complete || !batch.rebuiltAt || !Number.isFinite(rebuiltMs) || options.nowMs - rebuiltMs > INDEX_MAX_AGE_MS) return null;
  const rootReal = await realpath(options.memoryDir).catch(() => null);
  if (rootReal === null) return null;

  const storage = new StorageManager(options.memoryDir);
  const days = utcDaysSince(rebuiltMs, options.nowMs);
  const sourceMemories: SourceMemoryMap = new Map();
  const pending: string[] = [];
  const resolved = await mapInBatches(options.sourceMemoryIds, async (id) => {
    const state = batch.states.get(id);
    let safeId = true;
    try {
      assertSafePathSegment(id, "sourceMemoryId");
    } catch {
      safeId = false;
    }
    const candidates = state
      ? [state.path, path.join(options.memoryDir, "cold", state.pathRel)]
      : safeId ? unprojectedCandidatePaths(options.memoryDir, id, days) : [];
    for (const candidate of candidates) {
      const memory = await readHarmonicSourceMemory(storage, rootReal, candidate, options.abortSignal);
      if (memory?.frontmatter.id !== id) continue;
      return { id, memory };
    }
    return { id, memory: undefined };
  });
  for (const { id, memory } of resolved) {
    if (memory) sourceMemories.set(id, memory);
    else pending.push(id);
  }
  if (pending.length === 0) return sourceMemories;

  const unresolved = await readUnresolvedHarmonicSources({
    storage, rootReal, rebuiltAt: batch.rebuiltAt, sourceMemoryIds: pending,
    nowMs: options.nowMs, abortSignal: options.abortSignal,
  });
  for (const [id, memory] of unresolved) sourceMemories.set(id, memory);
  return sourceMemories;
}

async function readCorpusSourceMemories(options: {
  memoryDir: string;
  abortSignal?: AbortSignal;
}): Promise<SourceMemoryMap> {
  const sourceMemories: SourceMemoryMap = new Map();
  try {
    const storage = new StorageManager(options.memoryDir);
    const [hotMemories, coldMemories] = await Promise.all([
      storage.readAllMemories({ abortSignal: options.abortSignal }),
      storage.readAllColdMemories({ abortSignal: options.abortSignal }),
    ]);
    for (const memory of [...hotMemories, ...coldMemories]) {
      throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
      sourceMemories.set(memory.frontmatter.id, memory);
    }
  } catch (err) {
    throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
    if (err instanceof SecureStoreLockedError) return new Map();
    sourceMemories.clear();
  }
  return sourceMemories;
}

async function readSourceMemories(options: {
  memoryDir: string;
  abortSignal?: AbortSignal;
  sourceMemoryIds: string[];
  nowMs?: number;
}): Promise<SourceMemoryMap> {
  try {
    const indexed = await readIndexedSourceMemories({
      memoryDir: options.memoryDir,
      abortSignal: options.abortSignal,
      sourceMemoryIds: options.sourceMemoryIds,
      nowMs: options.nowMs ?? Date.now(),
    });
    if (indexed) return indexed;
  } catch (err) {
    throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
    if (err instanceof SecureStoreLockedError) return new Map();
  }
  return readCorpusSourceMemories(options);
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

function isEligibleSourceMemory(memory: MemoryFile, memoryDir: string): boolean {
  return (
    !isSupportPassportPrivateMemory(memory) &&
    inferMemoryStatus(memory.frontmatter, toMemoryPathRel(memoryDir, memory.path)) === "active"
  );
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
      isEligibleSourceMemory(memory, memoryDir) &&
      (temporalExpiredInInjection || !isValidityExpiredNow(memory.frontmatter, nowMs))
    );
  });
  if (activeSourceMemoryIds.length === 0) return null;

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

function tokenOverlap(queryTokens: Set<string>, fieldTokens: ReadonlySet<string>): number {
  let matches = 0;
  for (const token of queryTokens) {
    if (fieldTokens.has(token)) matches += 1;
  }
  return matches;
}

interface HarmonicNodeTokens {
  title: ReadonlySet<string>;
  summary: ReadonlySet<string>;
  tags: ReadonlySet<string>;
  entities: ReadonlySet<string>;
  kind: ReadonlySet<string>;
}

interface HarmonicAnchorTokens {
  value: ReadonlySet<string>;
  normalized: ReadonlySet<string>;
  type: ReadonlySet<string>;
  eligibleTags: ReadonlySet<string>;
}

interface HarmonicSearchIndex {
  nodesById: Map<string, AbstractionNode>;
  nodeTokens: HarmonicNodeTokens[];
  anchorTokens: HarmonicAnchorTokens[];
}

export const harmonicSearchIndexStats = { builds: 0 };

/**
 * Per-graph scoring index, keyed on the frozen graph object itself. Scoring a
 * recall tokenizes every node's title/summary/tags/entities/kind and every
 * anchor's value/cue/type/eligible tags; on a cache hit that repeated the
 * whole normalization for each recall (~0.75 s on a ~2.5k node, ~10k anchor
 * corpus, issue #3450). The sets are identical to what `countRecallTokenOverlap`
 * computed from the raw fields, so scores and matchedFields are unchanged.
 * For an uncached graph the index is built per call — the same work the old
 * code did inline.
 */
const harmonicSearchIndexes = new WeakMap<ProjectedHarmonicGraph, HarmonicSearchIndex>();

function getHarmonicSearchIndex(graph: ProjectedHarmonicGraph): HarmonicSearchIndex {
  const cached = harmonicSearchIndexes.get(graph);
  if (cached) return cached;
  harmonicSearchIndexStats.builds += 1;
  const nodesById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const nodeTokens = graph.nodes.map((node) => ({
    title: normalizeRecallTokenSet(node.title ?? ""),
    summary: normalizeRecallTokenSet(node.summary ?? ""),
    tags: normalizeRecallTokenSet(node.tags?.join(" ") ?? ""),
    entities: normalizeRecallTokenSet(node.entityRefs?.join(" ") ?? ""),
    kind: normalizeRecallTokenSet(`${node.kind} ${node.abstractionLevel}`),
  }));
  const anchorTokens = graph.anchors.map((anchor) => {
    const eligibleNodeTags = new Set(anchor.nodeRefs.flatMap((nodeRef) => nodesById.get(nodeRef)?.tags ?? []));
    const eligibleAnchorTags = anchor.tags?.filter((tag) => eligibleNodeTags.has(tag)) ?? [];
    return {
      value: normalizeRecallTokenSet(anchor.anchorValue ?? ""),
      normalized: normalizeRecallTokenSet(anchor.normalizedCue ?? ""),
      type: normalizeRecallTokenSet(anchor.anchorType),
      eligibleTags: normalizeRecallTokenSet(eligibleAnchorTags.join(" ")),
    };
  });
  const index: HarmonicSearchIndex = { nodesById, nodeTokens, anchorTokens };
  harmonicSearchIndexes.set(graph, index);
  return index;
}

function scoreNode(tokens: HarmonicNodeTokens, queryTokens: Set<string>): { score: number; matchedFields: string[] } {
  const matchedFields: string[] = [];
  let score = 0;

  const titleMatches = tokenOverlap(queryTokens, tokens.title);
  if (titleMatches > 0) {
    score += titleMatches * 3;
    matchedFields.push("title");
  }

  const summaryMatches = tokenOverlap(queryTokens, tokens.summary);
  if (summaryMatches > 0) {
    score += summaryMatches * 3;
    matchedFields.push("summary");
  }

  const tagMatches = tokenOverlap(queryTokens, tokens.tags);
  if (tagMatches > 0) {
    score += tagMatches * 2;
    matchedFields.push("tags");
  }

  const entityMatches = tokenOverlap(queryTokens, tokens.entities);
  if (entityMatches > 0) {
    score += entityMatches * 2;
    matchedFields.push("entityRefs");
  }

  const kindMatches = tokenOverlap(queryTokens, tokens.kind);
  if (kindMatches > 0) {
    score += kindMatches;
    matchedFields.push("kind");
  }

  return { score, matchedFields };
}

function scoreAnchor(tokens: HarmonicAnchorTokens, queryTokens: Set<string>): { score: number; matchedFields: string[] } {
  const matchedFields: string[] = [];
  let score = 0;

  const valueMatches = tokenOverlap(queryTokens, tokens.value);
  const normalizedMatches = tokenOverlap(queryTokens, tokens.normalized);
  const cueMatches = Math.max(valueMatches, normalizedMatches);
  if (cueMatches > 0) {
    score += cueMatches * 4;
    if (valueMatches > 0) matchedFields.push("anchorValue");
    if (normalizedMatches > 0) matchedFields.push("anchor");
  }

  const typeMatches = tokenOverlap(queryTokens, tokens.type);
  if (typeMatches > 0) {
    score += typeMatches;
    matchedFields.push("anchorType");
  }

  const tagMatches = tokenOverlap(queryTokens, tokens.eligibleTags);
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
  const parsed = await mapInBatches(files, async (filePath) => {
    try {
      return validateAbstractionNode(await readJsonFile(filePath));
    } catch {
      return null;
    }
  });
  return parsed.filter((node): node is AbstractionNode => node !== null);
}

export async function readCueAnchors(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
}): Promise<CueAnchor[]> {
  const abstractionRoot = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const rootDir = resolveCueAnchorStoreDir(abstractionRoot);
  const files = await listJsonFilesStrict(rootDir, { allowMissingDirectory: true });
  const parsed = await mapInBatches(files, async (filePath) => {
    try {
      return validateCueAnchor(await readJsonFile(filePath));
    } catch {
      // fail-open: invalid artifacts stay visible via status tooling instead of recall
      return null;
    }
  });
  return parsed.filter((anchor): anchor is CueAnchor => anchor !== null);
}

export interface ProjectedHarmonicGraph {
  nodes: AbstractionNode[];
  anchors: CueAnchor[];
}

interface ExpiringHarmonicGraph extends ProjectedHarmonicGraph {
  validUntilMs: number;
}

function earliestInvalidAtMs(sourceMemories: SourceMemoryMap, memoryDir: string, nowMs: number): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const memory of sourceMemories.values()) {
    if (!isEligibleSourceMemory(memory, memoryDir)) continue;
    const invalidAtMs = Date.parse(memory.frontmatter.invalid_at?.trim() ?? "");
    if (Number.isFinite(invalidAtMs) && invalidAtMs > nowMs && invalidAtMs < earliest) earliest = invalidAtMs;
  }
  return earliest;
}

async function buildProjectedHarmonicGraph(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  anchorsEnabled: boolean;
  abortSignal?: AbortSignal;
  temporalExpiredInInjection?: boolean;
  nowMs?: number;
}): Promise<ProjectedHarmonicGraph> {
  const { nodes, anchors } = await buildExpiringHarmonicGraph(options);
  return { nodes, anchors };
}

async function buildExpiringHarmonicGraph(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  anchorsEnabled: boolean;
  abortSignal?: AbortSignal;
  temporalExpiredInInjection?: boolean;
  nowMs?: number;
}): Promise<ExpiringHarmonicGraph> {
  throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
  const buildDelayMs = harmonicGraphBuildTestHooks?.buildDelayMs;
  if (buildDelayMs !== undefined && buildDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, buildDelayMs));
  }
  const nodes = await readAbstractionNodes(options);
  const sourceMemoryIds = [...new Set(nodes.flatMap((node) => node.sourceMemoryIds ?? []))];
  const sourceMemories: SourceMemoryMap = sourceMemoryIds.length > 0
    ? await readSourceMemories({
        memoryDir: options.memoryDir,
        abortSignal: options.abortSignal,
        sourceMemoryIds,
        nowMs: options.nowMs,
      })
    : new Map();
  const nowMs = options.nowMs ?? Date.now();
  const validUntilMs = options.temporalExpiredInInjection === true
    ? Number.POSITIVE_INFINITY
    : earliestInvalidAtMs(sourceMemories, options.memoryDir, nowMs);
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
  if (!options.anchorsEnabled) return { nodes: projectedNodes, anchors: [], validUntilMs };
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
  return { nodes: projectedNodes, anchors, validUntilMs };
}

const GRAPH_CACHE_TTL_MS = 30_000;
const GRAPH_CACHE_MAX_STALE_MS = 300_000;
const GRAPH_CACHE_MAX_ENTRIES = 8;

interface GraphCacheEntry {
  stamp: string;
  builtAtMs: number;
  validUntilMs: number;
  graph: ProjectedHarmonicGraph;
}

interface GraphBuild {
  stamp: string;
  promise: Promise<ProjectedHarmonicGraph>;
  controller: AbortController;
  waiting: number;
}

const graphCache = new Map<string, GraphCacheEntry>();
const graphBuilds = new Map<string, GraphBuild>();
const refreshFailedAtMs = new Map<string, number>();

function rememberRefreshFailure(key: string): void {
  refreshFailedAtMs.delete(key);
  refreshFailedAtMs.set(key, Date.now());
  while (refreshFailedAtMs.size > GRAPH_CACHE_MAX_ENTRIES) {
    const oldest = refreshFailedAtMs.keys().next().value;
    if (oldest === undefined) break;
    refreshFailedAtMs.delete(oldest);
  }
}

async function buildUnexpiredHarmonicGraph(options: GraphReadOptions, abortSignal: AbortSignal): Promise<ExpiringHarmonicGraph> {
  for (;;) {
    const built = await buildExpiringHarmonicGraph({
      memoryDir: options.memoryDir,
      abstractionNodeStoreDir: options.abstractionNodeStoreDir,
      anchorsEnabled: options.anchorsEnabled,
      temporalExpiredInInjection: options.temporalExpiredInInjection,
      abortSignal,
    });
    if (Date.now() < built.validUntilMs) return built;
  }
}
/** Counters for tests and diagnostics. `stale` hits also count as `hits`. */
export const harmonicGraphCacheStats = { hits: 0, misses: 0, stale: 0, shared: 0, deadlineExits: 0 };

/** Default per-caller bound on waiting for a shared graph build (see `waitBudgetMs`). */
export const HARMONIC_GRAPH_WAIT_BUDGET_MS = 5_000;

const HARMONIC_GRAPH_WAIT_DEADLINE_MESSAGE = "harmonic graph wait deadline exceeded";

export class HarmonicGraphWaitDeadlineError extends Error {
  constructor() {
    super(HARMONIC_GRAPH_WAIT_DEADLINE_MESSAGE);
    this.name = "HarmonicGraphWaitDeadlineError";
  }
}

interface HarmonicGraphBuildTestHooks {
  /** Extra delay inside every build, for wait-budget tests. */
  buildDelayMs?: number;
}
let harmonicGraphBuildTestHooks: HarmonicGraphBuildTestHooks | null = null;
export function setHarmonicGraphBuildTestHooks(hooks: HarmonicGraphBuildTestHooks | null): void {
  harmonicGraphBuildTestHooks = hooks;
}

function deepFreeze<T extends object>(value: T): T {
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function clearHarmonicGraphCache(): void {
  graphCache.clear();
  graphBuilds.clear();
  refreshFailedAtMs.clear();
}

/**
 * Resolves once every build running now has settled, and after the failure bookkeeping of a background
 * refresh (that handler was attached when the refresh started, so it runs first). For tests: a time-based
 * wait races a slow build.
 */
export async function settleHarmonicGraphBuilds(): Promise<void> {
  await Promise.allSettled([...graphBuilds.values()].map((build) => build.promise));
}

type GraphReadOptions = Parameters<typeof buildProjectedHarmonicGraph>[0];

function startGraphBuild(key: string, stamp: string, options: GraphReadOptions): GraphBuild {
  harmonicGraphCacheStats.misses++;
  const controller = new AbortController();
  const promise: Promise<ProjectedHarmonicGraph> = buildUnexpiredHarmonicGraph(options, controller.signal)
    .then((built) => {
      const graph = { nodes: deepFreeze(built.nodes), anchors: deepFreeze(built.anchors) };
      if (graphBuilds.get(key)?.promise !== promise) return graph;
      refreshFailedAtMs.delete(key);
      graphCache.delete(key);
      graphCache.set(key, { stamp, builtAtMs: Date.now(), validUntilMs: built.validUntilMs, graph });
      while (graphCache.size > GRAPH_CACHE_MAX_ENTRIES) {
        const oldest = graphCache.keys().next().value;
        if (oldest === undefined) break;
        graphCache.delete(oldest);
      }
      return graph;
    })
    .finally(() => {
      if (graphBuilds.get(key)?.promise === promise) graphBuilds.delete(key);
    });
  const build: GraphBuild = { stamp, promise, controller, waiting: 0 };
  graphBuilds.set(key, build);
  return build;
}

function joinGraphBuild(
  key: string,
  build: GraphBuild,
  signal: AbortSignal | undefined,
  waitBudgetMs?: number,
): Promise<ProjectedHarmonicGraph> {
  build.waiting++;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const waited =
    waitBudgetMs === undefined || waitBudgetMs <= 0
      ? raceAbort(build.promise, signal, "harmonic retrieval aborted")
      : Promise.race([
          raceAbort(build.promise, signal, "harmonic retrieval aborted"),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new HarmonicGraphWaitDeadlineError());
            }, waitBudgetMs);
          }),
        ]);
  return waited.finally(() => {
    if (timer) clearTimeout(timer);
    build.waiting--;
    if (timedOut) harmonicGraphCacheStats.deadlineExits++;
    if (build.waiting > 0 || timedOut) return;
    if (graphBuilds.get(key) === build) graphBuilds.delete(key);
    build.controller.abort();
  });
}

/**
 * `readProjectedHarmonicGraph` with an opt-in in-memory cache. Every recall used
 * to re-read all nodes, anchors and source memories from disk (about 4.7 s on a
 * 2107 node, 9199 anchor, 4105 source graph). With `useCache` a completed graph is
 * reused while the stamp below is unchanged: the memory corpus, memory status and
 * cold-write version sentinels (bumped by every memory write, in any process) and
 * the graph version sentinel (bumped by node and anchor writes). A stamp read is
 * four stats, not a scan of the memories. The TTL bounds the one input a sentinel
 * cannot see, which is wall-clock validity expiry; past it the stale graph is served
 * while one refresh runs (up to GRAPH_CACHE_MAX_STALE_MS). A changed stamp always
 * waits for a fresh build, because a stale graph could carry governed metadata of a
 * memory that left the active set. Concurrent misses share one build. An explicit
 * `nowMs` bypasses the cache so tests stay deterministic. The cached arrays are
 * frozen: callers must not mutate them.
 */
export async function readProjectedHarmonicGraph(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  anchorsEnabled: boolean;
  abortSignal?: AbortSignal;
  temporalExpiredInInjection?: boolean;
  nowMs?: number;
  useCache?: boolean;
  /** Per-caller bound on joining a shared build, in ms. On expiry the caller
   * leaves with a HarmonicGraphWaitDeadlineError while the build keeps running.
   * `0` or unset waits without a bound. Applies only on the cached path. */
  waitBudgetMs?: number;
}): Promise<ProjectedHarmonicGraph> {
  if (options.useCache !== true || options.nowMs !== undefined) return buildProjectedHarmonicGraph(options);
  throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
  const nodeStoreDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const key = JSON.stringify([
    options.memoryDir,
    nodeStoreDir,
    options.anchorsEnabled === true,
    options.temporalExpiredInInjection === true,
  ]);
  const stamp = readHarmonicGraphStamp(options.memoryDir, nodeStoreDir);
  const nowMs = Date.now();
  const hit = graphCache.get(key);
  if (hit && hit.stamp === stamp && nowMs < hit.validUntilMs && nowMs - hit.builtAtMs < GRAPH_CACHE_TTL_MS + GRAPH_CACHE_MAX_STALE_MS) {
    harmonicGraphCacheStats.hits++;
    graphCache.delete(key);
    graphCache.set(key, hit);
    if (nowMs - hit.builtAtMs >= GRAPH_CACHE_TTL_MS) {
      harmonicGraphCacheStats.stale++;
      const failedAtMs = refreshFailedAtMs.get(key);
      const backingOff = failedAtMs !== undefined && nowMs - failedAtMs < GRAPH_CACHE_TTL_MS;
      if (graphBuilds.get(key)?.stamp !== stamp && !backingOff) {
        startGraphBuild(key, stamp, options).promise.catch((err) => {
          rememberRefreshFailure(key);
          log.debug(`harmonic graph refresh failed: ${err}`);
        });
      }
    }
    return hit.graph;
  }
  const running = graphBuilds.get(key);
  if (running?.stamp === stamp) {
    harmonicGraphCacheStats.shared++;
    return joinGraphBuild(key, running, options.abortSignal, options.waitBudgetMs);
  }
  return joinGraphBuild(key, startGraphBuild(key, stamp, options), options.abortSignal, options.waitBudgetMs);
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
  /** Share one projected graph between recalls until a write bumps a version sentinel (see readProjectedHarmonicGraph). */
  useGraphCache?: boolean;
  /** Bound on waiting for a shared graph build, in ms. Past it the search
   * rejects with a HarmonicGraphWaitDeadlineError so a recall fails open
   * instead of blocking on a rebuild a write storm keeps invalidating.
   * `0` waits without a bound. Defaults to HARMONIC_GRAPH_WAIT_BUDGET_MS. */
  waitBudgetMs?: number;
}): Promise<HarmonicRetrievalResult[]> {
  throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
  const queryTokens = new Set(normalizeRecallTokens(options.query, ["what", "which"]));
  if (queryTokens.size === 0 || options.maxResults <= 0) return [];

  const graph = await readProjectedHarmonicGraph({
    ...options,
    useCache: options.useGraphCache === true,
    waitBudgetMs:
      options.waitBudgetMs === undefined ? HARMONIC_GRAPH_WAIT_BUDGET_MS : options.waitBudgetMs,
  });
  const { nodes: eligibleNodes, anchors } = graph;
  const searchIndex = getHarmonicSearchIndex(graph);
  const candidates = new Map<string, HarmonicCandidate>();

  for (const [nodeIndexPos, node] of eligibleNodes.entries()) {
    throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
    const tokens = searchIndex.nodeTokens[nodeIndexPos];
    const { score, matchedFields } = scoreNode(tokens, queryTokens);
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
    for (const [anchorIndex, anchor] of anchors.entries()) {
      throwIfAborted(options.abortSignal, "harmonic retrieval aborted");
      const eligibleNodeRefs = anchor.nodeRefs;
      const anchorTokens = searchIndex.anchorTokens[anchorIndex];
      const { score, matchedFields } = scoreAnchor(anchorTokens, queryTokens);
      if (score <= 0) continue;
      for (const nodeRef of eligibleNodeRefs) {
        const node = searchIndex.nodesById.get(nodeRef);
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
