/**
 * Shared storage-contract test harness (issues #1522 + #1533).
 *
 * Two complementary halves live here:
 *   - #1533 Phase A: scratch-dir fixtures, the PluginConfig factory for the
 *     router, the public write-surface enumerator (one place — #1522 layers its
 *     catalog-touch assertion on top), and chmod fault-injection helpers.
 *   - #1522 catalog-write-chokepoint: a fully-wired catalog+router fixture
 *     (createStorageFixture) that exposes lastWriteAt(ns) + settleWriteTouches()
 *     so the fitness test can assert catalog-touch parity per write entry point.
 *
 * Phase A contracts the CURRENT public surface of `storage.ts` (no refactoring
 * — tests are written against `StorageManager` as-is). These tests never change
 * during Phase B seam moves; they are the behavior-preserving backbone.
 */

import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { chmodSync } from "node:fs";

import type { PluginConfig, MemoryCategory } from "../../packages/remnic-core/src/types.js";
import {
  StorageManager,
  ContentHashIndex,
} from "../../packages/remnic-core/src/storage.js";
import { NamespaceCatalog } from "../../packages/remnic-core/src/namespaces/catalog.js";
import { NamespaceStorageRouter } from "../../packages/remnic-core/src/namespaces/storage.js";
import { parseConfig } from "../../packages/remnic-core/src/config.js";

// ---------------------------------------------------------------------------
// #1522 catalog-write-chokepoint fixture (UNION with origin/main)
// ---------------------------------------------------------------------------

/**
 * Offline-safe config for storage-contract tests: QMD off, embedding fallback
 * off, namespaces ENABLED (the catalog is inert without it), extraction
 * thresholds floored, consolidation far out.
 */
export function makeStorageTestConfig(
  memoryDir: string,
  overrides: Record<string, unknown> = {},
): PluginConfig {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    triggerMode: "smart",
    bufferMaxTurns: 10,
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    consolidateEveryN: 50,
    initGateTimeoutMs: 1000,
    ...overrides,
  });
}

/**
 * A fully-wired storage-contract fixture: temp memoryDir, catalog, router
 * (with catalog attached per #1522), and a pre-resolved StorageManager for
 * the given namespace. Cleaned up via `fixture.cleanup()`.
 */
export interface StorageContractFixture {
  readonly memoryDir: string;
  readonly config: PluginConfig;
  readonly catalog: NamespaceCatalog;
  readonly router: NamespaceStorageRouter;
  /** Get (or create+cache) the StorageManager for a namespace via the router. */
  storageFor(namespace: string): Promise<StorageManager>;
  /** Read the catalog's lastWriteAt for a namespace (undefined if not registered). */
  lastWriteAt(namespace: string): Promise<string | undefined>;
  /** Await all pending fire-and-forget write touches for the router. */
  settleWriteTouches(): Promise<void>;
  /** Remove the temp dir, retrying transient ENOTEMPTY. */
  cleanup(): Promise<void>;
}

/**
 * Build a fully-wired storage-contract fixture for `namespace` (default
 * "default"): temp memoryDir, a NamespaceCatalog with configured namespaces
 * registered, a NamespaceStorageRouter whose `onResolve` hook feeds the
 * catalog (per #1522's unified write-path), and a pre-warmed StorageManager.
 * The fitness test iterates `enumeratePublicWriteSurface()` against this
 * fixture and asserts `lastWriteAt(ns)` moves for the target namespace only.
 */
export async function createStorageFixture(
  namespace: string = "default",
  overrides: Record<string, unknown> = {},
): Promise<StorageContractFixture> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-storage-contract-"));
  const config = makeStorageTestConfig(memoryDir, overrides);
  const catalog = new NamespaceCatalog(config);
  await catalog.registerConfiguredNamespaces();

  const router = new NamespaceStorageRouter(
    config,
    {
      onResolve: (ns, dir) => catalog.registerResolved(ns, dir),
    },
    catalog,
  );

  // storageCache is a runtime cache (dynamic insert + lookup by namespace),
  // so Map is the correct shape here per the project's Record-vs-Map rule.
  const storageCache = new Map<string, StorageManager>();

  const fixture: StorageContractFixture = {
    memoryDir,
    config,
    catalog,
    router,
    async storageFor(ns: string) {
      let sm = storageCache.get(ns);
      if (!sm) {
        sm = await router.storageFor(ns);
        storageCache.set(ns, sm);
      }
      return sm;
    },
    async lastWriteAt(ns: string) {
      const rec = await catalog.getNamespaceRecord(ns);
      return rec?.lastWriteAt;
    },
    settleWriteTouches: () => router.whenWriteTouchesSettled(),
    async cleanup() {
      // Retry transient ENOTEMPTY/EBUSY (background indexers on macOS/Windows).
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rm(memoryDir, { recursive: true, force: true });
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOTEMPTY" && code !== "EBUSY") throw err;
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 100 * (attempt + 1));
          await promise;
        }
      }
    },
  };

  // Pre-warm the namespace's storage so the catalog registers it.
  await fixture.storageFor(namespace);
  await router.whenResolveHooksSettled();

  return fixture;
}

/**
 * Scratch dir prefix used by every contract test so leaks are greppable.
 * Keeps the legacy `openclaw-engram-` lineage so temp cleansweep scripts that
 * target the old product name still pick these up.
 */
export const SCRATCH_PREFIX = "openclaw-engram-storage-contract-";

/**
 * Create a unique scratch memory dir. Returns the absolute path; the caller is
 * responsible for cleanup (use `withScratchStorage` for auto-cleanup).
 */
export async function createScratchDir(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `${SCRATCH_PREFIX}${label}-`));
}

/**
 * Run a body with a fresh scratch dir + StorageManager; always recursive-rm.
 * The StorageManager is constructed with the scratch dir as its baseDir and
 * `ensureDirectories()` is awaited before the body runs, mirroring how every
 * real caller prepares the store.
 */
export async function withScratchStorage<T>(
  label: string,
  body: (storage: StorageManager, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await createScratchDir(label);
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    return await body(storage, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run a body with just a scratch dir (no StorageManager) for tests that need
 * to poke the filesystem directly — atomic-write failure injection, etc.
 */
export async function withScratchDir<T>(
  label: string,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await createScratchDir(label);
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Recompute the canonical fact-content hash the way `StorageManager.writeMemory`
 * does for `category: "fact"` — `ContentHashIndex.computeHash` over the
 * sanitized raw body. Exported so the rule-23 pin test (write-side and dedup
 * side hash the same raw content) does not re-implement the algorithm.
 */
export function computeFactContentHash(rawContent: string): string {
  return ContentHashIndex.computeHash(rawContent);
}

/**
 * Full `PluginConfig` for `NamespaceStorageRouter` tests. Mirrors the shape
 * `tests/namespaces-router.test.ts` uses; the router reads `memoryDir`,
 * `namespacesEnabled`, `defaultNamespace`, `sharedNamespace`, `entitySchemas`
 * (and ignores most other fields). Override per-test with `overrides`.
 */
export function makeNamespaceRouterConfig(
  memoryDir: string,
  overrides: Partial<PluginConfig> = {},
): PluginConfig {
  // Build the fields NamespaceStorageRouter actually reads (memoryDir,
  // namespacesEnabled, defaultNamespace, sharedNamespace, entitySchemas).
  // Cast through unknown: PluginConfig has ~480 optional fields the router
  // never touches, and enumerating them all would couple this harness to every
  // config addition. Mirrors the pattern in tests/namespaces-router.test.ts.
  const base = {
    openaiApiKey: undefined,
    model: "gpt-5.5",
    reasoningEffort: "low",
    triggerMode: "smart",
    bufferMaxTurns: 5,
    bufferMaxMinutes: 15,
    consolidateEveryN: 3,
    highSignalPatterns: [],
    maxMemoryTokens: 2000,
    qmdEnabled: false,
    qmdCollection: "openclaw-engram",
    qmdMaxResults: 8,
    memoryDir,
    debug: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    identityInjectionMode: "recovery_only",
    identityMaxInjectChars: 1200,
    continuityIncidentLoggingEnabled: false,
    continuityAuditEnabled: false,
    injectQuestions: false,
    commitmentDecayDays: 90,
    workspaceDir: path.join(memoryDir, "workspace"),
    accessTrackingEnabled: false,
    accessTrackingBufferMaxSize: 100,
    recencyWeight: 0.2,
    boostAccessCount: true,
    recordEmptyRecallImpressions: false,
    queryExpansionEnabled: false,
    queryExpansionMaxQueries: 4,
    queryExpansionMinTokenLen: 3,
    rerankEnabled: false,
    rerankProvider: "local",
    rerankMaxCandidates: 10,
    rerankTimeoutMs: 1000,
    rerankCacheEnabled: true,
    rerankCacheTtlMs: 1000,
    feedbackEnabled: false,
    negativeExamplesEnabled: false,
    negativeExamplesPenaltyPerHit: 0.05,
    negativeExamplesPenaltyCap: 0.25,
    chunkingEnabled: false,
    chunkingTargetTokens: 200,
    chunkingMinTokens: 150,
    chunkingOverlapSentences: 2,
    contradictionDetectionEnabled: false,
    contradictionSimilarityThreshold: 0.7,
    contradictionMinConfidence: 0.9,
    contradictionAutoResolve: true,
    memoryLinkingEnabled: false,
    threadingEnabled: false,
    threadingGapMinutes: 30,
    summarizationEnabled: false,
    summarizationTriggerCount: 1000,
    summarizationRecentToKeep: 300,
    summarizationImportanceThreshold: 0.3,
    summarizationProtectedTags: [],
    topicExtractionEnabled: false,
    topicExtractionTopN: 50,
    transcriptEnabled: false,
    transcriptRetentionDays: 7,
    transcriptSkipChannelTypes: ["cron"],
    transcriptRecallHours: 12,
    maxTranscriptTurns: 50,
    maxTranscriptTokens: 1000,
    checkpointEnabled: false,
    checkpointTurns: 15,
    hourlySummariesEnabled: false,
    hourlySummaryCronAutoRegister: false,
    summaryRecallHours: 24,
    maxSummaryCount: 6,
    summaryModel: "gpt-5.5",
    hourlySummariesExtendedEnabled: false,
    hourlySummariesIncludeToolStats: false,
    hourlySummariesIncludeSystemMessages: false,
    hourlySummariesMaxTurnsPerRun: 60,
    conversationIndexEnabled: false,
    conversationIndexBackend: "qmd",
    conversationIndexQmdCollection: "openclaw-engram-convo",
    conversationIndexRetentionDays: 14,
    conversationRecallTopK: 3,
    conversationRecallMaxChars: 2000,
    conversationRecallTimeoutMs: 500,
    localLlmEnabled: false,
    localLlmUrl: "http://localhost:1234/v1",
    localLlmModel: "local-model",
    localLlmFallback: true,
    localLlmTimeoutMs: 1000,
    slowLogEnabled: false,
    slowLogThresholdMs: 30_000,
    extractionDedupeEnabled: true,
    extractionDedupeWindowMs: 60_000,
    extractionMinChars: 20,
    extractionMinUserTurns: 1,
    extractionMaxTurnChars: 4000,
    extractionMaxFactsPerRun: 12,
    extractionMaxEntitiesPerRun: 6,
    extractionMaxQuestionsPerRun: 3,
    extractionMaxProfileUpdatesPerRun: 4,
    consolidationRequireNonZeroExtraction: true,
    consolidationMinIntervalMs: 60_000,
    qmdMaintenanceEnabled: true,
    qmdMaintenanceDebounceMs: 500,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 60_000,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 50,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 10_000,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    namespacePolicies: [],
    defaultRecallNamespaces: ["self"],
    cronRecallMode: "all",
    cronRecallAllowlist: [],
    autoPromoteToSharedEnabled: false,
    autoPromoteToSharedCategories: ["correction"],
    autoPromoteMinConfidenceTier: "explicit",
    sharedContextEnabled: false,
    sharedContextDir: undefined,
    sharedContextMaxInjectChars: 4000,
    crossSignalsSemanticEnabled: false,
    crossSignalsSemanticTimeoutMs: 1000,
    compoundingEnabled: false,
    compoundingWeeklyCronEnabled: false,
    compoundingSemanticEnabled: false,
    compoundingSynthesisTimeoutMs: 1000,
    compoundingInjectEnabled: false,
  } as unknown as PluginConfig;
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Public write-surface enumerator (shared with #1522's fitness test)
// ---------------------------------------------------------------------------

/** Storage sub-surface a write entry point exercises. */
export type PublicWriteKind =
  | "memory"
  | "artifact"
  | "entity"
  | "profile"
  | "question"
  | "chunk";

/**
 * Every `MemoryCategory`, enumerated once and fail-closed against the union.
 * `satisfies Record<MemoryCategory, unknown>` makes the object literal carry
 * EVERY category, so adding a value to `MemoryCategory` is a compile error
 * here until it is listed — the surface entries and the category-coverage test
 * both flow from this list, so a new category cannot silently ship without a
 * `writeMemory(<category>)` surface entry. Removing a category from the union
 * likewise fails because the orphaned key no longer satisfies the Record.
 */
export const ALL_MEMORY_CATEGORIES = Object.keys({
  fact: 1,
  preference: 1,
  decision: 1,
  correction: 1,
  commitment: 1,
  moment: 1,
  principle: 1,
  relationship: 1,
  rule: 1,
  skill: 1,
  procedure: 1,
  reasoning_trace: 1,
  entity: 1,
} satisfies Record<MemoryCategory, unknown>) as MemoryCategory[];

/**
 * One entry in the public storage WRITE surface. #1522's catalog-touch fitness
 * test iterates this list, calls `write(storage)`, and asserts the target
 * namespace's `lastWriteAt` moved (and only the target's).
 *
 * `write` returns the persisted id/path (or `""` when the entry legitimately
 * no-ops on invalid input). The return value is surfaced so contract tests can
 * round-trip the just-written record.
 */
export interface PublicWriteSurfaceEntry {
  /** Stable human label; #1522 uses it in fitness-test failure messages. */
  name: string;
  /** Storage sub-surface exercised. */
  kind: PublicWriteKind;
  /**
   * Optional fixture setup run BEFORE the measured `write`, OUTSIDE any
   * lastWriteAt / catalog-touch measurement window. Use this for STATEFUL
   * entries whose operation under test needs a pre-existing record (e.g.
   * updateMemoryFrontmatter needs a memory to patch). Returns a context value
   * forwarded to `write` as its second argument. Consumers MUST call `setup`
   * (when present) before `write` and MUST NOT count the setup call towards
   * the measured catalog-touch — only `write` is the measured operation.
   */
  setup?: (storage: StorageManager) => Promise<unknown>;
  /**
   * The MEASURED write operation against `storage`. Returns the persisted
   * id/path or `""` for a documented no-op. `setupContext` is the value
   * returned by `setup` (undefined when the entry has no setup). MUST NOT
   * depend on prior state beyond an empty store having had
   * `ensureDirectories()` called (plus whatever `setup` created).
   */
  write: (storage: StorageManager, setupContext?: unknown) => Promise<string>;
}

/**
 * The public storage WRITE surface, enumerated once. Add new public write
 * entry points here as they land on `StorageManager`; the
 * `surface-catalog.test.ts` regression locks the count so a new write path
 * cannot silently bypass #1522's catalog-touch check.
 *
 * Order is stable (memory categories → artifact → entity → profile → question
 * → chunk) so #1522's per-entry failure messages are deterministic.
 */
export function enumeratePublicWriteSurface(): PublicWriteSurfaceEntry[] {
  const memoryCategories = ALL_MEMORY_CATEGORIES;
  const memoryEntries: PublicWriteSurfaceEntry[] = memoryCategories.map((category) => ({
    name: `writeMemory(${category})`,
    kind: "memory",
    write: async (storage) => {
      const { id: id } = await storage.writeMemory(category, `contract-surface-${category}-body`, {
        confidence: 0.85,
        tags: ["contract-surface"],
      });
      // Verify persistence by reading back — a regression that returns an id
      // without writing (or writes the wrong path) must fail here.
      if (!(await storage.getMemoryById(id))) {
        throw new Error(`writeMemory(${category}) did not persist a readable memory`);
      }
      return id;
    },
  }));

  return [
    ...memoryEntries,
    {
      name: "updateMemoryFrontmatter",
      kind: "memory",
      // STATEFUL ENTRY: `setup` creates the parent record OUTSIDE the measured
      // window so #1522's catalog-touch consumer attributes lastWriteAt movement
      // to updateMemoryFrontmatter alone, never to the setup writeMemory. The
      // `write` callback receives the parent id as setupContext.
      setup: async (storage) => {
        return (await storage.writeMemory(
          "fact",
          "contract-surface frontmatter parent",
          { tags: ["contract-surface"] },
        )).id;
      },
      write: async (storage, setupContext) => {
        const id = setupContext as string;
        const ok = await storage.updateMemoryFrontmatter(id, { confidence: 0.5 });
        if (!ok) {
          throw new Error("updateMemoryFrontmatter returned false for a just-written memory");
        }
        // Verify the OPERATION persisted (not just the setup write): the
        // patched confidence must round-trip through a fresh read.
        const updated = await storage.getMemoryById(id);
        if (!updated || updated.frontmatter.confidence !== 0.5) {
          throw new Error("updateMemoryFrontmatter did not persist the frontmatter patch");
        }
        return id;
      },
    },
    {
      name: "updateMemory",
      kind: "memory",
      // STATEFUL ENTRY: `setup` creates the record to rewrite OUTSIDE the
      // measured window so #1522's catalog-touch consumer attributes lastWriteAt
      // movement to updateMemory alone. Without this entry a regression where
      // updateMemory stops touching the namespace catalog would pass silently —
      // the surface jumped from writeMemory to updateMemoryFrontmatter and never
      // measured this method even though production callers invoke it directly.
      setup: async (storage) => {
        return (await storage.writeMemory(
          "fact",
          "contract-surface updateMemory original body",
          { tags: ["contract-surface"] },
        )).id;
      },
      write: async (storage, setupContext) => {
        const id = setupContext as string;
        const ok = await storage.updateMemory(id, "contract-surface updateMemory rewritten body");
        if (!ok) {
          throw new Error("updateMemory returned false for a just-written memory");
        }
        // Verify the OPERATION persisted (not the setup write): the rewritten
        // body must round-trip through a fresh read.
        const updated = await storage.getMemoryById(id);
        if (!updated || !updated.content.includes("updateMemory rewritten body")) {
          throw new Error("updateMemory did not persist the rewritten content");
        }
        return id;
      },
    },
    {
      name: "writeMemoryFrontmatter",
      kind: "memory",
      // STATEFUL ENTRY: distinct from the ID-based updateMemoryFrontmatter —
      // production callers invoke writeMemoryFrontmatter(memory, patch) directly
      // (forget.ts, access-service.ts). setup creates the parent outside the
      // measured window; the getMemoryById inside write is a READ (does not move
      // lastWriteAt) so only writeMemoryFrontmatter is the measured catalog write.
      // Without this entry an impl that touches the catalog in the ID-based
      // wrapper but not this direct method would bypass #1522's fitness test.
      setup: async (storage) => {
        return (await storage.writeMemory(
          "fact",
          "contract-surface writeMemoryFrontmatter parent",
          { tags: ["contract-surface"] },
        )).id;
      },
      write: async (storage, setupContext) => {
        const id = setupContext as string;
        const memory = await storage.getMemoryById(id);
        if (!memory) {
          throw new Error("writeMemoryFrontmatter setup memory not readable");
        }
        const ok = await storage.writeMemoryFrontmatter(memory, { confidence: 0.5 });
        if (!ok) {
          throw new Error("writeMemoryFrontmatter returned false for a just-written memory");
        }
        // Verify the OPERATION persisted: the patched confidence must round-trip.
        const updated = await storage.getMemoryById(id);
        if (!updated || updated.frontmatter.confidence !== 0.5) {
          throw new Error("writeMemoryFrontmatter did not persist the frontmatter patch");
        }
        return id;
      },
    },
    {
      name: "writeArtifact",
      kind: "artifact",
      write: async (storage) => {
        const id = await storage.writeArtifact("contract-surface-artifact-body", {
          artifactType: "fact",
          tags: ["contract-surface"],
        });
        // No public read-by-id for artifacts; verify the file landed on disk.
        // Scan artifacts/ for the just-written id rather than reconstructing
        // the path from a separate new Date() — writeArtifact derives its own
        // day internally, so a clock-derived path could miss across UTC
        // midnight and a regression that returns an id without writing would
        // pass spuriously.
        const entries = await readdir(path.join(storage.dir, "artifacts"), { recursive: true });
        const match = entries.find((e) => e.endsWith(`${id}.md`));
        if (!match) {
          throw new Error("writeArtifact did not persist a readable artifact file");
        }
        // Read the body back — a regression returning an id but writing an
        // empty or corrupt file would pass the filename check alone. Proving the
        // content persisted closes that spurious-pass hole.
        const artifactBody = await readFile(path.join(storage.dir, "artifacts", match), "utf8");
        if (!artifactBody.includes("contract-surface-artifact-body")) {
          throw new Error("writeArtifact did not persist the artifact body (round-trip mismatch)");
        }
        return id;
      },
    },
    {
      name: "writeEntity",
      kind: "entity",
      write: async (storage) => {
        const slug = await storage.writeEntity(
          `Contract Surface Entity ${Date.now()}`,
          "person",
          ["contract-surface entity fact"],
        );
        // Verify BOTH that the entity is listed AND its body round-trips.
        // readEntities() only lists filenames — a regression that creates an
        // empty or corrupt file with the right slug would pass that check
        // alone. Reading the body via readEntity(slug) proves the facts/content
        // actually persisted, not just the filename.
        const entities = await storage.readEntities();
        if (!entities.includes(slug)) {
          throw new Error("writeEntity did not persist a readable entity");
        }
        const body = await storage.readEntity(slug);
        if (!body || !body.includes("contract-surface entity fact")) {
          throw new Error("writeEntity did not persist the entity body (round-trip mismatch)");
        }
        return slug;
      },
    },
    {
      name: "writeProfile",
      kind: "profile",
      write: async (storage) => {
        await storage.writeProfile("# Profile\n\ncontract-surface profile\n");
        // writeProfile returns void, so verify persistence by reading back — a
        // silent no-op (or a write to the wrong path) must fail the surface
        // test rather than pass on a fabricated non-empty return.
        const readBack = await storage.readProfile();
        if (!readBack.includes("contract-surface profile")) {
          throw new Error("writeProfile did not persist profile.md (read-back mismatch)");
        }
        return "profile.md";
      },
    },
    {
      name: "writeQuestion",
      kind: "question",
      write: async (storage) => {
        const id = await storage.writeQuestion(
          "<question>contract-surface question?</question>",
          "surface",
          1,
        );
        // Verify the question is readable so a regression that returns an id
        // without writing fails the surface test.
        const questions = await storage.readQuestions();
        if (!questions.some((q) => q.id === id)) {
          throw new Error("writeQuestion did not persist a readable question");
        }
        return id;
      },
    },
    {
      name: "writeChunk",
      kind: "chunk",
      // STATEFUL ENTRY: `setup` creates the parent memory OUTSIDE the measured
      // window so #1522's catalog-touch consumer attributes lastWriteAt movement
      // to writeChunk alone, never to the setup writeMemory.
      setup: async (storage) => {
        return (await storage.writeMemory(
          "fact",
          "contract-surface chunk parent",
          { tags: ["contract-surface"] },
        )).id;
      },
      write: async (storage, setupContext) => {
        const parentId = setupContext as string;
        // Return the CHUNK id (`${parentId}-chunk-0`), not the parent id, so
        // the catalog fitness test observes the chunk write — a regression
        // that drops the chunk while the parent persists would otherwise pass
        // on a non-empty parent id. Verify the chunk is readable too.
        const chunkId = await storage.writeChunk(parentId, 0, 1, "fact", "contract-surface chunk body");
        if (!(await storage.getMemoryById(chunkId))) {
          throw new Error("writeChunk did not persist a readable chunk memory");
        }
        return chunkId;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Permission fault-injection predicate + chmod helpers (rule 54)
// ---------------------------------------------------------------------------

/**
 * `true` only when chmod-based fault injection meaningfully denies access:
 * a POSIX platform where the test process is NOT uid 0. Root bypasses Unix
 * mode bits, so `chmod(0o500)`/`chmod(0o000)` would still let writes/reads
 * succeed and the atomicity / failure-semantics assertions would fail
 * spuriously — common in Docker-based CI that runs as root. Tests that depend
 * on chmod-driven failures gate themselves on this predicate (see
 * `SKIP_ATOMIC` in atomic-write.test.ts and `SKIP_PERM` in
 * failure-semantics.test.ts) rather than on `platform === "win32"` alone.
 */
export const PERM_FAULT_INJECTION_AVAILABLE: boolean =
  process.platform !== "win32" &&
  typeof process.getuid === "function" &&
  process.getuid() !== 0;

/**
 * Sync chmod scoped to a scratch path we just created. Used by the atomicity
 * test to make a parent dir read-only so `writeMaybeEncryptedFile`'s temp
 * write inside it fails — proving the temp-then-rename contract leaves the
 * original file intact when the write is rejected (rule 54: never
 * delete-before-write). No-op on Windows and when running as root (where mode
 * bits cannot deny the owner access; tests relying on the lock skip via
 * `PERM_FAULT_INJECTION_AVAILABLE`).
 */
export function setDirReadOnly(targetPath: string): void {
  if (!PERM_FAULT_INJECTION_AVAILABLE) return;
  // 0o500 = r-x for owner; the dir already exists, we own it.
  chmodSync(targetPath, 0o500);
}

/** Restore full owner perms after `setDirReadOnly`. */
export function setDirReadWrite(targetPath: string): void {
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  chmodSync(targetPath, 0o700);
}
