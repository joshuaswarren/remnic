
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { toMemoryPathRel } from "../memory-lifecycle-ledger-utils.js";
import { SecureStoreLockedError, readMaybeEncryptedFile } from "../secure-store/secure-fs.js";
import { type BufferSurpriseEvent, type CompressionGuidelineOptimizerState, type MemoryFile, type PluginConfig, confidenceTier } from "../types.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { isErrnoCode } from "../utils/errno.js";
import { isPopulatedUnnamedEntityRecord } from "../utils/malformed-entity-record.js";
import { isMacOsReplicationJunkBasename } from "../utils/macos-replication-junk.js";
import { isAbortError } from "../abort-error.js";
import { checkCorpusReadAbort, type CorpusReadOptions } from "../corpus-read-cancellation.js";
import { isValidTranscriptDate } from "../wearables/day-store.js";
import {
  isValidBufferSurpriseEvent,
  normalizeFrontmatterForPath,
  parseEntityFile,
  parseFrontmatter,
  StorageManager,
} from "../storage.js";
import { rememberRawFrontmatter } from "./memory-frontmatter-metadata.js";
import { corpusScanWorker } from "../corpus-scan-worker-host.js";

export interface MemoryReadStoreDeps {
  /** Live class object of the host instance — shared static caches (see storage.ts storageManagerClass). */
  readonly storageManagerClass: typeof StorageManager;
  readonly _secureStoreKey: Buffer | null;
  appendStorageSecureFile(filePath: string, content: string): Promise<void>;
  artifactIndexCache: { memories: MemoryFile[]; loadedAtMs: number; writeVersion: number } | null;
  readonly artifactsDir: string;
  readonly baseDir: string;
  readonly bufferSurpriseLedgerPath: string;
  collectActiveMemoryPaths(options?: CorpusReadOptions): Promise<string[]>;
  readonly correctionsDir: string;
  ensureDirectories(): Promise<void>;
  readonly entitySchemas: PluginConfig["entitySchemas"] | undefined;
  readonly factsDir: string;
  filterWindowPathsByUpdatedAfter(filePaths: string[], updatedAfterMs: number): Promise<string[]>;
  getArtifactWriteVersion(): number;
  normalizeMemoryReadBatchSize(batchSize?: number): number;
  orderWindowPaths(filePaths: string[]): string[];
  parseQuestionFile(
    raw: string,
    filePath: string,
  ): {
    id: string;
    question: string;
    context: string;
    priority: number;
    resolved: boolean;
    created: string;
    filePath: string;
  } | null;
  readonly proceduresDir: string;
  readonly questionsDir: string;
  readColdWriteVersion(): number;
  /** Secure-store key identity for keying decrypted-corpus caches (#1902). */
  hotCacheKeyId(): string;
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
  readParsedMemoriesFromPaths(
    filePaths: string[],
    batchSize?: number,
    options?: CorpusReadOptions,
  ): Promise<MemoryFile[]>;
  readStorageSecureFile(filePath: string): Promise<string>;
  readWindowBoundedBatch(
    candidateBatchPaths: string[],
    remainingSlots: number,
    remainingInspectionBudget: number,
    readBatchSize: number,
    options?: CorpusReadOptions,
  ): Promise<{ memories: MemoryFile[]; filePaths: string[] }>;
  readonly reasoningTracesDir: string;
  resolveTierRootDir(tier: "hot" | "cold"): string;
  readonly wearablesDir: string;
}

/**
 * Markdown under this store's `entities/` directory. The first relative
 * segment must be `entities`; a memory root whose absolute path contains
 * that name is not an entity store.
 */
function isStoreEntityMarkdown(baseDir: string, filePath: string): boolean {
  if (!filePath.endsWith(".md")) return false;
  const relative = path.relative(baseDir, filePath);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0] === "entities";
}

export class MemoryReadStore {
  constructor(
    private readonly deps: MemoryReadStoreDeps,
  ) {}

  /**
   * List stored transcript days, newest first, optionally scoped to one
   * source. Non-transcript files in the tree are ignored.
   */
  async listWearableTranscriptDays(
    sourceId?: string,
  ): Promise<Array<{ source: string; date: string }>> {
    const days: Array<{ source: string; date: string }> = [];
    let sources: string[];
    if (sourceId !== undefined) {
      sources = [sourceId];
    } else {
      try {
        const entries = await readdir(this.deps.wearablesDir, { withFileTypes: true });
        sources = entries
          .filter((entry) => entry.isDirectory() && !isMacOsReplicationJunkBasename(entry.name))
          .map((entry) => entry.name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    }
    for (const source of sources) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(source)) continue;
      let entries: string[];
      try {
        entries = await readdir(path.join(this.deps.wearablesDir, source));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      for (const entry of entries) {
        if (isMacOsReplicationJunkBasename(entry) || !entry.endsWith(".md")) continue;
        const date = entry.slice(0, -3);
        if (!isValidTranscriptDate(date)) continue;
        days.push({ source, date });
      }
    }
    days.sort((a, b) => {
      if (a.date > b.date) return -1;
      if (a.date < b.date) return 1;
      if (a.source < b.source) return -1;
      if (a.source > b.source) return 1;
      return 0;
    });
    return days;
  }

  async readAllArtifactsCached(options?: CorpusReadOptions): Promise<MemoryFile[]> {
    checkCorpusReadAbort(options);
    if (
      this.deps.artifactIndexCache &&
      Date.now() - this.deps.artifactIndexCache.loadedAtMs <= this.deps.storageManagerClass.ARTIFACT_INDEX_CACHE_TTL_MS &&
      this.deps.artifactIndexCache.writeVersion === this.deps.getArtifactWriteVersion()
    ) {
      return this.deps.artifactIndexCache.memories;
    }

    const scanArtifacts = async (): Promise<MemoryFile[]> => {
      const artifacts: MemoryFile[] = [];
      const readDir = async (dir: string) => {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            checkCorpusReadAbort(options);
            if (isMacOsReplicationJunkBasename(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await readDir(fullPath);
              continue;
            }
            if (!entry.name.endsWith(".md")) continue;
            const memory = await this.deps.readMemoryByPath(fullPath);
            if (!memory) continue;
            artifacts.push(memory);
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
          // Directory doesn't exist yet
        }
      };
      await readDir(this.deps.artifactsDir);
      return artifacts;
    };

    const MAX_REBUILD_RETRIES = 2;
    let latestArtifacts: MemoryFile[] = [];
    for (let attempt = 0; attempt <= MAX_REBUILD_RETRIES; attempt += 1) {
      checkCorpusReadAbort(options);
      const versionBefore = this.deps.getArtifactWriteVersion();
      const artifacts = await scanArtifacts();
      const versionAfter = this.deps.getArtifactWriteVersion();
      latestArtifacts = artifacts;
      checkCorpusReadAbort(options);
      if (versionAfter === versionBefore) {
        this.deps.artifactIndexCache = { memories: artifacts, loadedAtMs: Date.now(), writeVersion: versionAfter };
        return artifacts;
      }
    }

    this.deps.artifactIndexCache = null;
    return latestArtifacts;
  }

  /**
   * Recursively collect `*.md` paths under `startDirs`, hardened against symlink
   * escape: a category dir symlinked outside memoryDir (e.g. decisions/ -> an
   * external dir) must NOT pull out-of-store files into a scan (info leak).
   *
   * The walk runs in the corpus-scan worker: it is one `readdir` + `lstat` per
   * directory over the whole corpus, and on the main event loop that starves
   * observe, recall and the extraction queue behind it. The implementation is
   * shared (src/corpus-scan.ts) and the host runs it inline when no worker
   * can start, so the collected path set is the same either way.
   * Paths only — no frontmatter parse.
   */
  private async collectContainedMarkdownPaths(
    startDirs: readonly string[],
    propagateReadErrors = false,
    options?: CorpusReadOptions,
  ): Promise<string[]> {
    checkCorpusReadAbort(options);
    const filePaths = await corpusScanWorker.request(
      {
        kind: "walk",
        baseDir: this.deps.baseDir,
        startDirs: [...startDirs],
        propagateReadErrors,
      },
      options?.abortSignal,
    );
    checkCorpusReadAbort(options);
    return filePaths;
  }

  async collectActiveMemoryPaths(
    options?: { propagateReadErrors?: boolean } & CorpusReadOptions,
  ): Promise<string[]> {
    return this.collectContainedMarkdownPaths(
      RECALL_FALLBACK_DIRS.map((dir) => path.join(this.deps.baseDir, dir)),
      options?.propagateReadErrors ?? false,
      options,
    );
  }

  /**
   * Cold-tier memory paths for the corpus census (issue #2156 finding D).
   * Demoted memories move to `<baseDir>/cold/...` but stay active and reachable
   * via cold recall, so the divergence census MUST count them — otherwise two
   * replicas whose cold tiers differ show a false "converged" digest. Paths
   * only, same symlink/containment hardening as the hot scan. This is NOT part
   * of the recall fallback corpus (collectActiveMemoryPaths), whose scan is
   * intentionally unchanged.
   */
  async collectColdMemoryPaths(
    options?: { propagateReadErrors?: boolean } & CorpusReadOptions,
  ): Promise<string[]> {
    return this.collectContainedMarkdownPaths(
      [this.deps.resolveTierRootDir("cold")],
      options?.propagateReadErrors ?? false,
      options,
    );
  }

  async collectTombstoneMigrationPaths(): Promise<string[]> {
    const tiers = await Promise.all([
      this.collectActiveMemoryPaths(),
      this.collectColdMemoryPaths(),
      this.collectContainedMarkdownPaths([path.join(this.deps.baseDir, "archive")]),
    ]);
    return tiers.flat();
  }

  async readMemoriesWindow(options: {
    maxMemories?: number;
    batchSize?: number;
    updatedAfter?: Date;
    abortSignal?: AbortSignal;
  } = {}): Promise<{ memories: MemoryFile[]; filePaths: string[] }> {
    const readOptions: CorpusReadOptions = { abortSignal: options.abortSignal };
    const allPaths = await this.deps.collectActiveMemoryPaths(readOptions);
    const sortedPaths = this.deps.orderWindowPaths(allPaths);
    const maxMemories =
      typeof options.maxMemories === "number" && Number.isFinite(options.maxMemories)
        ? Math.max(1, Math.floor(options.maxMemories))
        : undefined;
    const maxCandidatePaths = maxMemories === undefined ? undefined : maxMemories * 2;
    const updatedAfterMs = options.updatedAfter?.getTime();
    const normalizedBatchSize = this.deps.normalizeMemoryReadBatchSize(options.batchSize);
    const memories: MemoryFile[] = [];
    const selectedPaths: string[] = [];

    for (let i = 0; i < sortedPaths.length; i += normalizedBatchSize) {
      checkCorpusReadAbort(readOptions);
      if (
        maxMemories !== undefined
        && (memories.length >= maxMemories || (maxCandidatePaths !== undefined && selectedPaths.length >= maxCandidatePaths))
      ) {
        return { memories, filePaths: selectedPaths };
      }
      const batchPaths = sortedPaths.slice(i, i + normalizedBatchSize);
      const candidateBatchPaths = updatedAfterMs === undefined
        ? batchPaths
        : await this.deps.filterWindowPathsByUpdatedAfter(batchPaths, updatedAfterMs);
      const remainingSlots = maxMemories === undefined ? undefined : Math.max(0, maxMemories - memories.length);
      const remainingInspectionBudget = maxCandidatePaths === undefined ? undefined : Math.max(0, maxCandidatePaths - selectedPaths.length);
      const { memories: batchMemories, filePaths: parsedCandidatePaths } = remainingSlots === undefined
        ? {
            memories: await this.deps.readParsedMemoriesFromPaths(candidateBatchPaths, normalizedBatchSize, readOptions),
            filePaths: candidateBatchPaths,
          }
        : await this.deps.readWindowBoundedBatch(
            candidateBatchPaths,
            remainingSlots,
            remainingInspectionBudget ?? remainingSlots,
            normalizedBatchSize,
            readOptions,
          );
      selectedPaths.push(...parsedCandidatePaths);
      for (const memory of batchMemories) {
        memories.push(memory);
        if (maxMemories !== undefined && memories.length >= maxMemories) {
          return { memories, filePaths: selectedPaths };
        }
      }
    }

    return { memories, filePaths: selectedPaths };
  }

  async readAllColdMemories(options?: CorpusReadOptions): Promise<MemoryFile[]> {
    checkCorpusReadAbort(options);
    const retainRaw = options?.retainRaw !== false;
    const coldRoot = this.deps.resolveTierRootDir("cold");

    const currentColdVersion = this.deps.readColdWriteVersion();

    const keyId = this.deps.hotCacheKeyId();
    const cached = retainRaw ? this.deps.storageManagerClass.coldMemoriesCache.get(coldRoot) : undefined;
    if (
      cached &&
      cached.keyId === keyId &&
      Date.now() - cached.loadedAt < this.deps.storageManagerClass.COLD_SCAN_CACHE_TTL_MS &&
      cached.coldVersion === currentColdVersion
    ) {
      return cached.memories;
    }

    const filePaths: string[] = [];

    const collectPaths = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const subdirs: string[] = [];
        for (const entry of entries) {
          if (isMacOsReplicationJunkBasename(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            subdirs.push(fullPath);
          } else if (entry.name.endsWith(".md")) {
            filePaths.push(fullPath);
          }
        }
        for (const subdir of subdirs) {
          await collectPaths(subdir);
        }
      } catch {
        // Directory does not exist yet — cold tier may be empty.
      }
    };

    await collectPaths(coldRoot);
    const memories = await this.deps.readParsedMemoriesFromPaths(filePaths, 50, options);

    if (retainRaw) {
      this.deps.storageManagerClass.coldMemoriesCache.set(coldRoot, { memories, loadedAt: Date.now(), coldVersion: currentColdVersion, keyId });
    }
    return memories;
  }

  /** Read a single memory file by its absolute path. Returns null if unreadable. */
  async readMemoryByPath(filePath: string): Promise<MemoryFile | null> {
    try {
      const raw = await readMaybeEncryptedFile(filePath, this.deps._secureStoreKey, this.deps.baseDir);
      if (isStoreEntityMarkdown(this.deps.baseDir, filePath) && isPopulatedUnnamedEntityRecord(raw)) {
        return null;
      }
      const parsed = parseFrontmatter(raw);
      if (parsed) {
        return rememberRawFrontmatter({
          path: filePath,
          frontmatter: normalizeFrontmatterForPath(
            parsed.frontmatter,
            toMemoryPathRel(this.deps.baseDir, filePath),
            parsed.content,
          ),
          content: parsed.content,
        }, raw);
      }

      if (isStoreEntityMarkdown(this.deps.baseDir, filePath)) {
        const entity = parseEntityFile(raw, this.deps.entitySchemas);
        if (!entity.name) return null;
        const nameWithoutExt = path.basename(filePath, ".md");
        const fileMtime = entity.updated
          || await stat(filePath).then((s) => s.mtime.toISOString()).catch(() => new Date(0).toISOString());
        return {
          path: filePath,
          frontmatter: {
            id: nameWithoutExt,
            category: "entity",
            created: fileMtime,
            updated: fileMtime,
            source: "entity_extraction",
            confidence: 0.9,
            confidenceTier: confidenceTier(0.9),
            tags: entity.type ? [entity.type] : [],
          },
          content: raw,
        };
      }

      return null;
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      return null;
    }
  }

  /**
   * Append a batch of `BUFFER_SURPRISE` telemetry events (issue #563 PR 3).
   *
   * Each event records a single buffer flush decision driven by the
   * surprise gate. The ledger is consumed by
   * `reportBufferSurpriseDistribution` (Doctor report) and by downstream
   * benchmark analysis. This method is fire-and-forget by contract:
   * callers log but do not fail the hot path if the append throws.
   */
  async appendBufferSurpriseEvents(
    events: BufferSurpriseEvent[],
  ): Promise<number> {
    if (events.length === 0) return 0;
    await this.deps.ensureDirectories();

    const nowIso = new Date().toISOString();
    const payload = events
      .map((event) => {
        const normalized: BufferSurpriseEvent = {
          ...event,
          event: "BUFFER_SURPRISE",
          timestamp:
            event.timestamp && event.timestamp.length > 0
              ? event.timestamp
              : nowIso,
        };
        return `${JSON.stringify(normalized)}\n`;
      })
      .join("");

    await this.deps.appendStorageSecureFile(this.deps.bufferSurpriseLedgerPath, payload);
    return events.length;
  }

  /**
   * Read the buffer-surprise ledger, most recent rows last.
   *
   * `limit` bounds the number of **valid rows** returned (not the
   * number of raw lines parsed). We parse every row, discard malformed
   * ones, then take the tail — so a partial/truncated trailing line
   * (the common failure mode after an interrupted append) cannot hide
   * otherwise-valid recent data above it.
   *
   * Non-positive / non-integer / non-finite limits return `[]` rather
   * than the entire file, matching the other ledger readers in this
   * class and protecting against `slice(-0.5)` → `slice(-0)` silently
   * devolving into an unbounded parse.
   *
   * # Performance note
   *
   * For very large ledgers (issue #563 follow-up), a tail-first reader
   * would avoid parsing the full file when only a recent window is
   * needed. We keep the full-scan implementation here because:
   *
   *   - the ledger is opt-in (flag off by default), so early deployments
   *     accumulate rows slowly;
   *   - telemetry rows are small (~200 bytes), so even 100k rows parse
   *     in well under a second;
   *   - the governance archive/cleanup flow can trim the ledger when
   *     size becomes a concern, reusing the existing maintenance hooks.
   *
   * Swap to a chunked tail-reader if production logs show this is a
   * hot path — leaving that work for a follow-up keeps this PR scoped
   * to correctness, not optimization.
   */
  async readBufferSurpriseEvents(
    options: { limit?: number } = {},
  ): Promise<BufferSurpriseEvent[]> {
    let raw: string;
    try {
      raw = await this.deps.readStorageSecureFile(this.deps.bufferSurpriseLedgerPath);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }

    let effectiveLimit: number | null = null;
    if (options.limit !== undefined) {
      if (
        typeof options.limit !== "number" ||
        !Number.isFinite(options.limit) ||
        options.limit <= 0
      ) {
        return [];
      }
      const floored = Math.floor(options.limit);
      if (floored <= 0) return [];
      effectiveLimit = floored;
    }

    const lines = raw.split("\n");
    const events: BufferSurpriseEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isValidBufferSurpriseEvent(parsed)) {
          events.push(parsed);
        }
      } catch {
        // Malformed row — fail open, skip.
      }
    }

    events.sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );

    if (effectiveLimit === null) return events;
    return events.slice(-effectiveLimit);
  }

  async readCompressionGuidelineStateFile(
    filePath: string,
  ): Promise<CompressionGuidelineOptimizerState | null> {
    const isFiniteNonNegativeInteger = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
    const isValidActionSummary = (
      value: unknown,
    ): value is NonNullable<CompressionGuidelineOptimizerState["actionSummaries"]>[number] => {
      if (!value || typeof value !== "object") return false;
      const summary = value as NonNullable<CompressionGuidelineOptimizerState["actionSummaries"]>[number];
      return (
        typeof summary.action === "string" &&
        isFiniteNonNegativeInteger(summary.total) &&
        summary.outcomes !== null &&
        typeof summary.outcomes === "object" &&
        isFiniteNonNegativeInteger(summary.outcomes.applied) &&
        isFiniteNonNegativeInteger(summary.outcomes.skipped) &&
        isFiniteNonNegativeInteger(summary.outcomes.failed) &&
        summary.quality !== null &&
        typeof summary.quality === "object" &&
        isFiniteNonNegativeInteger(summary.quality.good) &&
        isFiniteNonNegativeInteger(summary.quality.poor) &&
        isFiniteNonNegativeInteger(summary.quality.unknown)
      );
    };
    const isValidRuleUpdate = (
      value: unknown,
    ): value is NonNullable<CompressionGuidelineOptimizerState["ruleUpdates"]>[number] => {
      if (!value || typeof value !== "object") return false;
      const rule = value as NonNullable<CompressionGuidelineOptimizerState["ruleUpdates"]>[number];
      return (
        typeof rule.action === "string" &&
        typeof rule.delta === "number" &&
        Number.isFinite(rule.delta) &&
        (rule.direction === "increase" || rule.direction === "decrease" || rule.direction === "hold") &&
        (rule.confidence === "low" || rule.confidence === "medium" || rule.confidence === "high") &&
        Array.isArray(rule.notes) &&
        rule.notes.every((note) => typeof note === "string")
      );
    };

    try {
      const raw = await this.deps.readStorageSecureFile(filePath);
      const parsed = JSON.parse(raw) as Partial<CompressionGuidelineOptimizerState>;
      const sourceWindow = parsed?.sourceWindow as Partial<CompressionGuidelineOptimizerState["sourceWindow"]>;
      const eventCounts = parsed?.eventCounts as Partial<CompressionGuidelineOptimizerState["eventCounts"]>;
      const activationState =
        parsed?.activationState === "draft" || parsed?.activationState === "active"
          ? parsed.activationState
          : undefined;
      const contentHash =
        typeof parsed?.contentHash === "string" && parsed.contentHash.length > 0
          ? parsed.contentHash
          : undefined;
      const actionSummaries = Array.isArray(parsed?.actionSummaries)
        ? parsed.actionSummaries.filter(isValidActionSummary)
        : undefined;
      const ruleUpdates = Array.isArray(parsed?.ruleUpdates)
        ? parsed.ruleUpdates.filter(isValidRuleUpdate)
        : undefined;
      if (
        !isFiniteNonNegativeInteger(parsed?.version) ||
        typeof parsed?.updatedAt !== "string" ||
        parsed.updatedAt.length === 0 ||
        !sourceWindow ||
        typeof sourceWindow.from !== "string" ||
        sourceWindow.from.length === 0 ||
        typeof sourceWindow.to !== "string" ||
        sourceWindow.to.length === 0 ||
        !eventCounts ||
        !isFiniteNonNegativeInteger(eventCounts.total) ||
        !isFiniteNonNegativeInteger(eventCounts.applied) ||
        !isFiniteNonNegativeInteger(eventCounts.skipped) ||
        !isFiniteNonNegativeInteger(eventCounts.failed) ||
        !isFiniteNonNegativeInteger(parsed?.guidelineVersion)
      ) {
        return null;
      }

      return {
        version: parsed.version,
        updatedAt: parsed.updatedAt,
        sourceWindow: {
          from: sourceWindow.from,
          to: sourceWindow.to,
        },
        eventCounts: {
          total: eventCounts.total,
          applied: eventCounts.applied,
          skipped: eventCounts.skipped,
          failed: eventCounts.failed,
        },
        guidelineVersion: parsed.guidelineVersion,
        ...(contentHash ? { contentHash } : {}),
        ...(activationState ? { activationState } : {}),
        ...(actionSummaries ? { actionSummaries } : {}),
        ...(ruleUpdates ? { ruleUpdates } : {}),
      };
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async readQuestions(
    opts?: { unresolvedOnly?: boolean },
  ): Promise<
    Array<{
      id: string;
      question: string;
      context: string;
      priority: number;
      resolved: boolean;
      created: string;
      filePath: string;
    }>
  > {
    const cacheKey = this.deps.questionsDir;
    const cached = this.deps.storageManagerClass.questionsCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < this.deps.storageManagerClass.QUESTIONS_CACHE_TTL_MS) {
      try {
        const dirStat = await stat(this.deps.questionsDir);
        if (dirStat.mtimeMs <= cached.loadedAt) {
          const all = cached.questions;
          return opts?.unresolvedOnly ? all.filter((q) => !q.resolved) : all;
        }
      } catch {
        // Dir doesn't exist — fall through to re-read
      }
    }

    try {
      const files = await readdir(this.deps.questionsDir);
      const questions = [];
      for (const file of files) {
        if (isMacOsReplicationJunkBasename(file) || !file.endsWith(".md")) continue;
        const filePath = path.join(this.deps.questionsDir, file);
        const raw = await readMaybeEncryptedFile(filePath, this.deps._secureStoreKey, this.deps.baseDir);
        const parsed = this.deps.parseQuestionFile(raw, filePath);
        if (parsed) {
          questions.push(parsed);
        }
      }
      const sorted = questions.sort((a, b) => b.priority - a.priority);
      this.deps.storageManagerClass.questionsCache.set(cacheKey, { questions: sorted, loadedAt: Date.now() });
      return opts?.unresolvedOnly ? sorted.filter((q) => !q.resolved) : sorted;
    } catch {
      return [];
    }
  }
}
export { readWindowedMemories, type WindowedMemoryReadOptions, type WindowedMemoryReadResult } from "./windowed-memory-read.js";
