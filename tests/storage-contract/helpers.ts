/**
 * #1533 Phase A — shared storage-contract test harness.
 *
 * Lives at `tests/storage-contract/helpers.ts` so #1522's catalog-touch fitness
 * test can build on the SAME fixture helpers + write-surface enumerator. The
 * write-entry-point enumeration lives here in exactly one place (issue #1533
 * coordination note) — #1522 imports `enumeratePublicWriteSurface` and layers
 * its catalog-touch assertion on top rather than forking the list.
 *
 * Phase A contracts the CURRENT public surface of `storage.ts` (no refactoring
 * — tests are written against `StorageManager` as-is). These tests never change
 * during Phase B seam moves; they are the behavior-preserving backbone.
 */

import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { chmodSync } from "node:fs";

import type { PluginConfig, MemoryCategory } from "../../packages/remnic-core/src/types.js";
import {
  StorageManager,
  ContentHashIndex,
} from "../../packages/remnic-core/src/storage.js";

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
   * Perform the write against `storage`. Returns the persisted id/path or `""`
   * for a documented no-op. MUST not depend on prior state beyond an empty
   * store having had `ensureDirectories()` called.
   */
  write: (storage: StorageManager) => Promise<string>;
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
  const memoryCategories: MemoryCategory[] = [
    "fact",
    "preference",
    "decision",
    "correction",
    "commitment",
    "moment",
    "principle",
    "relationship",
    "rule",
    "skill",
    "procedure",
    "reasoning_trace",
  ];
  const memoryEntries: PublicWriteSurfaceEntry[] = memoryCategories.map((category) => ({
    name: `writeMemory(${category})`,
    kind: "memory",
    write: (storage) =>
      storage.writeMemory(category, `contract-surface-${category}-body`, {
        confidence: 0.85,
        tags: ["contract-surface"],
      }),
  }));

  return [
    ...memoryEntries,
    {
      name: "writeArtifact",
      kind: "artifact",
      write: (storage) =>
        storage.writeArtifact("contract-surface-artifact-body", {
          artifactType: "fact",
          tags: ["contract-surface"],
        }),
    },
    {
      name: "writeEntity",
      kind: "entity",
      write: (storage) =>
        storage.writeEntity(
          `Contract Surface Entity ${Date.now()}`,
          "person",
          ["contract-surface entity fact"],
        ),
    },
    {
      name: "writeProfile",
      kind: "profile",
      write: async (storage) => {
        await storage.writeProfile("# Profile\n\ncontract-surface profile\n");
        return "profile.md";
      },
    },
    {
      name: "writeQuestion",
      kind: "question",
      write: (storage) =>
        storage.writeQuestion(
          "<question>contract-surface question?</question>",
          "surface",
          1,
        ),
    },
    {
      name: "writeChunk",
      kind: "chunk",
      write: async (storage) => {
        const parentId = await storage.writeMemory(
          "fact",
          "contract-surface chunk parent",
          { tags: ["contract-surface"] },
        );
        await storage.writeChunk(parentId, 0, 1, "fact", "contract-surface chunk body");
        return parentId;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// chmod helper for atomic-write failure injection (rule 54)
// ---------------------------------------------------------------------------

/**
 * Sync chmod scoped to a scratch path we just created. Used by the atomicity
 * test to make a parent dir read-only so `writeMaybeEncryptedFile`'s temp
 * write inside it fails — proving the temp-then-rename contract leaves the
 * original file intact when the write is rejected (rule 54: never
 * delete-before-write). No-op on Windows where the test is skipped.
 */
export function setDirReadOnly(targetPath: string): void {
  if (process.platform === "win32") return;
  // 0o500 = r-x for owner; the dir already exists, we own it.
  chmodSync(targetPath, 0o500);
}

/** Restore full owner perms after `setDirReadOnly`. */
export function setDirReadWrite(targetPath: string): void {
  if (process.platform === "win32") return;
  chmodSync(targetPath, 0o700);
}
