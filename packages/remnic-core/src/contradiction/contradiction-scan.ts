
import { resolveNamespaceCapabilities } from "../capabilities.js";
import type { StorageManager } from "../storage.js";
import type { PluginConfig, MemoryFile, MemoryStatus } from "../types.js";
import type { SemanticDedupLookup } from "../dedup/semantic.js";
import { log } from "../logger.js";
import { judgeContradictionPairs, type ContradictionJudgeInput } from "./contradiction-judge.js";
import {
  writePairs,
  readPair,
  isCoolingDown,
  memoryHashesChanged,
  computeMemoryContentHash,
  computePairId,
  migrateUnscopedPairsToNamespace,
  type ContradictionPair,
} from "./contradiction-review.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { FallbackLlmClient } from "../fallback-llm.js";
import { isSupportPassportPrivateMemory } from "../support-passport/card-projection.js";


export const ACTIVE_STATUSES: Set<MemoryStatus> = new Set(["active"]);

const SCAN_CATEGORIES = new Set([
  "decision",
  "principle",
  "rule",
  "entity",
  "fact",
  "preference",
]);

export interface ScanResult {
  scanned: number;
  candidates: number;
  judged: number;
  queued: number;
  cooledDown: number;
  /** Total wall-clock time in ms. */
  elapsedMs: number;
}

export interface ScanStorageResolution {
  storage: StorageManager;
  namespace?: string;
}

export interface ScanDependencies {
  storage: StorageManager;
  config: PluginConfig;
  memoryDir: string;
  /** Pre-built embedding lookup. When provided, used as-is for Strategy 3. */
  embeddingLookup?: SemanticDedupLookup;
  /**
   * Factory to build a namespace-scoped embedding lookup.
   * When provided, takes precedence over `embeddingLookup`.
   * The scan driver passes its own `storage` so the lookup queries the correct index.
   */
  embeddingLookupFactory?: (storage: StorageManager) => SemanticDedupLookup | undefined;
  /** Resolver for namespace-scoped storage. Required for scans when namespaces are enabled. */
  storageForNamespace?: (
    namespace: string | undefined,
  ) => StorageManager | ScanStorageResolution | Promise<StorageManager | ScanStorageResolution>;
  localLlm: LocalLlmClient | null;
  fallbackLlm: FallbackLlmClient | null;
  namespace?: string;
}


/**
 * Run a contradiction scan over the memory corpus.
 *
 * This is the entry point called by the nightly cron and by the CLI.
 */
export async function runContradictionScan(deps: ScanDependencies): Promise<ScanResult> {
  const startTime = Date.now();
  const { config, memoryDir, embeddingLookup, embeddingLookupFactory, localLlm, fallbackLlm } = deps;
  const requestedNamespace = normalizeScanNamespace(deps.namespace);
  const scanConfig = config.contradictionScan;

  if (!scanConfig.enabled) {
    log.info("[contradiction-scan] disabled by config");
    return { scanned: 0, candidates: 0, judged: 0, queued: 0, cooledDown: 0, elapsedMs: 0 };
  }

  const { storage: scanStorage, namespace } = await resolveScanStorage(deps, requestedNamespace);
  if (resolveNamespaceCapabilities(config).namespaces && namespace !== undefined && isDefaultNamespaceScan(config, requestedNamespace, namespace)) {
    const migrated = migrateUnscopedPairsToNamespace(memoryDir, namespace, { cooldownDays: scanConfig.cooldownDays });
    if (migrated > 0) {
      log.info("[contradiction-scan] migrated %d legacy unscoped review pairs to namespace %s", migrated, namespace);
    }
  }

  const scopedEmbeddingLookup = embeddingLookupFactory
    ? embeddingLookupFactory(scanStorage)
    : embeddingLookup;

  const memories = await loadEligibleMemories(scanStorage);
  log.info("[contradiction-scan] loaded %d eligible memories", memories.length);

  if (memories.length < 2) {
    return { scanned: memories.length, candidates: 0, judged: 0, queued: 0, cooledDown: 0, elapsedMs: Date.now() - startTime };
  }

  const existingPairCache = new Map<string, ContradictionPair | undefined>();
  const getExistingPair = (pairId: string): ContradictionPair | undefined => {
    if (!existingPairCache.has(pairId)) {
      existingPairCache.set(pairId, readPair(memoryDir, pairId) ?? undefined);
    }
    return existingPairCache.get(pairId);
  };

  const candidates = await generatePairs(memories, getExistingPair, scanConfig, namespace, scopedEmbeddingLookup);
  const cooledDown = candidates.skipped;
  log.info("[contradiction-scan] generated %d candidates (%d cooled down)", candidates.pairs.length, cooledDown);

  if (candidates.pairs.length === 0) {
    return {
      scanned: memories.length,
      candidates: 0,
      judged: 0,
      queued: 0,
      cooledDown,
      elapsedMs: Date.now() - startTime,
    };
  }

  const judgeInputs: ContradictionJudgeInput[] = candidates.pairs.map((pair) => ({
    memoryIdA: pair.idA,
    memoryIdB: pair.idB,
    textA: pair.textA,
    textB: pair.textB,
    categoryA: pair.categoryA,
    categoryB: pair.categoryB,
  }));

  const scanCache = new Map<string, import("./contradiction-judge.js").ContradictionJudgeResult>();
  const judgeResult = await judgeContradictionPairs(judgeInputs, config, localLlm, fallbackLlm, scanCache);
  log.info("[contradiction-scan] judge completed: %d judged, %d cached in %dms", judgeResult.judged, judgeResult.cached, judgeResult.elapsed);

  const queueEntries: Array<Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] }> = [];
  const currentMemoryHashes = memoryContentHashMap(memories);
  for (const [key, result] of judgeResult.results) {
    queueEntries.push({
      memoryIds: [result.memoryIdA, result.memoryIdB],
      verdict: result.verdict,
      rationale: result.rationale,
      confidence: result.confidence,
      detectedAt: new Date().toISOString(),
      lastReviewedAt: result.verdict === "independent" ? new Date().toISOString() : undefined,
      memoryContentHashes: pairMemoryContentHashes(result.memoryIdA, result.memoryIdB, currentMemoryHashes),
      namespace,
    });
  }

  const written = writePairs(memoryDir, queueEntries, { cooldownDays: scanConfig.cooldownDays });
  const elapsed = Date.now() - startTime;
  log.info("[contradiction-scan] complete: %d queued in %dms", written.length, elapsed);

  return {
    scanned: memories.length,
    candidates: candidates.pairs.length,
    judged: judgeResult.judged,
    queued: written.length,
    cooledDown,
    elapsedMs: elapsed,
  };
}


interface CandidatePair {
  idA: string;
  idB: string;
  textA: string;
  textB: string;
  categoryA?: string;
  categoryB?: string;
}

interface PairGenResult {
  pairs: CandidatePair[];
  skipped: number;
}

async function generatePairs(
  memories: MemoryFile[],
  getExistingPair: (pairId: string) => ContradictionPair | undefined,
  scanConfig: PluginConfig["contradictionScan"],
  namespace: string | undefined,
  embeddingLookup?: SemanticDedupLookup,
): Promise<PairGenResult> {
  const pairs: CandidatePair[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  const maxPairs = Math.max(0, Math.floor(scanConfig.maxPairsPerRun));
  if (maxPairs === 0) return { pairs, skipped };

  const orderedMemories = [...memories].sort(compareMemoryId);
  const currentMemoryHashes = memoryContentHashMap(orderedMemories);

  const pushCandidate = (pair: CandidatePair): void => {
    if (pairs.length < maxPairs) pairs.push(pair);
  };

  const hasCapacity = (): boolean => pairs.length < maxPairs;
  const isSkippedByCooldown = (existing: ContradictionPair | undefined): boolean => {
    if (!existing || !isCoolingDown(existing, scanConfig.cooldownDays)) return false;
    return !memoryHashesChanged("", existing, (memoryId) => currentMemoryHashes.get(memoryId) ?? null);
  };

  const byEntity = new Map<string, MemoryFile[]>();
  for (const mem of orderedMemories) {
    const entity = mem.frontmatter.entityRef;
    if (entity) {
      const existing = byEntity.get(entity) ?? [];
      existing.push(mem);
      byEntity.set(entity, existing);
    }
  }

  entityPairs:
  for (const entity of [...byEntity.keys()].sort()) {
    const group = byEntity.get(entity) ?? [];
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (!hasCapacity()) break entityPairs;
        const a = group[i];
        const b = group[j];
        const pairId = computePairId(a.frontmatter.id!, b.frontmatter.id!, namespace);

        if (seen.has(pairId)) continue;
        seen.add(pairId);

        const existing = getExistingPair(pairId);
        if (isSkippedByCooldown(existing)) {
          skipped++;
          continue;
        }

        pushCandidate({
          idA: a.frontmatter.id!,
          idB: b.frontmatter.id!,
          textA: a.content,
          textB: b.content,
          categoryA: a.frontmatter.category as string | undefined,
          categoryB: b.frontmatter.category as string | undefined,
        });
      }
    }
  }

  topicPairs:
  for (let i = 0; i < orderedMemories.length; i++) {
    for (let j = i + 1; j < orderedMemories.length; j++) {
      if (!hasCapacity()) break topicPairs;
      const a = orderedMemories[i];
      const b = orderedMemories[j];
      if (shareEntityRef(a, b)) continue;
      const overlap = jaccardOverlap(
        (a.frontmatter.tags as string[]) ?? [],
        (b.frontmatter.tags as string[]) ?? [],
      );

      if (overlap < scanConfig.topicOverlapFloor) continue;

      const pairId = computePairId(a.frontmatter.id!, b.frontmatter.id!, namespace);
      if (seen.has(pairId)) continue;
      seen.add(pairId);

      const existing = getExistingPair(pairId);
      if (isSkippedByCooldown(existing)) {
        skipped++;
        continue;
      }

      pushCandidate({
        idA: a.frontmatter.id!,
        idB: b.frontmatter.id!,
        textA: a.content,
        textB: b.content,
        categoryA: a.frontmatter.category as string | undefined,
        categoryB: b.frontmatter.category as string | undefined,
      });
    }
  }

  if (embeddingLookup && hasCapacity()) {
    const memoryById = new Map(orderedMemories.map((m) => [m.frontmatter.id!, m]));
    embeddingPairs:
    for (const mem of orderedMemories) {
      if (!hasCapacity()) break;
      const id = mem.frontmatter.id!;
      try {
        const hits = (await embeddingLookup(mem.content, 20)).sort((a, b) =>
          b.score - a.score || a.id.localeCompare(b.id),
        );
        for (const hit of hits) {
          if (!hasCapacity()) break embeddingPairs;
          if (hit.score < scanConfig.similarityFloor) continue;
          if (hit.id === id) continue;
          const peer = memoryById.get(hit.id);
          if (!peer) continue;

          const pairId = computePairId(id, hit.id, namespace);
          if (seen.has(pairId)) continue;
          seen.add(pairId);

          const existing = getExistingPair(pairId);
          if (isSkippedByCooldown(existing)) {
            skipped++;
            continue;
          }

          pushCandidate({
            idA: id,
            idB: hit.id,
            textA: mem.content,
            textB: peer.content,
            categoryA: mem.frontmatter.category as string | undefined,
            categoryB: peer.frontmatter.category as string | undefined,
          });
        }
      } catch {
        // Embedding backend unavailable — skip, entity-ref/tag strategies already covered
      }
    }
  }

  return { pairs, skipped };
}


function normalizeScanNamespace(namespace: string | undefined): string | undefined {
  const trimmed = namespace?.trim();
  return trimmed ? trimmed : undefined;
}

export async function resolveScanStorage(
  deps: Pick<ScanDependencies, "config" | "storage" | "storageForNamespace">,
  namespace: string | undefined,
): Promise<ScanStorageResolution> {
  if (!resolveNamespaceCapabilities(deps.config).namespaces) {
    const defaultNamespace = normalizeScanNamespace(deps.config.defaultNamespace);
    if (namespace && namespace !== defaultNamespace) {
      throw new Error(`unsupported namespace: ${namespace}`);
    }
    return { storage: deps.storage, namespace: undefined };
  }

  if (deps.storageForNamespace) {
    const resolved = await deps.storageForNamespace(namespace);
    if (isScanStorageResolution(resolved)) {
      return {
        storage: resolved.storage,
        namespace: normalizeScanNamespace(resolved.namespace) ?? fallbackResolvedNamespace(deps, namespace),
      };
    }
    if (!isStorageManagerLike(resolved)) {
      throw new Error("storageForNamespace must return a StorageManager or { storage: StorageManager, namespace?: string }");
    }
    return {
      storage: resolved,
      namespace: fallbackResolvedNamespace(deps, namespace),
    };
  }

  throw new Error(
    "contradiction scans require storageForNamespace when namespaces are enabled so callers can enforce namespace access",
  );
}

function isScanStorageResolution(value: StorageManager | ScanStorageResolution): value is ScanStorageResolution {
  if (isStorageManagerLike(value)) return false;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { storage?: unknown };
  return isStorageManagerLike(candidate.storage);
}

function isStorageManagerLike(value: unknown): value is StorageManager {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readAllMemories?: unknown };
  return typeof candidate.readAllMemories === "function";
}

function fallbackResolvedNamespace(
  deps: Pick<ScanDependencies, "config">,
  namespace: string | undefined,
): string | undefined {
  if (namespace) return namespace;
  return resolveNamespaceCapabilities(deps.config).namespaces ? deps.config.defaultNamespace : undefined;
}

function isDefaultNamespaceScan(
  config: PluginConfig,
  requestedNamespace: string | undefined,
  resolvedNamespace: string,
): boolean {
  if (requestedNamespace === undefined) return true;
  return requestedNamespace === config.defaultNamespace || resolvedNamespace === config.defaultNamespace;
}

async function loadEligibleMemories(storage: StorageManager): Promise<MemoryFile[]> {
  let all: MemoryFile[];
  try {
    all = await storage.readAllMemories();
  } catch {
    return [];
  }

  return all.filter((mem) => {
    const fm = mem.frontmatter;
    if (isSupportPassportPrivateMemory(mem)) return false;
    const status = (fm.status as MemoryStatus) ?? "active";
    if (!ACTIVE_STATUSES.has(status)) return false;

    const category = fm.category as string | undefined;
    if (category && !SCAN_CATEGORIES.has(category)) return false;

    if (!mem.content || mem.content.trim().length === 0) return false;

    if (!fm.id) return false;

    return true;
  });
}

function jaccardOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a.map((t) => t.toLowerCase()));
  const setB = new Set(b.map((t) => t.toLowerCase()));
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function shareEntityRef(a: MemoryFile, b: MemoryFile): boolean {
  const entityA = a.frontmatter.entityRef?.trim();
  const entityB = b.frontmatter.entityRef?.trim();
  return Boolean(entityA && entityB && entityA === entityB);
}

function compareMemoryId(a: MemoryFile, b: MemoryFile): number {
  return (a.frontmatter.id ?? "").localeCompare(b.frontmatter.id ?? "");
}

function memoryContentHashMap(memories: MemoryFile[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const memory of memories) {
    const id = memory.frontmatter.id;
    if (!id) continue;
    hashes.set(id, computeMemoryContentHash(memory.content, memory.frontmatter.category as string | undefined));
  }
  return hashes;
}

function pairMemoryContentHashes(
  memoryIdA: string,
  memoryIdB: string,
  currentMemoryHashes: Map<string, string>,
): Record<string, string> | undefined {
  const hashA = currentMemoryHashes.get(memoryIdA);
  const hashB = currentMemoryHashes.get(memoryIdB);
  if (!hashA || !hashB) return undefined;
  return {
    [memoryIdA]: hashA,
    [memoryIdB]: hashB,
  };
}
