/**
 * Memory read store (extracted from storage.ts StorageManager; god-file
 * decomposition, #1526 playbook: verbatim move + live selfDeps wiring).
 *
 * Owns the bulk/windowed read surfaces of the storage layer: active
 * memory path collection, windowed and cold reads, path-addressed reads,
 * cached artifact index reads, questions, buffer-surprise ledger
 * read/append, compression-guideline state, and wearable transcript-day
 * listing.
 */

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { toMemoryPathRel } from "../memory-lifecycle-ledger-utils.js";
import { SecureStoreLockedError, readMaybeEncryptedFile } from "../secure-store/secure-fs.js";
import { type BufferSurpriseEvent, type CompressionGuidelineOptimizerState, type MemoryFile, type PluginConfig, confidenceTier } from "../types.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { isErrnoCode } from "../utils/errno.js";
import { assertPathInsideRoot } from "../utils/path-containment.js";
import { isValidTranscriptDate } from "../wearables/day-store.js";
import {
  isValidBufferSurpriseEvent,
  normalizeFrontmatterForPath,
  parseEntityFile,
  parseFrontmatter,
  StorageManager,
} from "../storage.js";

export interface MemoryReadStoreDeps {
  /** Live class object of the host instance — shared static caches (see storage.ts storageManagerClass). */
  readonly storageManagerClass: typeof StorageManager;
  readonly _secureStoreKey: Buffer | null;
  appendStorageSecureFile(filePath: string, content: string): Promise<void>;
  artifactIndexCache: { memories: MemoryFile[]; loadedAtMs: number; writeVersion: number } | null;
  readonly artifactsDir: string;
  readonly baseDir: string;
  readonly bufferSurpriseLedgerPath: string;
  collectActiveMemoryPaths(): Promise<string[]>;
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
  ): Promise<MemoryFile[]>;
  readStorageSecureFile(filePath: string): Promise<string>;
  readWindowBoundedBatch(
    candidateBatchPaths: string[],
    remainingSlots: number,
    remainingInspectionBudget: number,
    readBatchSize: number,
  ): Promise<{ memories: MemoryFile[]; filePaths: string[] }>;
  readonly reasoningTracesDir: string;
  resolveTierRootDir(tier: "hot" | "cold"): string;
  readonly wearablesDir: string;
}

/**
 * A backend READ failure worth propagating from a strict (census) scan: an
 * errno-coded fs error that is NOT `ENOENT`. `ENOENT` (an absent dir) and
 * code-less rejections (symlink-escape containment failures from
 * assertPathInsideRoot) are expected and skipped; `EACCES`/`EIO`/… mean the
 * corpus is unreadable and a divergence census must fail loud rather than
 * silently publish a partial count (issue #2156 round-5). Non-strict (recall)
 * callers ignore this and degrade to a best-effort partial scan.
 */
function isPropagatableReadError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && code !== "ENOENT";
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
          .filter((entry) => entry.isDirectory())
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
        if (!entry.endsWith(".md")) continue;
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

  async readAllArtifactsCached(): Promise<MemoryFile[]> {
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
        } catch {
          // Directory doesn't exist yet
        }
      };
      await readDir(this.deps.artifactsDir);
      return artifacts;
    };

    const MAX_REBUILD_RETRIES = 2;
    let latestArtifacts: MemoryFile[] = [];
    for (let attempt = 0; attempt <= MAX_REBUILD_RETRIES; attempt += 1) {
      const versionBefore = this.deps.getArtifactWriteVersion();
      const artifacts = await scanArtifacts();
      const versionAfter = this.deps.getArtifactWriteVersion();
      latestArtifacts = artifacts;
      if (versionAfter === versionBefore) {
        this.deps.artifactIndexCache = { memories: artifacts, loadedAtMs: Date.now(), writeVersion: versionAfter };
        return artifacts;
      }
    }

    // Highly concurrent writer churn; keep cache invalid so next read retries a clean rebuild.
    // Return best-effort latest scan instead of an empty set to avoid dropping recall entirely.
    this.deps.artifactIndexCache = null;
    return latestArtifacts;
  }

  /**
   * Recursively collect `*.md` paths under `startDirs`, hardened against symlink
   * escape: a category dir symlinked outside memoryDir (e.g. decisions/ -> an
   * external dir) must NOT pull out-of-store files into a scan (info leak). Same
   * walker-hardening pattern as document-scanner.ts / cli.ts /
   * consolidation-provenance-check.ts; reuses the shared containment helper.
   * Paths only — no frontmatter parse.
   */
  private async collectContainedMarkdownPaths(
    startDirs: readonly string[],
    propagateReadErrors = false,
  ): Promise<string[]> {
    const filePaths: string[] = [];

    // Resolve the memory root once for the containment checks below.
    let memoryRootReal: string;
    try {
      memoryRootReal = await realpath(this.deps.baseDir);
    } catch (err) {
      // ENOENT: a not-yet-created root ⇒ empty. Any other errno is a backend
      // read failure — propagate for strict census callers (never publish an
      // unreadable corpus as empty); non-strict (recall) callers degrade.
      if (propagateReadErrors && isPropagatableReadError(err)) throw err;
      return filePaths;
    }

    const collectPaths = async (dir: string): Promise<void> => {
      // Directory-level guard, isolated from per-entry handling: skip symlinked
      // or non-directory category dirs and assert the resolved dir stays inside
      // the memory root before reading. A failure here means the whole subtree
      // does not exist or escaped the store — fail closed by skipping it.
      let dirStat: Stats;
      try {
        dirStat = await lstat(dir);
      } catch (err) {
        // ENOENT (absent category dir) is expected; a backend read error
        // (EACCES/EIO/…) propagates in strict census mode.
        if (propagateReadErrors && isPropagatableReadError(err)) throw err;
        return;
      }
      if (dirStat.isSymbolicLink()) return; // never follow symlinks out of the store (both modes)
      if (!dirStat.isDirectory()) {
        // A category root that EXISTS but is not a directory (e.g. `facts/`
        // replaced by a regular file) is a layout/backend failure: a strict
        // census must not silently publish the remaining categories as healthy.
        // Non-strict (recall) stays best-effort and skips it (issue #2156 round-10).
        if (propagateReadErrors) {
          throw new Error(`corpus scan: expected a directory but found a non-directory at ${dir}`);
        }
        return;
      }
      let entries: Dirent[];
      try {
        assertPathInsideRoot(memoryRootReal, await realpath(dir), dir);
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        // A containment failure carries no errno (skip); a backend read error
        // (EACCES …) propagates in strict census mode so a partial subtree is
        // not silently counted.
        if (propagateReadErrors && isPropagatableReadError(err)) throw err;
        return;
      }

      const subdirs: string[] = [];
      for (const entry of entries) {
        // Never follow symlinked entries out of the store.
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          subdirs.push(fullPath);
        } else if (entry.name.endsWith(".md")) {
          // Isolate per-entry failures in their own try/catch: a containment or
          // realpath failure on ONE .md entry must not drop sibling files or,
          // crucially, the deferred subdir recursion below (Cursor Bugbot:
          // "Poisoned md skips sibling subdirs"). Mirrors the per-file try/catch
          // in search/document-scanner.ts scanDir and
          // consolidation-provenance-check.ts walkMarkdownFiles.
          try {
            assertPathInsideRoot(memoryRootReal, await realpath(fullPath), fullPath);
            filePaths.push(fullPath);
          } catch (err) {
            // ENOENT (vanished mid-scan) or a code-less containment/symlink
            // rejection ⇒ skip just this file. A backend read error propagates
            // in strict census mode.
            if (propagateReadErrors && isPropagatableReadError(err)) throw err;
          }
        }
      }
      // Recurse into real subdirectories regardless of any single poisoned entry
      // above, so valid nested in-store memories are never dropped.
      for (const subdir of subdirs) {
        await collectPaths(subdir);
      }
    };

    for (const dir of startDirs) {
      await collectPaths(dir);
    }
    return filePaths;
  }

  async collectActiveMemoryPaths(options?: { propagateReadErrors?: boolean }): Promise<string[]> {
    // Scan EVERY supported memory category directory, not just the legacy four
    // (facts/procedures/reasoning-traces/corrections). Issue #1497: the QMD
    // filesystem-fallback recall path (orchestrator `recent_scan` ->
    // readAllMemoriesForNamespaces -> readAllMemories -> here) must read every
    // recall category dir so on-disk memories in preferences/decisions/moments/
    // commitments/principles/rules/skills/relationships are not missed when QMD
    // is disabled, missing, or unhealthy. RECALL_FALLBACK_DIRS is the single
    // source of truth derived from ALL_CATEGORY_DIRS (shared with
    // ensureDirectories() and the write routing in utils/category-dir.ts).
    // These paths resolve identically to the legacy this.deps.factsDir /
    // this.deps.correctionsDir / this.deps.proceduresDir / this.deps.reasoningTracesDir
    // getters (all `path.join(this.deps.baseDir, <dir>)`), so the scan stays
    // namespace-aware: this.deps.baseDir is per-namespace, set by the storage router.
    // Deliberately EXCLUDED (issue #1497 + PR #1503 review): the non-category
    // content dirs that ensureDirectories() also creates — entities/, state/,
    // artifacts/, identity/, config/ — plus the root profile.md, AND the
    // questions/ queue dir. questions/ holds operational question-QUEUE items
    // written by writeQuestion() (frontmatter `{ id, created, priority,
    // resolved }`), read only via readQuestions() and surfaced through the
    // dedicated, disabled-by-default `injectQuestions` recall-pipeline stage —
    // never as standard recall memories. The QMD primary recall corpus does not
    // include them, so the fallback must not either (corpus parity; CLAUDE.md
    // rule #39). Were questions/ scanned here, parseFrontmatter() would accept
    // those files (they have a `---` frontmatter block) and leak queue items
    // into recall. None of these excluded dirs are in RECALL_FALLBACK_DIRS; the
    // exclusion is asserted by tests in storage-fallback-category-dirs.test.ts.
    return this.collectContainedMarkdownPaths(
      RECALL_FALLBACK_DIRS.map((dir) => path.join(this.deps.baseDir, dir)),
      options?.propagateReadErrors ?? false,
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
  async collectColdMemoryPaths(options?: { propagateReadErrors?: boolean }): Promise<string[]> {
    return this.collectContainedMarkdownPaths(
      [this.deps.resolveTierRootDir("cold")],
      options?.propagateReadErrors ?? false,
    );
  }

  async readMemoriesWindow(options: {
    maxMemories?: number;
    batchSize?: number;
    updatedAfter?: Date;
  } = {}): Promise<{ memories: MemoryFile[]; filePaths: string[] }> {
    const allPaths = await this.deps.collectActiveMemoryPaths();
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
            memories: await this.deps.readParsedMemoriesFromPaths(candidateBatchPaths, normalizedBatchSize),
            filePaths: candidateBatchPaths,
          }
        : await this.deps.readWindowBoundedBatch(
            candidateBatchPaths,
            remainingSlots,
            remainingInspectionBudget ?? remainingSlots,
            normalizedBatchSize,
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

  /**
   * Read all memories from the cold tier by scanning the entire cold/ root
   * tree.  Previously this only scanned cold/facts/ and cold/corrections/, but
   * structuredAttributes can appear on any MemoryCategory (preference, decision,
   * entity, etc.).  buildTierMemoryPath now routes each category to its own
   * cold/<dir>/ subtree via the shared categoryDirName() chokepoint (issue
   * #1546), so cold decisions/preferences/... live outside cold/facts/.
   * Scanning the full coldRoot covers every category dir and guards against
   * files placed in unexpected subdirectories during manual operations or future
   * refactors.
   *
   * Broadened in PR #402 round-6 (Finding UTsP): scanning only facts/ and
   * corrections/ was a narrower-than-necessary subset of the cold directory
   * tree.  Correctness trumps the minor performance difference — cold scans
   * already happen at most once per supersession write.
   *
   * Used by applyTemporalSupersession so that memories already demoted to
   * cold/ can still be marked superseded when a newer hot fact arrives.
   *
   * Cached with a TTL (Finding UOGi, PR #402 round-6): back-to-back
   * structured-attribute writes in the same burst reuse the cached result
   * instead of re-scanning the cold tree on every call.  The cache is
   * invalidated whenever a write calls invalidateAllMemoriesCache() (which
   * covers any hot→cold demotion that changes cold-tier contents) and
   * expires after COLD_SCAN_CACHE_TTL_MS as a safety net.
   */
  async readAllColdMemories(): Promise<MemoryFile[]> {
    const coldRoot = this.deps.resolveTierRootDir("cold");

    // Read the on-disk cold-version sentinel BEFORE checking the cache so that
    // writes made by other processes (gateway + CLI) are detected immediately.
    // Finding UvUy (PR #402 round-11): without this check the cache served
    // stale data for up to 30s when another process wrote a new cold memory.
    const currentColdVersion = this.deps.readColdWriteVersion();

    // Return cached result if still valid by TTL, sentinel version, AND the
    // secure-store key identity (issue #1902). readParsedMemoriesFromPaths
    // decrypts per this manager's key, so a differently-keyed manager must not
    // read a cold corpus another instance decrypted for the same coldRoot.
    const keyId = this.deps.hotCacheKeyId();
    const cached = this.deps.storageManagerClass.coldMemoriesCache.get(coldRoot);
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

    // Scan the entire cold root so that memories in any subdirectory (facts/,
    // corrections/, artifacts/, or any future category-specific subdirectory)
    // are included.  This is broader than the previous facts/+corrections/ scan
    // and ensures that any memory with structuredAttributes is found regardless
    // of which category it was written with.
    await collectPaths(coldRoot);
    const memories = await this.deps.readParsedMemoriesFromPaths(filePaths, 50);

    // Store in cache with the sentinel version captured above so that any
    // subsequent cold-version bump (by this or another process) invalidates it.
    this.deps.storageManagerClass.coldMemoriesCache.set(coldRoot, { memories, loadedAt: Date.now(), coldVersion: currentColdVersion, keyId });
    return memories;
  }

  /** Read a single memory file by its absolute path. Returns null if unreadable. */
  async readMemoryByPath(filePath: string): Promise<MemoryFile | null> {
    try {
      const raw = await readMaybeEncryptedFile(filePath, this.deps._secureStoreKey, this.deps.baseDir);
      // Note: the outer catch intentionally swallows most errors (ENOENT etc.)
      // but SecureStoreLockedError must propagate — see re-throw below.
      const parsed = parseFrontmatter(raw);
      if (parsed) {
        return {
          path: filePath,
          frontmatter: normalizeFrontmatterForPath(
            parsed.frontmatter,
            toMemoryPathRel(this.deps.baseDir, filePath),
            parsed.content,
          ),
          content: parsed.content,
        };
      }

      // Entity files use a `# Name` + `**Type:** ...` markdown format rather than
      // YAML frontmatter. Build a synthetic MemoryFile so entity files returned by
      // the direct retrieval agent participate in boostSearchResults and last-recall
      // tracking rather than being silently dropped.
      const normalizedPath = filePath.split(path.sep).join("/");
      if (normalizedPath.includes("/entities/") && filePath.endsWith(".md")) {
        const entity = parseEntityFile(raw, this.deps.entitySchemas);
        if (!entity.name) return null;
        const nameWithoutExt = path.basename(filePath, ".md");
        // Fall back to file mtime rather than new Date() so that entities without
        // an explicit Updated: timestamp are not treated as freshly created on every
        // read. Using new Date() would inflate boostSearchResults recency scores for
        // every entity that lacks a timestamp.
        // Use epoch as the last-resort fallback so that entities without a
        // parseable timestamp don't appear as "freshly created" and inflate scores.
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
      // Re-throw store-locked errors — callers need to distinguish "locked"
      // from "file not found / parse error". Swallowing a locked error here
      // would silently return null and leave the daemon appearing to work
      // while returning no memories (subtle data loss).
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

    // Resolve the effective limit up front. Any non-finite / non-positive
    // value returns no rows — callers who want "everything" should OMIT
    // the `limit` key (treated as "no bound" below). We intentionally
    // reject `Infinity` too, because the slice math `events.slice(-Inf)`
    // is surprising and ambiguous; omit the key instead. Fractional
    // values <1 floor to 0, which would make `slice(-0)` return the
    // entire file — guard against that too.
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
    // Slice over VALID rows, not raw lines, so malformed tails cannot
    // mask good data above them. Sort by event timestamp before slicing
    // so concurrent probe completion order cannot make an older scored
    // turn look newer than a later scored turn.
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
      // Check dir mtime for cross-process invalidation — if another process
      // wrote/resolved a question, the directory mtime will be newer than loadedAt.
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
        if (!file.endsWith(".md")) continue;
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
