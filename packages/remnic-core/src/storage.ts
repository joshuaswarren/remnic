import { formatProjectionAge, readProjectionRebuiltAt } from "./maintenance/projection-support.js";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
  mkdir,
  unlink,
  appendFile,
  open,
  type FileHandle,
} from "node:fs/promises";
import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { normalizeContent, computeContentHash } from "./content-hash.js";
import path from "node:path";
import { log } from "./logger.js";
import { assertMemoryFrontmatterId, warnProjectionFallback } from "./storage-guards.js";
import { MemoryReadStore } from "./storage/memory-read-store.js";
import { renderProfileWithLastUpdated } from "./storage/profile-header.js";
import { readMaybeEncryptedLines, readMemoryActionEventRowsFromLines } from "./storage/secure-line-reader.js";
import {
  appendLifecycleEventsSerialized,
  type DrainPendingLifecycleForSyncResult,
  drainPendingLifecycleLedgerForSync,
  drainPendingLifecycleLedgerIfAny,
  pendingLifecycleLedgerDir,
  ProjectionLedgerLagManager,
  readAllLifecycleEventsFromLedger,
  readAllLifecycleEventsFromLedgerBuffer,
  readBoundedLifecycleEventsFromLedger,
  serializeLifecycleAppendPayload,
} from "./storage/memory-lifecycle-ledger-access.js";
import { selfDeps } from "./orchestration/self-deps.js";
import { EntityStore } from "./storage/entity-store.js";
import { IdentityContinuityStore } from "./storage/identity-continuity-store.js";
import * as entityMigration from "./storage/entity-canonical-id-migration.js";
import * as entityRefs from "./storage/entity-canonical-id-references.js";
import { EntityRefRepair } from "./storage/entity-ref-repair.js";
import {
  runLegacyEntityCanonicalIdMigration,
  type EntityCanonicalIdMigrationHost,
} from "./storage/entity-canonical-id-migration-adapter.js";
import { EntityCanonicalIdMigrationRunner } from "./storage/entity-canonical-id-migration-runner.js";
import { rememberRawFrontmatter } from "./storage/memory-frontmatter-metadata.js";
import { createMemoryEntityRefSerializer } from "./storage/memory-migration-serialization.js";
import { readEntityAliasConfigSync } from "./storage/entity-alias-config.js";
import { assertSafeEntityId } from "./storage/entity-id-safety.js";
export { normalizeEntityName } from "./entity-id-normalization.js";
import { isErrnoCode } from "./utils/errno.js";
import { getCategoryDir, categoryDirName } from "./utils/category-dir.js";
import { decodeYamlScalar } from "./utils/yaml-scalar.js";
import { withHeldFileLock, type HeldFileLockController } from "./utils/serialize-mutations.js";
import { qmdCollectionPathParts, qmdResultPathCandidates } from "./orchestration/qmd-result-resolver.js";
import {
  clearMemoryCache,
  getCachedEntities,
  getCachedMemories,
  invalidateAllForDir,
  invalidateDerivedAndGlobalForDir,
  invalidateForScope,
  invalidateForScopeExceptHot,
  setCachedEntities,
  setCachedMemories,
  updateCacheOnDelete,
  updateCacheOnWrite,
} from "./memory-cache.js";
import {
  getInFlightRead,
  setInFlightRead,
  deleteInFlightRead,
  deleteInFlightReadsForDir,
  clearInFlightReads,
} from "./in-flight-reads.js";
import { rotateMarkdownFileToArchive } from "./hygiene.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import { withholdToolScopedFromSharedNamespace } from "./tool-scoped-memory.js";
import {
  serializeProvenanceFields,
  parseProvenanceSources,
  parseProvenanceTag,
  reconcileProvenanceRead,
} from "./provenance.js";
import { serializeFaithfulnessFields, parseFaithfulnessField } from "./extraction-faithfulness.js";
import { createVersion as createPageVersion, type VersioningConfig, type VersionTrigger } from "./page-versioning.js";
import { isValidTranscriptDate, WEARABLES_DIR_NAME } from "./wearables/day-store.js";
import { FusionArtifactStore } from "./wearables/fusion/index.js";
import { MeetingRecordStore } from "./meetings/store.js";
import {
  SecureStoreLockedError,
  MAGIC_HEADER_SIZE,
  isEncryptedFile,
  probeEncryptedRegularFileHeader,
  readMaybeEncryptedFileBuffer,
  readMaybeEncryptedFile,
  writeMaybeEncryptedFile,
} from "./secure-store/secure-fs.js";
import {
  isConsolidationOperator,
  isValidDerivedFromEntry,
  type ConsolidationOperator,
} from "./consolidation-operator.js";
import {
  matchEntitySchemaSection,
  normalizeEntityStructuredSection,
  sortStructuredSectionsBySchema,
} from "./entity-schema.js";
import {
  hasCitation,
  hasCitationForTemplate,
  stripCitationForTemplate,
  DEFAULT_CITATION_FORMAT,
} from "./source-attribution.js";
import {
  stripCitationMarkersForHashRemoval,
  stripDefaultCitationMarkersWithoutRegex,
} from "./storage/citation-hash-source.js";
import {
  TombstoneStore,
  collectRetiredMemoriesForRebuild,
  buildRetiredFactTombstoneInputs,
  type TombstoneStoreOptions,
  type TombstoneFileIo,
  type TombstoneReason,
  type TombstoneCreatedBy,
  type TombstoneStats,
} from "./lifecycle/tombstones.js";
import { supersessionKeysForFact } from "./temporal-supersession.js";
import type {
  AccessTrackingEntry,
  BufferState,
  ConfidenceTier,
  ContinuityIncidentCloseInput,
  ContinuityIncidentOpenInput,
  ContinuityIncidentRecord,
  ContinuityImprovementLoop,
  ContinuityLoopReviewInput,
  ContinuityLoopUpsertInput,
  EntityActivityEntry,
  EntityFile,
  EntityRelationship,
  EntityStructuredSection,
  EntityTimelineEntry,
  ImportanceLevel,
  ImportanceScore,
  MemoryCategory,
  MemoryFile,
  MemoryFrontmatter,
  MemoryLink,
  LifecycleState,
  VerificationState,
  PolicyClass,
  MemoryStatus,
  MemoryActionEvent,
  MemoryLifecycleEvent,
  MemoryLifecycleEventType,
  MemoryLifecycleStateSummary,
  MemoryProjectionCurrentState,
  BehaviorSignalEvent,
  BufferSurpriseEvent,
  MemorySummary,
  MetaState,
  ExtractionFailureClass,
  CompressionGuidelineOptimizerState,
  PluginConfig,
  ScoredEntity,
  TopicScore,
  FileHygieneConfig,
  ProvenanceSource,
} from "./types.js";
import { confidenceTier, SPECULATIVE_TTL_DAYS } from "./types.js";
import {
  collectStructuredSectionFacts,
  compareEntityTimestamps,
  compileEntityFacts,
  isEntitySynthesisStale,
  isEntitySynthesisTimelinePromotionBullet,
  latestEntityTimelineTimestamp,
  normalizeEntitySectionFact,
  normalizeStructuredSectionFacts,
  parseEntityTimelineBullet,
  partitionEntityStructuredSections,
  serializeEntityTimelineEntry,
} from "./storage/entity-timeline.js";
import {
  ContentHashIndex,
  FactHashIndexNotAuthoritativeError,
  CONTENT_HASH_INDEX_RETRY_MAX_DELAY_MS,
  type ContentHashIndexLockOptions,
} from "./storage/content-hash-index.js";
import {
  TombstoneBlockedCaptureIndexHost,
  buildExplicitCaptureDedupKey,
  parseTombstoneBlockedOfflineSyncMemory,
  type TombstoneBlockedCaptureIndexOptions,
} from "./storage/tombstone-blocked-capture-index.js";
import {
  buildCapturePathLockIdentity,
  isQueuedReviewMemory,
  tombstoneBlocked,
} from "./storage/tombstone-blocked-capture-mutation.js";
export { ContentHashIndex, FactHashIndexNotAuthoritativeError };
export type { ContentHashIndexLockOptions };
export {
  compareEntityTimestamps,
  compileEntityFacts,
  countEntityStructuredFacts,
  fingerprintEntityStructuredFacts,
  isEntitySynthesisStale,
  normalizeStructuredSectionFacts,
} from "./storage/entity-timeline.js";
import {
  type ProjectedMemoryBrowseOptions,
  type ProjectedMemoryBrowsePage,
  markProjectedMemoryPathInvalid,
  readProjectedMemoryState,
  readProjectedMemoryBrowse,
  readProjectedGovernanceRecord,
  readProjectedMemoryTimeline,
  updateProjectedMemoryPath,
} from "./memory-projection-store.js";
import { inferMemoryStatus, isArchivedMemoryPath, toMemoryPathRel } from "./memory-lifecycle-ledger-utils.js";
import { normalizeProjectionPreview, normalizeProjectionTags } from "./memory-projection-format.js";
import { parseFlexibleIsoTimestamp } from "./utils/iso-timestamp.js";
import {
  composeMemoryEnvelope,
  isSealedMemoryEnvelope,
  sealedWriteToLegacyArgs,
  type SealedMemoryEnvelope,
} from "./write-envelope.js";
// stripCitation import removed: legacy rebuild fallback was replaced by a
// skip-with-warning strategy (Finding 1 — Uhol).  See ensureFactHashIndexAuthoritative.

const ARTIFACT_SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

type SharedVersionKind = "memory-status" | "artifact-write" | "cold-write" | "memory-corpus" | "entity-mutation";

type OfflineSyncDigestCacheEntry = {
  statBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  encrypted: boolean;
  sha256: string;
  bytes: number;
};

type DeletionRevisionMetadata = {
  version: 1;
  deletions: Array<{ path: string; mtimeMs: number }>;
};

const DELETION_REVISION_MAX_MTIME_MS = 8_640_000_000_000_000;
const DELETION_REVISION_LOCK_STALE_MS = 60_000;
const DELETION_REVISION_LOCK_MAX_WAIT_MS = 120_000;

function isValidDeletionRevisionPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../")
  );
}

function deletionRevisionPathIdentity(value: string): string {
  return value
    .normalize("NFC")
    .toUpperCase()
    .toLowerCase()
    .replace(/\u00df/g, "ss");
}

export interface ReextractJobRequest {
  memoryId: string;
  model: string;
  requestedAt: string;
  source: "cli-migrate";
}

export interface MemoryLifecycleEventWriteOptions {
  at?: Date;
  actor?: string;
  reasonCode?: string;
  ruleVersion?: string;
  relatedMemoryIds?: string[];
  correlationId?: string;
}

function tokenizeArtifactSearchText(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !ARTIFACT_SEARCH_STOPWORDS.has(t));
}

/**
 * Validate a Memory Worth counter (`mw_success` / `mw_fail`) before we persist
 * it. Rejects non-finite, non-integer, and negative values rather than silently
 * clamping — a silent clamp would mask miscounts in the feedback pipeline
 * (issue #560 PR 3). Callers should pass only explicit user/pipeline values;
 * `undefined` is checked at the callsite and skipped entirely.
 */
function assertMemoryWorthCounter(field: "mw_success" | "mw_fail", value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`${field} must be >= 0, got ${value}`);
  }
}

function normalizeMemoryWriteTimestamp(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be an ISO timestamp string, got ${String(value)}`);
  }
  const trimmed = value.trim();
  const parsed = parseFlexibleIsoTimestamp(trimmed);
  if (parsed === null) {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(value)}`);
  }
  return new Date(parsed).toISOString();
}

function serializeFrontmatter(fm: MemoryFrontmatter): string {
  assertMemoryFrontmatterId(fm);
  const lines = [
    "---",
    `id: ${fm.id}`,
    `category: ${fm.category}`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    `source: ${fm.source}`,
    `confidence: ${fm.confidence}`,
    `confidenceTier: ${fm.confidenceTier}`,
    `tags: [${fm.tags.map((t) => `"${t}"`).join(", ")}]`,
  ];
  if (fm.entityRef) lines.push(`entityRef: ${fm.entityRef}`);
  if (fm.sourceConnector) {
    // YAML-injection guard (review thread QMPsP): emit unquoted for
    // safe connector IDs (matching the connectors/index.ts validator),
    // or JSON.stringify for values with special characters so newlines,
    // colons, and spaces cannot inject extra frontmatter lines.
    const safe = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fm.sourceConnector);
    lines.push(`sourceConnector: ${safe ? fm.sourceConnector : JSON.stringify(fm.sourceConnector)}`);
  }
  if (fm.toolScoped === true) lines.push("toolScoped: true");
  if (fm.supersedes) lines.push(`supersedes: ${fm.supersedes}`);
  if (fm.expiresAt) lines.push(`expiresAt: ${fm.expiresAt}`);
  if (fm.lineage && fm.lineage.length > 0) {
    lines.push(`lineage: [${fm.lineage.map((l) => `"${l}"`).join(", ")}]`);
  }
  // Status management
  if (fm.status && fm.status !== "active") lines.push(`status: ${fm.status}`);
  // Tombstone block visibility (issue #1579). Emit only when present so legacy
  // memories round-trip unchanged; the review queue reads these to drive the
  // automatic revocation on approval.
  if (fm.blockedBy) lines.push(`blockedBy: ${fm.blockedBy}`);
  if (fm.tombstoneBlockTier) lines.push(`tombstoneBlockTier: ${fm.tombstoneBlockTier}`);
  if (fm.supersededBy) lines.push(`supersededBy: ${fm.supersededBy}`);
  if (fm.supersededAt) lines.push(`supersededAt: ${fm.supersededAt}`);
  if (fm.archivedAt) lines.push(`archivedAt: ${fm.archivedAt}`);
  // Issue #680 — explicit fact lifecycle.  Emit only when present so legacy
  // memories round-trip unchanged; readers default `valid_at` to `created`.
  if (fm.valid_at) lines.push(`validAt: ${fm.valid_at}`);
  if (fm.invalid_at) lines.push(`invalidAt: ${fm.invalid_at}`);
  // Issue #1578 — bi-temporal ingestion provenance.  Validate on write so a
  // corrupt `observedAt` (non-ISO / overflowed) cannot leak onto disk; reads
  // are permissive, mirroring the `valid_at` precedent.  `eventTimeSource` is
  // a closed enum — reject anything outside it rather than persisting garbage.
  if (fm.observedAt) {
    const validated = normalizeMemoryWriteTimestamp("observedAt", fm.observedAt);
    if (validated) lines.push(`observedAt: ${validated}`);
  }
  if (fm.eventTimeSource) {
    if (fm.eventTimeSource !== "extracted" && fm.eventTimeSource !== "assumed") {
      throw new Error(
        `serializeFrontmatter: invalid eventTimeSource ${JSON.stringify(fm.eventTimeSource)} — expected "extracted" | "assumed"`
      );
    }
    lines.push(`eventTimeSource: ${fm.eventTimeSource}`);
  }
  if (fm.forgottenAt) lines.push(`forgottenAt: ${fm.forgottenAt}`);
  if (fm.forgottenReason) lines.push(`forgottenReason: ${JSON.stringify(fm.forgottenReason)}`);
  // Lifecycle policy fields
  if (fm.lifecycleState) lines.push(`lifecycleState: ${fm.lifecycleState}`);
  if (fm.verificationState) lines.push(`verificationState: ${fm.verificationState}`);
  if (fm.policyClass) lines.push(`policyClass: ${fm.policyClass}`);
  if (fm.lastValidatedAt) lines.push(`lastValidatedAt: ${fm.lastValidatedAt}`);
  if (fm.decayScore !== undefined) lines.push(`decayScore: ${fm.decayScore}`);
  if (fm.heatScore !== undefined) lines.push(`heatScore: ${fm.heatScore}`);
  // Access tracking
  if (fm.accessCount !== undefined && fm.accessCount > 0) {
    lines.push(`accessCount: ${fm.accessCount}`);
  }
  if (fm.lastAccessed) lines.push(`lastAccessed: ${fm.lastAccessed}`);
  // Memory Worth counters (issue #560). Emit verbatim when present — including
  // explicit zeros — so consumers can distinguish "never observed" (absent)
  // from "observed with zero successes" (present, value 0). Validation below
  // rejects negatives and non-integers so we never persist a corrupt counter.
  if (fm.mw_success !== undefined) {
    assertMemoryWorthCounter("mw_success", fm.mw_success);
    lines.push(`mw_success: ${fm.mw_success}`);
  }
  if (fm.mw_fail !== undefined) {
    assertMemoryWorthCounter("mw_fail", fm.mw_fail);
    lines.push(`mw_fail: ${fm.mw_fail}`);
  }
  // Importance scoring
  if (fm.importance) {
    lines.push(`importanceScore: ${fm.importance.score}`);
    lines.push(`importanceLevel: ${fm.importance.level}`);
    if (fm.importance.reasons.length > 0) {
      lines.push(
        `importanceReasons: [${fm.importance.reasons
          .map((r) => `"${r.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
          .join(", ")}]`
      );
    }
    if (fm.importance.keywords.length > 0) {
      lines.push(`importanceKeywords: [${fm.importance.keywords.map((k) => `"${k}"`).join(", ")}]`);
    }
  }
  // Chunking (Phase 2A)
  if (fm.parentId) lines.push(`parentId: ${fm.parentId}`);
  if (fm.chunkIndex !== undefined) lines.push(`chunkIndex: ${fm.chunkIndex}`);
  if (fm.chunkTotal !== undefined) lines.push(`chunkTotal: ${fm.chunkTotal}`);
  // Memory Linking (Phase 3A)
  if (fm.links && fm.links.length > 0) {
    lines.push("links:");
    for (const link of fm.links) {
      lines.push(`  - targetId: ${link.targetId}`);
      lines.push(`    linkType: ${link.linkType}`);
      lines.push(`    strength: ${link.strength}`);
      if (link.reason) lines.push(`    reason: ${JSON.stringify(link.reason)}`);
    }
  }
  if (fm.intentGoal) lines.push(`intentGoal: ${fm.intentGoal}`);
  if (fm.intentActionType) lines.push(`intentActionType: ${fm.intentActionType}`);
  if (fm.intentEntityTypes && fm.intentEntityTypes.length > 0) {
    lines.push(`intentEntityTypes: [${fm.intentEntityTypes.map((t) => `"${t}"`).join(", ")}]`);
  }
  if (fm.artifactType) lines.push(`artifactType: ${fm.artifactType}`);
  if (fm.sourceMemoryId) lines.push(`sourceMemoryId: ${fm.sourceMemoryId}`);
  if (fm.sourceTurnId) lines.push(`sourceTurnId: ${fm.sourceTurnId}`);
  // v8.0 Phase 2B: HiMem episode/note classification
  if (fm.memoryKind) lines.push(`memoryKind: ${fm.memoryKind}`);
  // Structured attributes (stored as JSON on a single line)
  if (fm.structuredAttributes && Object.keys(fm.structuredAttributes).length > 0) {
    lines.push(`structuredAttributes: ${JSON.stringify(fm.structuredAttributes)}`);
  }
  // Raw-content dedup hash — format-agnostic archive/consolidation cleanup
  if (fm.contentHash) lines.push(`contentHash: ${fm.contentHash}`);
  // Consolidation provenance (issue #561).  Validate on write so malformed
  // entries cannot leak into the on-disk format.  Read-through parsing is
  // permissive; only writes go through the validator.
  if (fm.derived_from !== undefined) {
    if (!Array.isArray(fm.derived_from)) {
      throw new Error(`serializeFrontmatter: derived_from must be an array of "<path>:<version>" strings`);
    }
    for (const entry of fm.derived_from) {
      if (!isValidDerivedFromEntry(entry)) {
        throw new Error(
          `serializeFrontmatter: invalid derived_from entry ${JSON.stringify(entry)} — expected "<path>:<version>" with version >= 0`
        );
      }
    }
    if (fm.derived_from.length > 0) {
      lines.push(
        `derived_from: [${fm.derived_from.map((e) => `"${e.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ")}]`
      );
    }
  }
  if (fm.derived_via !== undefined) {
    if (!isConsolidationOperator(fm.derived_via)) {
      throw new Error(
        `serializeFrontmatter: invalid derived_via ${JSON.stringify(fm.derived_via)} — expected one of "split" | "merge" | "update" | "pattern-reinforcement"`
      );
    }
    lines.push(`derived_via: ${fm.derived_via}`);
  }
  // Pattern-reinforcement metadata (issue #687 PR 2/4).  Emit only when
  // present so memories never touched by reinforcement round-trip
  // unchanged; matches the `archivedAt` / `forgottenAt` precedent.
  if (fm.reinforcement_count !== undefined) {
    if (!Number.isInteger(fm.reinforcement_count) || fm.reinforcement_count <= 0) {
      throw new Error(
        `serializeFrontmatter: reinforcement_count must be a positive integer (got ${JSON.stringify(fm.reinforcement_count)})`
      );
    }
    lines.push(`reinforcement_count: ${fm.reinforcement_count}`);
  }
  if (fm.last_reinforced_at) {
    lines.push(`last_reinforced_at: ${fm.last_reinforced_at}`);
  }
  serializeProvenanceFields(fm, lines);
  serializeFaithfulnessFields(fm, lines);
  lines.push("---");
  return lines.join("\n");
}

function parseStructuredAttributes(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === "string" && typeof v === "string") {
          result[k] = v;
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    }
  } catch {
    // Not valid JSON — ignore
  }
  return undefined;
}

function parseLinkReasonValue(rawValue: string): string {
  const legacyValue = rawValue.replace(/\\"/g, '"');
  const looksLikeLegacyPath =
    !rawValue.includes("\\\\") &&
    (/[A-Za-z]:\\[A-Za-z0-9._ -]+(?:\\[A-Za-z0-9._ -]+)*/.test(rawValue) ||
      /\\[A-Za-z0-9._ -]+\\[A-Za-z0-9._ -]+/.test(rawValue));

  if (looksLikeLegacyPath) {
    return legacyValue;
  }

  try {
    return JSON.parse(`"${rawValue}"`) as string;
  } catch {
    return legacyValue;
  }
}

export function parseFrontmatterStringValue(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined;
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return trimmed;
}

/**
 * Parse a Memory Worth counter from its raw YAML string form. Returns
 * `undefined` for missing, blank, negative, or non-integer values so a
 * corrupt stored counter fails safely rather than poisoning downstream
 * scoring. Pair with `assertMemoryWorthCounter` on the write path.
 */
function bracketListInner(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  return trimmed.slice(1, -1);
}

function quotedArrayValues(raw: string): string[] {
  const inner = bracketListInner(raw);
  if (inner === undefined) return [];
  const values: string[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && inner[i] !== '"') i++;
    if (i >= inner.length) break;
    i++;
    let value = "";
    while (i < inner.length) {
      const ch = inner[i++];
      if (ch === "\\" && i < inner.length) value += ch + inner[i++];
      else if (ch === '"') {
        values.push(value);
        break;
      } else value += ch;
    }
  }
  return values;
}

function parseMemoryWorthCounterField(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * Parse the pattern-reinforcement counter (issue #687 PR 2/4) from its
 * raw YAML string form.  Returns `undefined` for missing, blank,
 * non-positive, or non-integer values so a corrupt stored counter
 * fails safely.  Pair with the `reinforcement_count > 0 && integer`
 * assertion on the write path in `serializeFrontmatter`.
 */
function parseReinforcementCountField(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

export function parseFrontmatter(raw: string): { frontmatter: MemoryFrontmatter; content: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return null;

  const fmBlock = match[1];
  const content = match[2].trim();
  const fm: Record<string, string> = {};

  // Collapse YAML block-sequence style into inline flow style so the
  // downstream per-key parsers (derived_from, tags, lineage, etc.) keep
  // working.  A key like
  //     derived_from:
  //       - facts/a.md:2
  //       - facts/b.md:5
  // becomes
  //     derived_from: ["facts/a.md:2", "facts/b.md:5"]
  // before the line-split.  Only applies when the key's own line has an
  // empty scalar — any inline value or explicit flow sequence short-circuits
  // this and is parsed as-is.
  const rawLines = fmBlock.split("\n");
  const lines: string[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1 && line.slice(colonIdx + 1).trim() === "") {
      const baseIndent = line.match(/^\s*/)![0].length;
      const items: string[] = [];
      let j = i + 1;
      while (j < rawLines.length) {
        const next = rawLines[j];
        const m = next.match(/^(\s+)- (.*)$/);
        if (!m || m[1].length <= baseIndent) break;
        // Strip matching surrounding quotes and apply YAML unescape rules
        // so block-style entries round-trip identically to flow-style ones.
        //   double-quoted: `\"` → `"`, `\\` → `\`
        //   single-quoted: `''` → `'` (YAML's native escape)
        let item = m[2].trim();
        if (item.startsWith('"') && item.endsWith('"') && item.length >= 2) {
          item = item.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        } else if (item.startsWith("'") && item.endsWith("'") && item.length >= 2) {
          item = item.slice(1, -1).replace(/''/g, "'");
        }
        items.push(item);
        j++;
      }
      if (items.length > 0) {
        const inline = items.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ");
        lines.push(`${line.slice(0, colonIdx + 1)} [${inline}]`);
        i = j;
        continue;
      }
    }
    lines.push(line);
    i++;
  }

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }

  let tags: string[] = [];
  const tagsStr = fm.tags ?? "";
  const tagInner = bracketListInner(tagsStr);
  if (tagInner !== undefined) {
    tags = tagInner
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  let intentEntityTypes: string[] | undefined;
  const intentEntityTypesStr = fm.intentEntityTypes ?? "";
  const intentEntityTypesInner = bracketListInner(intentEntityTypesStr);
  if (intentEntityTypesInner !== undefined) {
    intentEntityTypes = intentEntityTypesInner
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  const conf = parseFloat(fm.confidence ?? "0.8");

  // Parse lineage array if present
  let lineage: string[] | undefined;
  const lineageStr = fm.lineage ?? "";
  const lineageInner = bracketListInner(lineageStr);
  if (lineageInner !== undefined) {
    lineage = lineageInner
      .split(",")
      .map((l) => l.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  // Parse consolidation provenance (issue #561).  `derived_from` is an
  // array of `"<path>:<version>"` strings; parsing is permissive so legacy
  // / malformed entries survive a read, but serialization validates on
  // write (see serializeFrontmatter).  `derived_via` is a single operator
  // string; unknown values become `undefined` on read rather than raising.
  //
  // Tokenization handles every inline-YAML flavor we may encounter from
  // external editors and older builds:
  //   - our canonical escape:   ["facts/a.md:2", "facts/b.md:5"]
  //   - single-quoted:          ['facts/a.md:2', 'facts/b.md:5']
  //   - bare (no quotes):       [facts/a.md:2, facts/b.md:5]
  // Quoted entries preserve embedded commas in the path; bare entries
  // fall back to comma splitting but are still validated on write.
  let derived_from: string[] | undefined;
  const derivedFromStr = (fm.derived_from ?? "").trim();
  if (derivedFromStr.startsWith("[") && derivedFromStr.endsWith("]")) {
    const inner = derivedFromStr.slice(1, -1);
    const entries: string[] = [];
    // Hand-rolled tokenizer: walk the inner characters, honoring
    // double-quote escapes (`\"`, `\\`) and YAML single-quote doubling
    // (`''` in a `'...'` string means a literal `'`).  This avoids the
    // `'...'` regex footgun where `''` is parsed as two empty strings.
    // Bare tokens (not quoted) are read until the next comma/whitespace
    // so flow sequences that mix quoted and bare scalars preserve every
    // entry.
    let i = 0;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === '"') {
        let buf = "";
        i++;
        while (i < inner.length) {
          const c = inner[i];
          if (c === "\\" && i + 1 < inner.length) {
            const next = inner[i + 1];
            if (next === '"') {
              buf += '"';
              i += 2;
              continue;
            }
            if (next === "\\") {
              buf += "\\";
              i += 2;
              continue;
            }
            buf += c;
            i++;
            continue;
          }
          if (c === '"') {
            i++;
            break;
          }
          buf += c;
          i++;
        }
        if (buf.length > 0) entries.push(buf);
      } else if (ch === "'") {
        let buf = "";
        i++;
        while (i < inner.length) {
          const c = inner[i];
          if (c === "'") {
            // YAML single-quote escape: `''` means a literal `'`.
            if (i + 1 < inner.length && inner[i + 1] === "'") {
              buf += "'";
              i += 2;
              continue;
            }
            i++;
            break;
          }
          buf += c;
          i++;
        }
        if (buf.length > 0) entries.push(buf);
      } else if (ch === "," || /\s/.test(ch)) {
        // Separator between entries — skip.
        i++;
      } else {
        // Bare token — read until next comma or whitespace.  Supports
        // mixed-style YAML sequences like `["facts/a.md:1", facts/b.md:2]`
        // where some entries are quoted and others are bare.
        let buf = "";
        while (i < inner.length) {
          const c = inner[i];
          if (c === "," || /\s/.test(c)) break;
          buf += c;
          i++;
        }
        if (buf.length > 0) entries.push(buf);
      }
    }
    if (entries.length > 0) derived_from = entries;
  }
  // `derived_via` may arrive quoted from external YAML emitters
  // (`derived_via: "merge"` or `'merge'`).  Strip a single surrounding
  // quote pair before operator validation so semantically valid entries
  // aren't silently downgraded to `undefined`.
  const derivedViaRaw = (fm.derived_via ?? "").trim();
  const derivedViaUnquoted =
    (derivedViaRaw.startsWith('"') && derivedViaRaw.endsWith('"')) ||
    (derivedViaRaw.startsWith("'") && derivedViaRaw.endsWith("'"))
      ? derivedViaRaw.slice(1, -1)
      : derivedViaRaw;
  const derived_via = isConsolidationOperator(derivedViaUnquoted) ? derivedViaUnquoted : undefined;

  // Parse accessCount
  const accessCount = fm.accessCount ? parseInt(fm.accessCount, 10) : undefined;
  const decayScore = fm.decayScore !== undefined ? parseFloat(fm.decayScore) : undefined;
  const heatScore = fm.heatScore !== undefined ? parseFloat(fm.heatScore) : undefined;

  // Parse Memory Worth counters (issue #560). We preserve explicit zeros so
  // callers can distinguish "observed with zero successes" from "never
  // observed". Invalid (non-integer / negative) stored values round-trip to
  // `undefined` — better to drop corrupt counters than to poison scoring.
  const mw_success = parseMemoryWorthCounterField(fm.mw_success);
  const mw_fail = parseMemoryWorthCounterField(fm.mw_fail);

  // Parse importance
  let importance: ImportanceScore | undefined;
  if (fm.importanceScore) {
    const score = parseFloat(fm.importanceScore);
    const level = (fm.importanceLevel as ImportanceLevel) || "normal";

    // Parse importance reasons array
    let reasons: string[] = [];
    const reasonsStr = fm.importanceReasons ?? "";
    if (reasonsStr.trim().startsWith("[") && reasonsStr.trim().endsWith("]")) {
      for (const rawReason of quotedArrayValues(reasonsStr)) {
        const reason = parseLinkReasonValue(rawReason);
        if (reason.length > 0) reasons.push(reason);
      }
    }

    // Parse importance keywords array
    let keywords: string[] = [];
    const keywordsStr = fm.importanceKeywords ?? "";
    const keywordsInner = bracketListInner(keywordsStr);
    if (keywordsInner !== undefined) {
      keywords = keywordsInner
        .split(",")
        .map((k) => k.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
    }

    importance = { score, level, reasons, keywords };
  }

  const result: { frontmatter: MemoryFrontmatter; content: string } = {
    frontmatter: {
      id: fm.id ?? "",
      category: (fm.category ?? "fact") as MemoryCategory,
      created: fm.created ?? new Date().toISOString(),
      updated: fm.updated ?? new Date().toISOString(),
      source: fm.source ?? "unknown",
      confidence: conf,
      confidenceTier: (fm.confidenceTier as ConfidenceTier) || confidenceTier(conf),
      tags,
      entityRef: fm.entityRef || undefined,
      sourceConnector: fm.sourceConnector ? decodeYamlScalar(fm.sourceConnector) || undefined : undefined,
      toolScoped: fm.toolScoped === "true" ? true : undefined,
      supersedes: fm.supersedes || undefined,
      expiresAt: fm.expiresAt || undefined,
      lineage: lineage && lineage.length > 0 ? lineage : undefined,
      // Status management
      status: (fm.status as MemoryStatus) || "active",
      // Tombstone block visibility (issue #1579) — read-through.
      blockedBy: fm.blockedBy || undefined,
      tombstoneBlockTier:
        fm.tombstoneBlockTier === "exact" ||
        fm.tombstoneBlockTier === "normalized" ||
        fm.tombstoneBlockTier === "keyed" ||
        fm.tombstoneBlockTier === "semantic"
          ? fm.tombstoneBlockTier
          : undefined,
      supersededBy: fm.supersededBy || undefined,
      supersededAt: fm.supersededAt || undefined,
      archivedAt: fm.archivedAt || undefined,
      // Issue #680 — explicit fact lifecycle round-trip.
      valid_at: fm.validAt || undefined,
      invalid_at: fm.invalidAt || undefined,
      // Issue #1578 — bi-temporal ingestion provenance round-trip.
      observedAt: fm.observedAt || undefined,
      eventTimeSource:
        fm.eventTimeSource === "extracted" || fm.eventTimeSource === "assumed" ? fm.eventTimeSource : undefined,
      forgottenAt: fm.forgottenAt || undefined,
      forgottenReason: parseFrontmatterStringValue(fm.forgottenReason),
      lifecycleState: (fm.lifecycleState as LifecycleState) || undefined,
      verificationState: (fm.verificationState as VerificationState) || undefined,
      policyClass: (fm.policyClass as PolicyClass) || undefined,
      lastValidatedAt: fm.lastValidatedAt || undefined,
      decayScore: Number.isFinite(decayScore) ? decayScore : undefined,
      heatScore: Number.isFinite(heatScore) ? heatScore : undefined,
      // Access tracking
      accessCount: accessCount && accessCount > 0 ? accessCount : undefined,
      lastAccessed: fm.lastAccessed || undefined,
      // Memory Worth counters (issue #560)
      mw_success,
      mw_fail,
      // Importance scoring
      importance,
      // Chunking
      parentId: fm.parentId || undefined,
      chunkIndex: fm.chunkIndex ? parseInt(fm.chunkIndex, 10) : undefined,
      chunkTotal: fm.chunkTotal ? parseInt(fm.chunkTotal, 10) : undefined,
      // Links are parsed separately below
      intentGoal: fm.intentGoal || undefined,
      intentActionType: fm.intentActionType || undefined,
      intentEntityTypes: intentEntityTypes && intentEntityTypes.length > 0 ? intentEntityTypes : undefined,
      artifactType: (fm.artifactType as MemoryFrontmatter["artifactType"]) || undefined,
      sourceMemoryId: fm.sourceMemoryId || undefined,
      sourceTurnId: fm.sourceTurnId || undefined,
      // v8.0 Phase 2B: HiMem episode/note classification
      memoryKind: (fm.memoryKind as MemoryFrontmatter["memoryKind"]) || undefined,
      // Structured attributes (JSON on a single line)
      structuredAttributes: parseStructuredAttributes(fm.structuredAttributes),
      // Raw-content dedup hash (format-agnostic archive/consolidation cleanup)
      contentHash: fm.contentHash || undefined,
      // Consolidation provenance (issue #561) — read-through only in this
      // PR; no code produces these fields yet.
      derived_from,
      derived_via,
      // Pattern-reinforcement metadata (issue #687 PR 2/4) — drop corrupt values on read (rule 34).
      reinforcement_count: parseReinforcementCountField(fm.reinforcement_count),
      last_reinforced_at: fm.last_reinforced_at || undefined,
      sources: parseProvenanceSources(fm.sources),
      provenance: reconcileProvenanceRead(parseProvenanceTag(fm.provenance), parseProvenanceSources(fm.sources)),
      faithfulness: parseFaithfulnessField(fm.faithfulness),
    },
    content,
  };

  // Parse links (YAML array format)
  // Note: Simple parsing - for full YAML we'd need a library.
  if (fmBlock.includes("links:")) {
    const links: MemoryLink[] = [];
    const linkMatches = fmBlock.matchAll(
      /- targetId: (\S+)\s+linkType: (\S+)\s+strength: ([\d.]+)(?:\s+reason: "((?:\\.|[^"\\])*)")?/g
    );
    for (const match of linkMatches) {
      links.push({
        targetId: match[1],
        linkType: match[2] as MemoryLink["linkType"],
        strength: parseFloat(match[3]),
        reason: match[4] ? parseLinkReasonValue(match[4]) : undefined,
      });
    }
    if (links.length > 0) {
      result.frontmatter.links = links;
    }
  }

  return result;
}

function inferEntityTypeFromContent(content: string): string | undefined {
  const typeMatch = content
    .match(/^\*\*Type:\*\*\s*([^\n]+)/m)?.[1]
    ?.trim()
    .toLowerCase();
  return typeMatch || undefined;
}

const KNOWN_ENTITY_FILENAME_PREFIXES = new Set(["company", "other", "person", "place", "project", "tool", "topic"]);

function inferEntityTypeFromFilename(pathRel: string): string | undefined {
  const basename = path.basename(pathRel, ".md").toLowerCase();
  const separator = basename.indexOf("-");
  if (separator <= 0) return undefined;
  const candidate = basename.slice(0, separator);
  return KNOWN_ENTITY_FILENAME_PREFIXES.has(candidate) ? candidate : undefined;
}

export function normalizeFrontmatterForPath(
  frontmatter: MemoryFrontmatter,
  pathRel: string,
  content: string = ""
): MemoryFrontmatter {
  const normalizedPath = pathRel.split(path.sep).join("/");
  let normalizedFrontmatter = frontmatter;

  if (
    normalizedPath === "entities" ||
    normalizedPath.startsWith("entities/") ||
    normalizedPath.includes("/entities/")
  ) {
    const basename = path.basename(pathRel, ".md");
    const inferredType = inferEntityTypeFromContent(content) || inferEntityTypeFromFilename(pathRel) || "entity";
    const existingTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
    normalizedFrontmatter = {
      ...normalizedFrontmatter,
      id:
        typeof normalizedFrontmatter.id === "string" && normalizedFrontmatter.id.trim().length > 0
          ? normalizedFrontmatter.id
          : basename,
      category: "entity",
      tags: existingTags.includes(inferredType) ? existingTags : [...existingTags, inferredType],
    };
  }

  if (isArchivedMemoryPath(pathRel) && (!normalizedFrontmatter.status || normalizedFrontmatter.status === "active")) {
    return {
      ...normalizedFrontmatter,
      status: "archived",
    };
  }

  return normalizedFrontmatter;
}

function inferCurrentStateStatus(
  frontmatter: MemoryFrontmatter,
  pathRel: string,
  fallbackStatus: MemoryStatus
): MemoryStatus {
  return inferMemoryStatus(frontmatter, pathRel, fallbackStatus);
}

/**
 * Simple Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Strip hyphens from a string for loose comparison */
function dehyphenate(s: string): string {
  return s.replace(/-/g, "");
}

/** Bounded attempts to acquire the rebuild lock before ensureFactHashIndexAuthoritative surrenders authority (PR #2016). */
const FACT_HASH_INDEX_REBUILD_MAX_ATTEMPTS = 3;
/** Base backoff (ms) between rebuild-lock attempts; doubles each attempt, capped at CONTENT_HASH_INDEX_RETRY_MAX_DELAY_MS. */
const FACT_HASH_INDEX_REBUILD_RETRY_BASE_MS = 50;

// ---------------------------------------------------------------------------
// Attribute normalization helper
// ---------------------------------------------------------------------------

// `stripAttributesSuffix` now lives in ./structured-attributes.ts (shared with
// the coding surfaces + wearable service). Imported here so internal callers
// (snapshotBeforeWrite, snapshotForProvenance) resolve, and re-exported to
// keep the public storage API stable for existing callers (wearables, dist).
import { assemblePersistedBody, stripAttributesSuffix } from "./structured-attributes.js";
export { stripAttributesSuffix };

// `normalizeAttributePairs` moved to ./structured-attributes.ts (issue #1989
// PR2) beside `assemblePersistedBody` so the write path and the sealed
// envelope composer share ONE assembly definition. Re-exported to keep the
// public storage API stable for existing callers.
export { normalizeAttributePairs } from "./structured-attributes.js";

// ---------------------------------------------------------------------------
// Entity file parsing / serialization (Knowledge Graph v7.0)
// ---------------------------------------------------------------------------

function parseEntityFrontmatter(raw: string): {
  frontmatter: {
    created?: string;
    updated?: string;
    synthesisUpdatedAt?: string;
    synthesisTimelineCount?: number;
    synthesisStructuredFactCount?: number;
    synthesisStructuredFactDigest?: string;
    synthesisVersion?: number;
    extraLines?: string[];
  };
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const values: Record<string, string> = {};
  const extraLines: string[] = [];
  const recognizedKeys = new Set([
    "created",
    "updated",
    "synthesis_updated_at",
    "synthesis_timeline_count",
    "synthesis_structured_fact_count",
    "synthesis_structured_fact_digest",
    "synthesis_version",
  ]);
  for (const line of match[1].split(/\r?\n/)) {
    if (/^\s/.test(line)) {
      extraLines.push(line);
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      extraLines.push(line);
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    if (!recognizedKeys.has(key)) {
      extraLines.push(line);
      continue;
    }
    const value = parseManagedFrontmatterValue(line.slice(colonIdx + 1));
    values[key] = value;
  }

  const synthesisTimelineCount = Number.parseInt(values.synthesis_timeline_count ?? "", 10);
  const synthesisStructuredFactCount = Number.parseInt(values.synthesis_structured_fact_count ?? "", 10);
  const synthesisVersion = Number.parseInt(values.synthesis_version ?? "", 10);
  return {
    frontmatter: {
      created: values.created || undefined,
      updated: values.updated || undefined,
      synthesisUpdatedAt: values.synthesis_updated_at || undefined,
      synthesisTimelineCount: Number.isFinite(synthesisTimelineCount) ? synthesisTimelineCount : undefined,
      synthesisStructuredFactCount: Number.isFinite(synthesisStructuredFactCount)
        ? synthesisStructuredFactCount
        : undefined,
      synthesisStructuredFactDigest: values.synthesis_structured_fact_digest || undefined,
      synthesisVersion: Number.isFinite(synthesisVersion) ? synthesisVersion : undefined,
      extraLines,
    },
    body: match[2],
  };
}

function parseManagedFrontmatterValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  const openingQuote = trimmed[0];
  if (openingQuote === '"' || openingQuote === "'") {
    let escaped = false;
    for (let index = 1; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (openingQuote === '"' && !escaped && char === "\\") {
        escaped = true;
        continue;
      }
      if (!escaped && char === openingQuote) {
        return trimmed.slice(1, index);
      }
      escaped = false;
    }
    return trimmed.slice(1).replace(new RegExp(`${openingQuote}$`), "");
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "#" && (index === 0 || /\s/.test(trimmed[index - 1] ?? ""))) {
      return trimmed.slice(0, index).trimEnd();
    }
  }

  return trimmed;
}

function readEntitySectionText(
  lines: string[],
  sectionNames: string[],
  options: {
    preserveBullets?: boolean;
    skipTimelineBullets?: boolean;
  } = {}
): string | undefined {
  const normalizedSections = new Set(sectionNames.map((name) => name.toLowerCase()));
  let section = "";
  const sectionLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const nextSection = line.slice(3).trim().toLowerCase();
      if (section && !normalizedSections.has(nextSection)) break;
      section = normalizedSections.has(nextSection) ? nextSection : "";
      continue;
    }
    if (!section) continue;
    const trimmed = line.trim();
    if (!trimmed) {
      if (options.preserveBullets === true && sectionLines.length > 0 && sectionLines[sectionLines.length - 1] !== "") {
        sectionLines.push("");
      }
      continue;
    }
    if (
      options.skipTimelineBullets === true &&
      trimmed.startsWith("- ") &&
      isEntitySynthesisTimelinePromotionBullet(trimmed.slice(2))
    ) {
      continue;
    }
    if (trimmed.startsWith("- ") && options.preserveBullets !== true) continue;
    sectionLines.push(options.preserveBullets === true ? line.trimEnd() : trimmed);
  }
  while (sectionLines[sectionLines.length - 1] === "") {
    sectionLines.pop();
  }
  if (sectionLines.length === 0) return undefined;
  return sectionLines.join(options.preserveBullets === true ? "\n" : " ");
}

/**
 * Parse an entity markdown file into a structured EntityFile.
 * Backward compatible: old files without new sections get empty arrays.
 */
export function parseEntityFile(content: string, entitySchemas?: PluginConfig["entitySchemas"]): EntityFile {
  const { frontmatter, body } = parseEntityFrontmatter(content);
  const lines = body.split("\n");
  const recognizedSections = new Set([
    "facts",
    "timeline",
    "summary",
    "synthesis",
    "connected to",
    "activity",
    "aliases",
  ]);

  // Header
  let name = "";
  let type = "other";
  let created = frontmatter.created ?? "";
  let updated = "";
  const legacyFacts: string[] = [];
  const relationships: EntityRelationship[] = [];
  const activity: EntityActivityEntry[] = [];
  const aliases: string[] = [];
  const timeline: EntityTimelineEntry[] = [];
  const extraSections: Array<{ title: string; lines: string[] }> = [];

  // Parse name from first heading
  const headingLine = lines.find((l) => l.startsWith("# "));
  if (headingLine) name = headingLine.slice(2).trim();

  // Parse type
  const typeLine = lines.find((l) => l.startsWith("**Type:**"));
  if (typeLine) type = typeLine.replace("**Type:**", "").trim();

  // Parse updated
  const updatedLine = lines.find((l) => l.startsWith("**Updated:**"));
  if (updatedLine) updated = updatedLine.replace("**Updated:**", "").trim();
  if (!updated) updated = frontmatter.updated ?? frontmatter.created ?? "";
  if (!created) created = updated;

  const headingLineIndex = lines.findIndex((l) => l.startsWith("# "));
  const firstSectionIndex = lines.findIndex((l) => l.startsWith("## "));
  const preSectionStartIndex = headingLineIndex > -1 ? headingLineIndex + 1 : 0;
  const preSectionCandidates =
    firstSectionIndex > -1 ? lines.slice(preSectionStartIndex, firstSectionIndex) : lines.slice(preSectionStartIndex);
  const preSectionLines = preSectionCandidates.filter(
    (line) => !line.startsWith("**Type:**") && !line.startsWith("**Updated:**")
  );
  const normalizedPreSectionLines = [...preSectionLines];
  while (normalizedPreSectionLines[0] === "") {
    normalizedPreSectionLines.shift();
  }
  const preservedPreSectionLines = normalizedPreSectionLines.some((line) => line.trim().length > 0)
    ? normalizedPreSectionLines
    : [];

  const fallbackTimestamp = updated || created || "";

  // Detect which section we're in
  let section = "";
  let currentExtraSection: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      section = heading.toLowerCase();
      if (recognizedSections.has(section)) {
        currentExtraSection = null;
      } else {
        currentExtraSection = { title: heading, lines: [] };
        extraSections.push(currentExtraSection);
      }
      continue;
    }
    if (currentExtraSection) {
      currentExtraSection.lines.push(line);
    }
    if (!line.startsWith("- ")) continue;

    const bullet = line.slice(2).trim();
    if (!bullet) continue;

    switch (section) {
      case "facts":
        legacyFacts.push(bullet);
        break;
      case "timeline": {
        const parsed = parseEntityTimelineBullet(bullet, fallbackTimestamp);
        if (parsed) timeline.push(parsed);
        break;
      }
      case "summary":
      case "synthesis":
        if (isEntitySynthesisTimelinePromotionBullet(bullet)) {
          const parsed = parseEntityTimelineBullet(bullet, fallbackTimestamp);
          if (parsed) timeline.push(parsed);
        }
        // Summary/synthesis is typically a paragraph after the heading, not a bullet.
        break;
      case "connected to": {
        // Format: [[target-entity]] — relationship label
        // Drop the \s* after the dash and let (.+) capture the rest (trimmed
        // below). This removes the \s*/(.+) overlap that backtracks polynomially
        // (CodeQL js/polynomial-redos) while staying exactly equivalent to the
        // original /…\s*[—–-]\s*(.+)$/ — including whitespace-only labels, which
        // still match and trim to "" (unlike a \S-anchored capture).
        const relMatch = bullet.match(/^\[\[([^\]]+)\]\]\s*[—–-](.+)$/);
        if (relMatch) {
          relationships.push({ target: relMatch[1].trim(), label: relMatch[2].trim() });
        }
        break;
      }
      case "activity": {
        // Format: YYYY-MM-DD: note
        // Drop the \s* after the colon and let (.+) capture the rest (trimmed
        // below): removes the \s*/(.+) overlap (CodeQL js/polynomial-redos) and
        // stays exactly equivalent to the original, including whitespace-only
        // notes which still match and trim to "".
        const actMatch = bullet.match(/^(\d{4}-\d{2}-\d{2}):(.+)$/);
        if (actMatch) {
          activity.push({ date: actMatch[1], note: actMatch[2].trim() });
        }
        break;
      }
      case "aliases":
        aliases.push(bullet);
        break;
    }
  }

  const legacyFactTimelineEntries = legacyFacts.map((fact) => ({
    timestamp: fallbackTimestamp,
    text: fact,
    source: "migration" as const,
  }));

  if (legacyFactTimelineEntries.length > 0) {
    const existingTimelineFacts = new Set(
      timeline.map((entry) => entry.text.trim()).filter((entry) => entry.length > 0)
    );
    for (const fact of legacyFactTimelineEntries) {
      const normalizedFact = fact.text.trim();
      if (!normalizedFact || existingTimelineFacts.has(normalizedFact)) continue;
      timeline.push(fact);
      existingTimelineFacts.add(normalizedFact);
    }
  }

  const synthesis =
    readEntitySectionText(lines, ["Synthesis"], { preserveBullets: true, skipTimelineBullets: true }) ??
    readEntitySectionText(lines, ["Summary"], { preserveBullets: true, skipTimelineBullets: true });
  const synthesisUpdatedAt = frontmatter.synthesisUpdatedAt || undefined;
  const synthesisTimelineCount = frontmatter.synthesisTimelineCount;
  const synthesisStructuredFactCount = frontmatter.synthesisStructuredFactCount;
  const synthesisStructuredFactDigest = frontmatter.synthesisStructuredFactDigest;
  const { structuredSections, remainingExtraSections } = partitionEntityStructuredSections(
    type,
    extraSections,
    entitySchemas
  );
  const facts = compileEntityFacts(timeline, structuredSections);

  return {
    name,
    type,
    created,
    updated,
    extraFrontmatterLines: frontmatter.extraLines ?? [],
    preSectionLines: preservedPreSectionLines,
    facts,
    summary: synthesis,
    synthesis,
    synthesisUpdatedAt,
    synthesisTimelineCount,
    synthesisStructuredFactCount,
    synthesisStructuredFactDigest,
    synthesisVersion: frontmatter.synthesisVersion,
    timeline,
    structuredSections,
    relationships,
    activity,
    aliases,
    extraSections: remainingExtraSections,
  };
}

/**
 * Serialize an EntityFile back to markdown.
 * Writes the compiled-truth + timeline format while remaining parse-compatible
 * with the legacy in-memory `summary` and `facts` fields.
 */
export function serializeEntityFile(entity: EntityFile, entitySchemas?: PluginConfig["entitySchemas"]): string {
  const synthesis = entity.synthesis || entity.summary || "";
  const created = entity.created?.trim() || entity.updated || new Date().toISOString();
  const updated = entity.updated || created;
  const timeline = entity.timeline;
  const structuredSections = sortStructuredSectionsBySchema(
    entity.type,
    (entity.structuredSections ?? [])
      .map((section) => ({
        ...section,
        facts: normalizeStructuredSectionFacts(section.facts),
      }))
      .filter((section) => section.facts.length > 0),
    entitySchemas
  );
  const sectionFacts = new Set(collectStructuredSectionFacts(structuredSections));
  const legacyFacts =
    timeline.length === 0
      ? [
          ...new Set(
            entity.facts
              .map((fact) => normalizeEntitySectionFact(fact))
              .filter((fact) => fact.length > 0 && !sectionFacts.has(fact))
          ),
        ]
      : [];
  const synthesisUpdatedAt = entity.synthesisUpdatedAt?.trim() || "";
  const synthesisTimelineCount = entity.synthesisTimelineCount;
  const synthesisStructuredFactCount = entity.synthesisStructuredFactCount;
  const synthesisStructuredFactDigest = entity.synthesisStructuredFactDigest?.trim() || "";
  const synthesisVersion = entity.synthesisVersion ?? (synthesis ? 1 : 0);

  const lines: string[] = [
    "---",
    `created: ${created}`,
    `updated: ${updated}`,
    `synthesis_updated_at: "${synthesisUpdatedAt}"`,
    ...(synthesisTimelineCount === undefined ? [] : [`synthesis_timeline_count: ${synthesisTimelineCount}`]),
    ...(synthesisStructuredFactCount === undefined
      ? []
      : [`synthesis_structured_fact_count: ${synthesisStructuredFactCount}`]),
    ...(synthesisStructuredFactDigest ? [`synthesis_structured_fact_digest: "${synthesisStructuredFactDigest}"`] : []),
    `synthesis_version: ${synthesisVersion}`,
    ...(entity.extraFrontmatterLines ?? []),
    "---",
    "",
    `# ${entity.name}`,
    "",
    `**Type:** ${entity.type}`,
    `**Updated:** ${updated}`,
    "",
  ];

  if ((entity.preSectionLines ?? []).length > 0) {
    lines.push(...(entity.preSectionLines ?? []));
    if (entity.preSectionLines?.[entity.preSectionLines.length - 1] !== "") {
      lines.push("");
    }
  }

  lines.push("## Synthesis", "");
  if (synthesis) {
    lines.push(synthesis);
  }
  lines.push("");

  if (timeline.length > 0 || legacyFacts.length === 0) {
    lines.push("## Timeline", "");
    for (const entry of timeline) {
      lines.push(serializeEntityTimelineEntry(entry));
    }
    lines.push("");
  }

  if (legacyFacts.length > 0) {
    lines.push("## Facts", "");
    for (const fact of legacyFacts) {
      lines.push(`- ${fact}`);
    }
    lines.push("");
  }

  for (const section of structuredSections) {
    lines.push(`## ${section.title}`, "");
    for (const fact of section.facts) {
      lines.push(`- ${fact}`);
    }
    lines.push("");
  }

  // Connected to (optional)
  if (entity.relationships.length > 0) {
    lines.push("## Connected to", "");
    for (const rel of entity.relationships) {
      lines.push(`- [[${rel.target}]] — ${rel.label}`);
    }
    lines.push("");
  }

  // Activity (optional)
  if (entity.activity.length > 0) {
    lines.push("## Activity", "");
    for (const act of entity.activity) {
      lines.push(`- ${act.date}: ${act.note}`);
    }
    lines.push("");
  }

  // Aliases (optional)
  if (entity.aliases.length > 0) {
    lines.push("## Aliases", "");
    for (const alias of entity.aliases) {
      lines.push(`- ${alias}`);
    }
    lines.push("");
  }

  for (const section of entity.extraSections ?? []) {
    lines.push(`## ${section.title}`);
    lines.push(...section.lines);
    if (section.lines.length > 0 && section.lines[section.lines.length - 1] !== "") {
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function buildEntitySchemaCacheKey(entitySchemas?: PluginConfig["entitySchemas"]): string {
  if (!entitySchemas) return "";
  const normalized = Object.entries(entitySchemas)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entityType, schema]) => [
      entityType,
      {
        sections: schema.sections.map((section) => ({
          key: section.key,
          title: section.title,
          description: section.description,
          aliases: section.aliases ? [...section.aliases] : undefined,
        })),
      },
    ]);
  return JSON.stringify(normalized);
}

/**
 * Full-schema type guard for a `BUFFER_SURPRISE` telemetry row
 * (issue #563 PR 3).
 *
 * The reader applies `limit` over the count of VALID rows, so
 * applying only a partial check (e.g. "has a finite surpriseScore")
 * and then deferring the rest of validation to
 * `reportBufferSurpriseDistribution` would silently count
 * schema-incomplete rows toward the limit, pushing genuinely-valid
 * earlier rows out of the report window. Validate everything the
 * downstream report requires at read time so the limit semantics and
 * the distribution semantics stay consistent.
 */
export function isValidBufferSurpriseEvent(value: unknown): value is BufferSurpriseEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.event !== "BUFFER_SURPRISE") return false;
  if (typeof v.timestamp !== "string" || v.timestamp.length === 0) return false;
  if (!Number.isFinite(Date.parse(v.timestamp))) return false;
  if (typeof v.bufferKey !== "string" || v.bufferKey.length === 0) return false;
  if (v.sessionKey !== null && typeof v.sessionKey !== "string") return false;
  if (v.turnRole !== "user" && v.turnRole !== "assistant") return false;
  if (typeof v.surpriseScore !== "number" || !Number.isFinite(v.surpriseScore)) {
    return false;
  }
  // Surprise is documented as a value in [0, 1] — reject out-of-range
  // rows at read time so they do not consume the caller's `limit`.
  if (v.surpriseScore < 0 || v.surpriseScore > 1) return false;
  if (typeof v.threshold !== "number" || !Number.isFinite(v.threshold)) return false;
  if (v.threshold < 0 || v.threshold > 1) return false;
  if (typeof v.triggeredFlush !== "boolean") return false;
  if (typeof v.turnCountInWindow !== "number" || !Number.isFinite(v.turnCountInWindow)) {
    return false;
  }
  return true;
}

/** Result of {@link StorageManager.writeMemory} (issue #1645). Carries the
 * persisted id PLUS the non-resurrection tombstone-block outcome (#1579) so
 * post-write callers can observe it — NEVER a silent no-op (rule 34). */
export interface MemoryWriteResult {
  /** The persisted memory id. */
  id: string;
  /** True when the #1579 tombstone chokepoint downgraded this write to
   * `pending_review` + `blockedBy`. Callers gate active post-write work on this. */
  tombstoneBlocked: boolean;
  /** The tombstone id that blocked the write, when `tombstoneBlocked`. */
  blockedBy?: string;
  /** Existing pending-review memory id when a blocked write coalesced with it. */
  duplicateOf?: string;
}

/**
 * Defensively parse the persisted per-fingerprint extraction retry state from
 * meta.json. Mirrors the tolerance of the `processedExtractionFingerprints`
 * loader: unknown/legacy shapes are dropped, never thrown on. Uses `in`/typeof
 * narrowing (no inline casts) so a malformed entry can't slip through typed.
 */
function parseExtractionRetryStateEntries(raw: unknown): NonNullable<MetaState["extractionRetryState"]> {
  if (!Array.isArray(raw)) return [];
  const valid: NonNullable<MetaState["extractionRetryState"]> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    if (!("fingerprint" in entry) || typeof entry.fingerprint !== "string") continue;
    if (!("attempts" in entry) || typeof entry.attempts !== "number" || !Number.isFinite(entry.attempts)) continue;
    if (!("nextEligibleAt" in entry) || typeof entry.nextEligibleAt !== "string") continue;
    if (!("firstFailedAt" in entry) || typeof entry.firstFailedAt !== "string") continue;
    if (!("lastFailureClass" in entry)) continue;
    const cls = entry.lastFailureClass;
    if (cls !== "provider_retryable" && cls !== "parse_empty" && cls !== "auth_config") continue;
    const lastFailureClass: ExtractionFailureClass = cls;
    valid.push({
      fingerprint: entry.fingerprint,
      attempts: entry.attempts,
      nextEligibleAt: entry.nextEligibleAt,
      firstFailedAt: entry.firstFailedAt,
      lastFailureClass,
    });
  }
  return valid;
}

/**
 * Options accepted by `StorageManager.writeMemory` (extracted verbatim in
 * issue #1989 PR2 so `SealedWriteExtras` can be derived from it — the
 * sealed-envelope path takes envelope-owned fields from the envelope and
 * everything else from these extras).
 */
export interface WriteMemoryOptions {
  actor?: string;
  confidence?: number;
  tags?: string[];
  entityRef?: string;
  source?: string;
  supersedes?: string;
  lineage?: string[];
  importance?: ImportanceScore;
  links?: MemoryLink[];
  intentGoal?: string;
  intentActionType?: string;
  intentEntityTypes?: string[];
  artifactType?: MemoryFrontmatter["artifactType"];
  sourceMemoryId?: string;
  sourceTurnId?: string;
  memoryKind?: MemoryFrontmatter["memoryKind"];
  expiresAt?: string;
  validAt?: string;
  // Issue #1578 — bi-temporal ingestion provenance.  `observedAt` is the
  // ingestion time (when Remnic learned the fact); `eventTimeSource`
  // records whether `validAt` was resolved from an extracted expression
  // or assumed from the ingestion anchor.  Both validate on serialize.
  observedAt?: string;
  eventTimeSource?: "extracted" | "assumed";
  invalidAt?: string;
  structuredAttributes?: Record<string, string>;
  /**
   * When provided, this string is used as the source for the fact-content
   * dedup hash index instead of the persisted body (`content`).
   *
   * Use this when the persisted body differs from the canonical fact text
   * — for example when `content` is a citation-annotated variant of a raw
   * fact. Passing the raw fact as `contentHashSource` ensures that
   * `hasFactContentHash(rawFact)` returns `true` after the write, so
   * subsequent extractions of the same logical fact are correctly deduped
   * even when their citation timestamp differs.
   */
  contentHashSource?: string;
  /**
   * When true, writeMemory marks the fact-hash index dirty via `.add(...)`
   * but does NOT flush it to disk — the caller is responsible for a
   * subsequent batch save (issue #1909). The extraction persist path sets
   * this and relies on the orchestrator's authoritative
   * `saveContentHashIndexes()` batch save plus a per-storage union flush,
   * avoiding a whole-index (which grows with corpus size) rewrite per fact.
   * Default false: every
   * other (single-write) caller keeps the immediate, crash-safe save.
   */
  deferHashIndexSave?: boolean;
  status?: MemoryStatus;
  /**
   * Consolidation provenance (issue #561 PR 2).  When the caller is a
   * consolidation / supersession / dedup-merge path, these fields wire
   * the page-version snapshots the new memory was derived from and the
   * operator that produced it.  Persisted onto frontmatter as
   * `derived_from` + `derived_via`; validated at serialize time.
   */
  derivedFrom?: string[];
  derivedVia?: ConsolidationOperator;
  /**
   * Faithfulness gate verdict (issue #1576). When provided, persisted to
   * frontmatter so downstream readers (TrustScore #1577, review queue)
   * can consume it. Absent = gate was off or fact predates #1576.
   */
  faithfulness?: import("./types.js").FaithfulnessFrontmatter;
  /**
   * Claim-level provenance spans (issue #1575 PR 2). When provided,
   * persisted to frontmatter so downstream readers (memory_get, x-ray,
   * faithfulness gate #1576) can consume them. Absent = fact predates
   * #1575 or provenance was disabled.
   */
  sources?: ProvenanceSource[];
  provenance?: "verified" | "unverified" | "none";
  sourceConnector?: string;
  toolScoped?: true;
}

/**
 * `WriteMemoryOptions` minus the fields a `SealedMemoryEnvelope` owns.
 * Passing an envelope-owned field twice is a compile error by construction.
 */
export type SealedWriteExtras = Omit<
  WriteMemoryOptions,
  "confidence" | "tags" | "entityRef" | "source" | "expiresAt" | "validAt" | "structuredAttributes" | "sourceConnector"
>;

export class StorageManager extends TombstoneBlockedCaptureIndexHost {
  private knowledgeIndexCache: { result: string; builtAt: number } | null = null;
  private artifactIndexCache: { memories: MemoryFile[]; loadedAtMs: number; writeVersion: number } | null = null;
  private projectionLedgerLagManager = new ProjectionLedgerLagManager();
  private static readonly loadedMemorySnapshots = new WeakMap<MemoryFile, string>();
  static readonly KNOWLEDGE_INDEX_CACHE_TTL_MS = 600_000; // 10 minutes (entity mutations invalidate)
  /** Read by storage/memory-read-store.ts (decomposition). */
  static readonly ARTIFACT_INDEX_CACHE_TTL_MS = 60_000; // 1 minute
  private static readonly artifactWriteVersionByDir = new Map<string, number>();
  private static readonly memoryStatusVersionByDir = new Map<string, number>();
  // Corpus version sentinel (issue #1902): bumped on every memory-FILE mutation
  // so the version-keyed hot-memories cache stays coherent across processes,
  // without touching memory-status (which would invalidate the entity cache on
  // every plain create). In-process fallback when the on-disk sentinel is
  // unavailable; canonical source is state/.memory-corpus-version.log.
  private static readonly memoryCorpusVersionByDir = new Map<string, number>();
  // Entity-mutation sentinel: see getEntityMutationVersion.
  private static readonly entityMutationVersionByDir = new Map<string, number>();
  private static readonly secureStoreEntityCacheKeyIds = new WeakMap<Buffer, number>();
  private static nextSecureStoreEntityCacheKeyId = 1;
  // In-process fallback for the cold-write sentinel (used when the disk file
  // is not accessible).  The canonical source of truth is state/cold-write.log.
  private static readonly coldWriteVersionByDir = new Map<string, number>();

  /**
   * Process-wide default for the hot-memories result cache gate (issue #1902).
   * Set once from config by the orchestrator/access layer via
   * setHotMemoriesCacheDefault() so that EVERY StorageManager — including the
   * ephemeral instances recall sub-stages (verified-recall, semantic-rule
   * verification, ...) construct over the same dir — honors the operator's
   * hotMemoriesCacheEnabled setting. The constructor option overrides this
   * per-instance (tests). Defaults true (cache on).
   */
  private static hotMemoriesCacheDefault = true;

  /**
   * Per-memory-directory override of the hot-cache gate (issue #1902, Codex
   * P2). setHotMemoriesCacheDefault(memoryDir, enabled) registers the
   * operator's setting keyed by dir, so a StorageManager constructed over that
   * dir honors ITS owning orchestrator's config — not merely the last
   * orchestrator constructed in the process. Unregistered dirs fall back to
   * the process-wide default above.
   */
  private static readonly hotMemoriesCacheDefaultByDir = new Map<string, boolean>();

  /**
   * Process-wide TTL (ms) safety net for the hot cache (issue #1902). Bounds
   * how long a version-keyed entry is served before a fresh disk scan, so
   * external filesystem edits (manual/git/editor) that don't bump the sentinel
   * self-heal. Set from config by the orchestrator via setHotMemoriesCacheDefault.
   * 0 disables the TTL (version invalidation only). Default 60s.
   */
  private static hotMemoriesCacheTtlMs = 60_000;

  /**
   * Per-memory-directory override of the hot-cache TTL (issue #1902, Codex P2),
   * mirroring hotMemoriesCacheDefaultByDir. Registered by
   * setHotMemoriesCacheDefault so two orchestrators in one process with
   * different TTLs don't clobber each other's setting. Unregistered dirs fall
   * back to the process-wide default above.
   */
  private static readonly hotMemoriesCacheTtlByDir = new Map<string, number>();

  /**
   * Whether the process-wide hot-cache fallbacks (hotMemoriesCacheDefault /
   * hotMemoriesCacheTtlMs) have been seeded by the first
   * setHotMemoriesCacheDefault call (issue #1902, Cursor Low). Only the first
   * registration seeds them; later registrations touch ONLY their per-dir map
   * entry. This makes the process-wide fallback deterministic (first-writer,
   * by init order) instead of last-writer-wins, so a second orchestrator with
   * a divergent config cannot silently flip the fallback that unregistered
   * dirs resolve to. All REGISTERED dirs are isolated by the per-dir maps.
   */
  private static hotMemoriesCacheProcessDefaultSeeded = false;

  /**
   * Per-memory-directory gate for scope-aware cache invalidation (issue #1904).
   * Registered from config by the orchestrator via
   * setScopedCacheInvalidationDefault() so every StorageManager built over a
   * memory dir — including ephemeral recall sub-stage instances — honors the
   * operator's setting. Unregistered dirs default to `true` (scoped on). Set
   * `false` to restore the pre-#1904 full-clear-per-write behavior (rollback
   * lever). Read once per write via isScopedCacheInvalidationEnabled().
   */
  private static readonly scopedCacheInvalidationByDir = new Map<string, boolean>();

  // Module-level maps for readAllMemories() keyed by base directory, shared
  // across all StorageManager instances (static) so concurrent callers over
  // the same dir cooperate.

  // Cache for readAllColdMemories() — keyed by cold root directory path.
  // Prevents an uncached full-tree directory scan on every structured-attribute
  // write (Finding UOGi, PR #402 round-6). Invalidated when cold-tier content
  // changes (via invalidateColdMemoriesCache) and expires after COLD_SCAN_CACHE_TTL_MS.
  // Entries carry a `coldVersion` sentinel (Finding UvUy, PR #402 round-11) bumped
  // on every cold-tier write, making the cache correct across process boundaries
  // (gateway + CLI). After Finding UTsP broadened the scan to the entire cold/
  // subtree, amortizing across back-to-back writes is even more important.
  /** Read by storage/memory-read-store.ts (decomposition). */
  static readonly COLD_SCAN_CACHE_TTL_MS = 30_000; // 30 seconds
  /** Read by storage/memory-read-store.ts (decomposition). */
  static readonly coldMemoriesCache = new Map<
    string,
    { memories: MemoryFile[]; loadedAt: number; coldVersion: number; keyId: string }
  >();

  // Cache for readQuestions() — avoids serially re-reading tens of thousands of
  // question files on every recall.  60-second TTL is intentionally short so that
  // newly written questions surface quickly.
  /** Read by storage/memory-read-store.ts (decomposition). */
  static readonly QUESTIONS_CACHE_TTL_MS = 60_000; // 1 minute
  /** Read by storage/memory-read-store.ts (decomposition). */
  static readonly questionsCache = new Map<
    string,
    {
      questions: Array<{
        id: string;
        question: string;
        context: string;
        priority: number;
        resolved: boolean;
        created: string;
        filePath: string;
      }>;
      loadedAt: number;
    }
  >();
  private factHashIndex: ContentHashIndex | null = null;
  private factHashIndexLoadPromise: Promise<ContentHashIndex> | null = null;
  private factHashIndexAuthoritative: boolean | null = null;
  private factHashIndexAuthoritativePromise: Promise<boolean> | null = null;
  /**
   * Fact-ONLY hash membership (PR #2016). The shared `factHashIndex` above is
   * category-agnostic (the round-15 corpus rebuild + addContentHashDedup index
   * every category), so it cannot answer a fact-only question. This set carries
   * only `category === "fact"` hashes and is the sole source for
   * `hasFactContentHash`, so an over-included non-fact body can never suppress a
   * real fact candidate. Kept in lockstep with the shared index on EVERY path:
   * the authoritative corpus rebuild (repopulated in place), the write path
   * (`writeMemory` / `addActiveFactContentHash`), the storage-owned removal
   * (`removeFactContentHashesForMemories`), AND the orchestrator's archival /
   * consolidation removal (`removeContentHashForMemory` ->
   * `removeFactOnlyHashForMemory`). In-memory only; never persisted.
   */
  private factOnlyHashes: Set<string> = new Set();
  /** Optional lock/retry tuning for the fact-hash index cross-process lock (PR #2016; tests inject tight budgets). */
  factHashIndexLockOptions: ContentHashIndexLockOptions = {};
  private readonly secureAppendChains = new Map<string, Promise<void>>();
  /**
   * Cache of "is this file encrypted?" keyed by absolute path, VALIDATED by file
   * identity (size + mtimeMs) — issue #1909 review round 10 finding 1. A prior
   * design cached only a boolean and relied on this instance's own writes to
   * invalidate it; a PEER process encrypting the file would not invalidate,
   * leaving a stale `false` that made the append path write RAW bytes into an
   * encrypted file (corruption). Now each entry records the (size, mtime) the
   * classification was read at; `isEncryptedFileHeader` re-sniffs (header-only)
   * whenever the on-disk identity no longer matches, so a foreign rewrite is
   * detected. The whole-file read is still never performed.
   */
  private readonly secureFileEncryptionSniffCache = new Map<
    string,
    { identity: { size: number; mtimeMs: number }; encrypted: boolean }
  >();
  private offlineSyncDigestCache: Map<string, OfflineSyncDigestCacheEntry> | null = null;
  private offlineSyncDigestCacheLoadPromise: Promise<Map<string, OfflineSyncDigestCacheEntry>> | null = null;
  private offlineSyncDigestCacheWriteChain: Promise<void> = Promise.resolve();
  private offlineSyncDigestCacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Optional: set by the orchestrator after construction to enable template-aware citation stripping during legacy hash rebuild. */
  citationTemplate: string = DEFAULT_CITATION_FORMAT;
  /** Post-write catalog hook (#1522). Installed by the namespace router; fire-and-forget. */
  onCatalogWrite?: () => void;
  /** Post-write embedding hook (#2019). Installed by the orchestrator; fire-and-forget. */
  onMemoryWrite?: (filePath: string) => void;
  private notifyMemoryWrite(filePath: string): void {
    try {
      this.onMemoryWrite?.(filePath);
    } catch {
      /* fire-and-forget — embedding failures must not block writes */
    }
  }
  private notifyCatalogWrite(): void {
    try {
      this.onCatalogWrite?.();
    } catch {
      /* gotcha #13 */
    }
  }

  /**
   * Whether pure state-file writes touch the namespace catalog (issue #1903).
   * Set by `NamespaceStorageRouter.bindCatalogWriteHook` from
   * `namespacesCatalogTouchStateWrites` (default false). State files
   * (`state/buffer.json`, ledgers, indexes) are not namespace memory data, so by
   * default their writes do NOT record a catalog touch.
   */
  touchStateWrites = false;

  /**
   * Post-write catalog hook, gated by file path (issue #1903). Namespace data
   * (`facts/`, `cold/`, `entities/`, `artifacts/`, `profile.md`, ...) lives
   * OUTSIDE `stateDir`, so a data write always touches; a write under `stateDir`
   * is a pure state write and is skipped unless `touchStateWrites` is enabled.
   */
  protected notifyCatalogWriteForPath(filePath: string): void {
    if (!this.touchStateWrites && this.isStateFilePath(filePath)) return;
    this.notifyCatalogWrite();
  }

  /** Whether `filePath` resolves to `stateDir` itself or a path contained in it. */
  private isStateFilePath(filePath: string): boolean {
    const rel = path.relative(this.stateDir, path.resolve(filePath));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  // ── Tombstone store (issue #1579) ───────────────────────────────────────
  // Instance-scoped (rule 11) + namespace-scoped (rule 42) tombstone index.
  // Lazily loaded from <stateDir>/tombstones.jsonl; invalidated together with
  // every other cache layer via invalidateAllMemoriesCache (rule 25).
  private tombstoneStore: TombstoneStore | null = null;
  private tombstoneStoreLoadPromise: Promise<TombstoneStore> | null = null;
  private tombstonesConfig: {
    enabled: boolean;
    semanticMatch: boolean;
    semanticThreshold: number;
    namespace: string;
  } = { enabled: false, semanticMatch: false, semanticThreshold: 0.9, namespace: "default" };

  /** Page-versioning configuration.  Set by the orchestrator after construction. */
  private _versioningConfig: VersioningConfig | null = null;

  /** Set the page-versioning configuration.  When `enabled` is false (default), all versioning calls are no-ops. */
  setVersioningConfig(config: VersioningConfig): void {
    this._versioningConfig = config;
  }

  /**
   * At-rest encryption key (issue #690 PR 3/4).
   *
   * When non-null, every memory file read is decrypted and every write
   * is encrypted using the secure-fs layer.  When null, the storage
   * layer operates in plain-text mode (legacy/unencrypted store).
   *
   * Set by the orchestrator after init/unlock; cleared on lock.
   * The key buffer is NEVER logged or serialized.
   */
  private _secureStoreKey: Buffer | null = null;

  /**
   * When true (and `_secureStoreKey` is non-null), new writes are
   * encrypted.  Set to false to pause encryption of new writes while
   * still decrypting existing files.
   */
  private _secureStoreEncryptOnWrite = true;

  /**
   * When true, the secure-store is configured as required — writes
   * MUST be encrypted and a locked store MUST reject writes rather
   * than silently falling back to plaintext.  Set by the orchestrator
   * from `resolveRecallAuxiliaryCapabilities(config).secureStore`.
   */
  private _secureStoreRequired = false;

  /**
   * Set or clear the at-rest encryption key.
   *
   * Pass a 32-byte Buffer to enable encryption; pass null to clear
   * (lock) the store. The caller is responsible for key lifecycle —
   * this method does not zero the buffer on replacement; the keyring
   * module (`keyring.ts`) owns zeroization. The setter remains synchronous
   * for existing consumers; call `setSecureStoreKeyAndWait` when unlock must
   * await migration.
   */
  setSecureStoreKey(key: Buffer | null, encryptOnWrite = true): void {
    if (!this.applySecureStoreKey(key, encryptOnWrite) || key === null) return;
    void this.entityCanonicalIdMigration.triggerAfterUnlock().catch((error: unknown) => {
      log.warn(`secure-store unlock migration failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  public async setSecureStoreKeyAndWait(key: Buffer | null, encryptOnWrite = true): Promise<void> {
    if (!this.applySecureStoreKey(key, encryptOnWrite) || key === null) return;
    await this.entityCanonicalIdMigration.triggerAfterUnlock();
  }

  private applySecureStoreKey(key: Buffer | null, encryptOnWrite: boolean): boolean {
    const sameKey =
      this._secureStoreKey === key ||
      (this._secureStoreKey !== null && key !== null && this._secureStoreKey.equals(key));
    if (sameKey && this._secureStoreEncryptOnWrite === encryptOnWrite) return false;

    this._secureStoreKey = key;
    this._secureStoreEncryptOnWrite = encryptOnWrite;
    invalidateAllForDir(this.baseDir);
    this.invalidateKnowledgeIndexCache();
    this.secureFileEncryptionSniffCache.clear();
    this.behaviorSignalsKeyCache = null;
    return true;
  }

  private getEntityCacheSecureStoreKey(): string {
    if (!this._secureStoreKey) return "secure-store:locked";
    let id = StorageManager.secureStoreEntityCacheKeyIds.get(this._secureStoreKey);
    if (id === undefined) {
      id = StorageManager.nextSecureStoreEntityCacheKeyId++;
      StorageManager.secureStoreEntityCacheKeyIds.set(this._secureStoreKey, id);
    }
    return `secure-store:key:${id}`;
  }

  /**
   * Secure-store key identity for the version-keyed hot/archive memory caches
   * (issue #1902, Codex P1). Scopes cached DECRYPTED corpora by the key that
   * decrypted them, so a locked/unkeyed StorageManager for the same baseDir
   * never reads content another instance decrypted under a key (which would
   * bypass the locked-store error). Plaintext and locked stores share the ""
   * namespace; an unlocked encrypted store uses its per-key id.
   */
  hotCacheKeyId(): string {
    return this._secureStoreKey === null ? "" : this.getEntityCacheSecureStoreKey();
  }

  /**
   * Resolved hot-cache gate for THIS store (issue #1902, Cursor Medium): the
   * per-instance override if one was passed, else the per-dir/process default.
   * Recall sub-stages (verified-recall, semantic-rule) read this to honor the
   * operator's opt-out for their derived caches even when the caller omits the
   * flag in options.
   */
  isHotCacheEnabled(): boolean {
    return this.hotMemoriesCacheEnabled;
  }

  /**
   * Effective hot-cache TTL (ms) for this store's dir (issue #1902): the per-dir
   * registration if present, else the process-wide default. 0 disables the TTL.
   */
  hotCacheTtlMs(): number {
    return StorageManager.hotMemoriesCacheTtlByDir.get(this.baseDir) ?? StorageManager.hotMemoriesCacheTtlMs;
  }

  /**
   * True if `p` lives in this store's cold/ or archive/ tier (issue #1902,
   * Codex P2). Determined RELATIVE to baseDir — a substring scan of the
   * absolute path would misclassify every active path when memoryDir itself is
   * nested under a dir literally named "cold" or "archive" (e.g.
   * /srv/cold/remnic), skipping the patch and stranding a stale hot entry.
   */
  private isColdOrArchiveTierPath(p: string): boolean {
    const rel = path.relative(this.baseDir, p);
    return (
      rel === "cold" || rel === "archive" || rel.startsWith(`cold${path.sep}`) || rel.startsWith(`archive${path.sep}`)
    );
  }

  /**
   * Mark the secure-store as required for this storage instance.
   * When required and locked, writes throw SecureStoreLockedError
   * rather than silently writing plaintext.
   */
  setSecureStoreRequired(required: boolean): void {
    this._secureStoreRequired = required;
  }

  /** Return true iff the secure-store key is currently set (store is unlocked). */
  isSecureStoreUnlocked(): boolean {
    return this._secureStoreKey !== null;
  }

  /** Whether a state-file write encrypts at rest (encrypt-on-write on AND key
   *  set) — the write mode lifecycle compaction reserves the envelope for (#2033). */
  willEncryptStateWrites(): boolean {
    return this._secureStoreEncryptOnWrite && this._secureStoreKey !== null;
  }

  /**
   * Resolve the effective write key: null when encrypt-on-write is off or the
   * store is unlocked-optional; the key when set; else throws
   * SecureStoreLockedError under a required-but-locked store (PR #767) instead
   * of silently writing plaintext.
   *
   * `forceEncrypt` overrides the encrypt-on-write policy flag ONLY (issue
   * #2033): a lifecycle-ledger compaction of an already-encrypted ledger/backup
   * must preserve encryption at rest even when `secureStoreEncryptOnWrite` is
   * paused, or it would silently downgrade encrypted state to plaintext. It
   * never bypasses the LOCK: when the store has no key it still returns null
   * (optional) or throws (required), so a keyless caller can never fabricate an
   * encrypted write.
   */
  private resolveWriteKey(forceEncrypt = false): Buffer | null {
    if (!forceEncrypt && !this._secureStoreEncryptOnWrite) return null;
    if (this._secureStoreKey !== null) return this._secureStoreKey;
    if (this._secureStoreRequired) {
      throw new SecureStoreLockedError(
        "secure-store is locked — cannot write memory file. " +
          "Run `remnic secure-store unlock` to decrypt, or restart the daemon after unlocking."
      );
    }
    return null;
  }

  /**
   * Snapshot the current content of a page before overwriting.
   * No-op when versioning is disabled or the file does not yet exist.
   */
  private async snapshotBeforeWrite(filePath: string, trigger: VersionTrigger): Promise<void> {
    if (!this._versioningConfig || !this._versioningConfig.enabled) return;
    try {
      // Use the secure-fs read path so the snapshot captures plaintext
      // regardless of whether the file is currently encrypted on disk.
      const existing = await readMaybeEncryptedFile(filePath, this._secureStoreKey, this.baseDir);
      await createPageVersion(filePath, existing, trigger, this._versioningConfig, log, undefined, this.baseDir);
    } catch {
      // File does not exist yet — nothing to snapshot
    }
  }

  /**
   * Consolidation provenance helper (issue #561 PR 2).
   *
   * Captures the current on-disk content of a source memory as a
   * page-version snapshot so the downstream consolidated write can record a
   * `derived_from` pointer that actually resolves.  Returns the
   * `"<relative-path>:<versionId>"` entry expected by the `derived_from`
   * frontmatter field.
   *
   * Returns `null` when versioning is disabled (snapshots would not be
   * created), when the file does not exist (nothing to snapshot), or when
   * the snapshot write itself fails (best-effort — callers skip the entry
   * rather than block the consolidation).
   */
  async snapshotForProvenance(filePath: string): Promise<string | null> {
    if (!this._versioningConfig || !this._versioningConfig.enabled) return null;
    let existing: string;
    try {
      existing = await readMaybeEncryptedFile(filePath, this._secureStoreKey, this.baseDir);
    } catch {
      return null;
    }
    try {
      const version = await createPageVersion(
        filePath,
        existing,
        "consolidation",
        this._versioningConfig,
        log,
        undefined,
        this.baseDir
      );
      const rel = path.relative(this.baseDir, filePath).split(path.sep).join("/");
      return `${rel}:${version.versionId}`;
    } catch (err) {
      log.warn(
        `storage.snapshotForProvenance: failed to snapshot ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  private readonly hotMemoriesCacheEnabled: boolean;

  constructor(
    private readonly baseDir: string,
    private readonly entitySchemas?: PluginConfig["entitySchemas"],
    /**
     * Hot-memories result cache gate (issue #1902). When omitted, resolves to
     * the per-directory default registered by setHotMemoriesCacheDefault()
     * (falling back to the process-wide default); pass an explicit boolean to
     * override per-instance (tests, memory-constrained readers).
     */
    hotMemoriesCacheEnabledOverride?: boolean
  ) {
    super();
    this.hotMemoriesCacheEnabled =
      hotMemoriesCacheEnabledOverride ??
      StorageManager.hotMemoriesCacheDefaultByDir.get(baseDir) ??
      StorageManager.hotMemoriesCacheDefault;
    // Load this store's alias table at construction (#1534): StorageManager
    // is created in a dozen places (namespace router, operator toolkit,
    // compounding engine, cold storage, ...) and most never call
    // loadAliases() explicitly — every creation path must still get the
    // store's own aliases, never an empty or foreign table.
    this.loadAliasesSync();
  }

  /** Set the process-wide hot-memories cache default (issue #1902). The
   *  orchestrator/access layer calls this with the operator's
   *  hotMemoriesCacheEnabled config so the escape hatch reaches every
   *  StorageManager, including ephemeral recall-sub-stage instances. Only an
   *  explicit `false` disables; `undefined` (e.g. a cast test config missing
   *  the field) leaves the cache on. */
  static setHotMemoriesCacheDefault(memoryDir: string, enabled: boolean | undefined, ttlMs?: number): void {
    // Register per-dir so each orchestrator's config reaches every
    // StorageManager built over its own memory dir (Codex P2). The per-dir map
    // is authoritative for every registered dir.
    StorageManager.hotMemoriesCacheDefaultByDir.set(memoryDir, enabled !== false);
    // TTL safety net: a finite, non-negative override wins (0 honored = disable).
    // Registered per-dir (Codex P2) so concurrent orchestrators with different
    // TTLs don't clobber each other.
    const ttlValid = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs >= 0;
    if (ttlValid) {
      StorageManager.hotMemoriesCacheTtlByDir.set(memoryDir, ttlMs as number);
    }
    // Seed the process-wide fallbacks (for UNregistered dirs) ONCE, from the
    // first registration only (issue #1902, Cursor Low). A later orchestrator
    // with a divergent config must not flip the fallback out from under the
    // first — that was a last-writer-wins race. First-writer is deterministic
    // by init order, and every registered dir is isolated per-dir above.
    if (!StorageManager.hotMemoriesCacheProcessDefaultSeeded) {
      StorageManager.hotMemoriesCacheDefault = enabled !== false;
      if (ttlValid) StorageManager.hotMemoriesCacheTtlMs = ttlMs as number;
      StorageManager.hotMemoriesCacheProcessDefaultSeeded = true;
    }
  }

  /** Register the operator's scope-aware cache invalidation gate for a memory
   *  dir (issue #1904). The orchestrator/access layer calls this with
   *  the operator's scopedCacheInvalidationEnabled flag so the setting reaches every
   *  StorageManager built over the dir, including ephemeral recall-sub-stage
   *  instances. Only an explicit `false` disables; `undefined` leaves it on. */
  static setScopedCacheInvalidationDefault(memoryDir: string, enabled: boolean | undefined): void {
    StorageManager.scopedCacheInvalidationByDir.set(memoryDir, enabled !== false);
  }

  /**
   * The LIVE class object of this instance (issue #1809 review of the
   * storage decomposition): extracted store modules must read/write the
   * shared static caches (questionsCache, coldMemoriesCache, ...) through
   * the SAME class binding the host methods use. Referencing the imported
   * `StorageManager` symbol from a split bundle chunk can yield a second
   * class copy with its own statics, split-braining the caches
   * (resolveQuestion clears copy A while readQuestions reads copy B).
   */
  get storageManagerClass(): typeof StorageManager {
    return this.constructor as typeof StorageManager;
  }

  /** The root directory of this storage instance. */
  /** MemoryReadStore (storage.ts decomposition). Lazy; selfDeps live wiring. */
  private _memoryReadStore: MemoryReadStore | undefined;

  private get memoryReadStore(): MemoryReadStore {
    if (!this._memoryReadStore) {
      this._memoryReadStore = new MemoryReadStore(selfDeps<ConstructorParameters<typeof MemoryReadStore>[0]>(this));
    }
    return this._memoryReadStore;
  }

  /** EntityStore (storage.ts decomposition). Lazy; selfDeps live wiring. */
  private _entityStore: EntityStore | undefined;

  private get entityStore(): EntityStore {
    if (!this._entityStore) {
      this._entityStore = new EntityStore(selfDeps<ConstructorParameters<typeof EntityStore>[0]>(this));
    }
    return this._entityStore;
  }

  /** IdentityContinuityStore (storage.ts decomposition). Lazy; selfDeps live wiring. */
  private _identityContinuityStore: IdentityContinuityStore | undefined;

  private get identityContinuityStore(): IdentityContinuityStore {
    if (!this._identityContinuityStore) {
      this._identityContinuityStore = new IdentityContinuityStore(
        selfDeps<ConstructorParameters<typeof IdentityContinuityStore>[0]>(this)
      );
    }
    return this._identityContinuityStore;
  }

  get dir(): string {
    return this.baseDir;
  }

  private identityFilePath(workspaceDir: string, namespace?: string): string {
    const rawNamespace = typeof namespace === "string" ? namespace.trim() : "";
    if (!rawNamespace) return path.join(workspaceDir, "IDENTITY.md");
    const safeNamespace = rawNamespace.replace(/[^a-zA-Z0-9._-]/g, "-");
    return path.join(workspaceDir, `IDENTITY.${safeNamespace}.md`);
  }

  private versionFilePath(kind: SharedVersionKind): string {
    return path.join(this.stateDir, `.${kind}-version.log`);
  }

  private bumpSharedVersion(kind: SharedVersionKind, fallbackMap: Map<string, number>): number {
    const filePath = this.versionFilePath(kind);
    try {
      mkdirSync(this.stateDir, { recursive: true });
      appendFileSync(filePath, "x");
      const next = statSync(filePath).size;
      fallbackMap.set(this.baseDir, next);
      return next;
    } catch {
      const next = (fallbackMap.get(this.baseDir) ?? 0) + 1;
      fallbackMap.set(this.baseDir, next);
      return next;
    }
  }

  private readSharedVersion(kind: SharedVersionKind, fallbackMap: Map<string, number>): number {
    const filePath = this.versionFilePath(kind);
    try {
      return statSync(filePath).size;
    } catch {
      return fallbackMap.get(this.baseDir) ?? 0;
    }
  }

  protected bumpMemoryStatusVersion(): void {
    this.bumpSharedVersion("memory-status", StorageManager.memoryStatusVersionByDir);
    // Corpus sentinel too: peer processes rescan the hot-memories cache
    // after status/lifecycle/bulk mutations (#1902); invalidateAllForDir
    // below drops the hot layer locally.
    this.bumpSharedVersion("memory-corpus", StorageManager.memoryCorpusVersionByDir);
    // Invalidation chokepoint (#1535): several status/entity mutations
    // (supersede, archiveMemories, writeEntity, commitment cleanup) never
    // call invalidateAllMemoriesCache; the TTL-based QMD caches need this
    // eager clear.
    invalidateAllForDir(this.baseDir);
  }

  getMemoryStatusVersion(): number {
    return this.readSharedVersion("memory-status", StorageManager.memoryStatusVersionByDir);
  }

  /**
   * Entity content revision used by migration discovery and entity-page cache coherence.
   */
  getEntityMutationVersion(): number {
    return this.readSharedVersion("entity-mutation", StorageManager.entityMutationVersionByDir);
  }

  protected bumpEntityMutationVersion(): void {
    invalidateForScope(this.baseDir, "entity-write");
    this.bumpSharedVersion("entity-mutation", StorageManager.entityMutationVersionByDir);
  }

  /**
   * Corpus version sentinel for the hot-memories result cache (#1902).
   * Distinct from memory-status: bumps on EVERY memory-file mutation so the
   * version-keyed hot cache stays coherent across processes, WITHOUT
   * invalidating the version-keyed entity cache on every plain fact create.
   */
  getMemoryCorpusVersion(): number {
    return this.readSharedVersion("memory-corpus", StorageManager.memoryCorpusVersionByDir);
  }

  protected bumpMemoryCorpusVersion(): void {
    // Bump only — NOT invalidateAllForDir (that would drop the very hot
    // entry the write path just patched).
    this.bumpSharedVersion("memory-corpus", StorageManager.memoryCorpusVersionByDir);
    // Drop the in-flight readAllMemories slot (#1902): a concurrent read
    // must not attach to a scan that began BEFORE this mutation. (The patch
    // path uses bumpMemoryCorpusVersionExclusive and clears the slot itself.)
    deleteInFlightReadsForDir(this.baseDir);
  }

  /**
   * Corpus bump reporting whether THIS process's append was the only one
   * since the pre-bump size (#1902, Codex P1): the `exclusive` flag lets
   * patchHotMemoriesCache refuse to re-key its locally patched corpus at a
   * version already reflecting a peer's still-unread concurrent append.
   */
  private bumpMemoryCorpusVersionExclusive(): { produced: number; exclusive: boolean } {
    const filePath = this.versionFilePath("memory-corpus");
    try {
      mkdirSync(this.stateDir, { recursive: true });
      let before = 0;
      try {
        before = statSync(filePath).size;
      } catch {
        before = 0;
      }
      appendFileSync(filePath, "x");
      const produced = statSync(filePath).size;
      StorageManager.memoryCorpusVersionByDir.set(this.baseDir, produced);
      // Exclusive iff exactly our single byte landed between the two stats.
      return { produced, exclusive: produced === before + 1 };
    } catch {
      const next = (StorageManager.memoryCorpusVersionByDir.get(this.baseDir) ?? 0) + 1;
      StorageManager.memoryCorpusVersionByDir.set(this.baseDir, next);
      return { produced: next, exclusive: true };
    }
  }

  protected bumpArtifactWriteVersion(): number {
    return this.bumpSharedVersion("artifact-write", StorageManager.artifactWriteVersionByDir);
  }

  private getArtifactWriteVersion(): number {
    return this.readSharedVersion("artifact-write", StorageManager.artifactWriteVersionByDir);
  }

  // -------------------------------------------------------------------------
  // Wearable day transcripts
  //
  // Stored under `<baseDir>/wearables/<source>/<YYYY-MM-DD>.md` — outside
  // the memory scan roots (never surfaces as a memory) but inside the QMD
  // collection root (full-text searchable). IO lives here so transcripts
  // inherit the same encrypted-at-rest + atomic-write semantics as
  // memories.
  // -------------------------------------------------------------------------

  private get wearablesDir(): string {
    return path.join(this.baseDir, WEARABLES_DIR_NAME);
  }

  /**
   * Resolve the on-disk path for a source/day transcript. Throws on
   * malformed inputs — source ids and dates reach this from CLI/MCP/HTTP
   * surfaces and must never become path traversal.
   */
  wearableTranscriptPath(sourceId: string, date: string): string {
    if (typeof sourceId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(sourceId)) {
      throw new Error(
        `invalid wearable source id '${String(sourceId)}' — expected lowercase letters, digits, and dashes`
      );
    }
    if (!isValidTranscriptDate(date)) {
      throw new Error(`invalid wearable transcript date '${String(date)}' — expected YYYY-MM-DD`);
    }
    return path.join(this.wearablesDir, sourceId, `${date}.md`);
  }

  async writeWearableDayTranscript(sourceId: string, date: string, serialized: string): Promise<void> {
    const targetPath = this.wearableTranscriptPath(sourceId, date);
    // writeMaybeEncryptedFile handles mkdir + atomic temp→rename.
    await this.writeStorageSecureFile(targetPath, serialized);
  }

  /** Read a stored day transcript; null when the day has no file. */
  async readWearableDayTranscript(sourceId: string, date: string): Promise<string | null> {
    const targetPath = this.wearableTranscriptPath(sourceId, date);
    try {
      return await readMaybeEncryptedFile(targetPath, this._secureStoreKey, this.baseDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async listWearableTranscriptDays(sourceId?: string): Promise<Array<{ source: string; date: string }>> {
    return this.memoryReadStore.listWearableTranscriptDays(sourceId);
  }

  private _fusionStore?: FusionArtifactStore;

  /** Derived fusion-day IO; file IO lives in wearables/fusion (#1810). */
  fusionArtifactStore(): FusionArtifactStore {
    if (this._fusionStore) return this._fusionStore;
    return (this._fusionStore = new FusionArtifactStore(this.wearablesDir, this.baseDir, {
      writeFile: (p, c) => this.writeStorageSecureFile(p, c),
      readFile: (p) => readMaybeEncryptedFile(p, this._secureStoreKey, this.baseDir),
      readDir: (d) => readdir(d),
      deleteFile: (p) => unlink(p),
      realpath: (p) => realpath(p),
      lstat: (p) => lstat(p).then((st) => ({ isSymbolicLink: st.isSymbolicLink() })),
    }));
  }

  private _meetingRecordStore?: MeetingRecordStore;

  /**
   * Meeting record IO (issue #1900). Records live under `<baseDir>/meetings/`
   * — inside the QMD collection root (full-text searchable) but outside the
   * memory scan roots — and inherit the same encrypted-at-rest + atomic-write +
   * symlink-containment semantics as memories via the shared secure IO port.
   */
  meetingRecordStore(): MeetingRecordStore {
    if (this._meetingRecordStore) return this._meetingRecordStore;
    return (this._meetingRecordStore = new MeetingRecordStore(this.baseDir, {
      writeFile: (p, c) => this.writeStorageSecureFile(p, c),
      readFile: (p) => readMaybeEncryptedFile(p, this._secureStoreKey, this.baseDir),
      readDir: (d) => readdir(d),
      deleteFile: (p) => unlink(p),
      realpath: (p) => realpath(p),
      lstat: (p) => lstat(p).then((st) => ({ isSymbolicLink: st.isSymbolicLink() })),
    }));
  }

  /**
   * Locate a wearable-sourced memory by exact (trimmed) content,
   * ignoring the "[Attributes: ...]" suffix writeMemory appends for
   * structuredAttributes — callers pass the raw fact text. Used by the
   * smart trust pipeline to find an earlier borderline write when the
   * same fact re-extracts with stronger evidence.
   */
  async findWearableMemoryByContent(content: string): Promise<{ id: string; status: MemoryStatus | undefined } | null> {
    const needle = stripAttributesSuffix(content);
    const memories = await this.readAllMemories();
    for (const memory of memories) {
      if (
        typeof memory.frontmatter.source === "string" &&
        memory.frontmatter.source.startsWith("wearable:") &&
        stripAttributesSuffix(memory.content) === needle
      ) {
        return { id: memory.frontmatter.id, status: memory.frontmatter.status };
      }
    }
    return null;
  }

  /**
   * Promote a pending_review wearable memory to active in place,
   * merging updated trust evidence into structuredAttributes. Returns
   * false when the memory is missing or no longer pending_review (a
   * concurrent review decision wins), or when the row is tombstone-blocked
   * (`blockedBy` — issue #1579 threads OcuDx/Ocu1l): writeMemoryFrontmatter
   * bypasses the writeMemory chokepoint, so a blocked row must first be
   * cleared via revokeTombstone before promotion can proceed.
   */
  async promoteWearableMemory(
    id: string,
    attributeUpdates: Record<string, string>,
    confidence?: number
  ): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((entry) => entry.frontmatter.id === id);
    if (!memory) return false;
    if (memory.frontmatter.status !== "pending_review") return false;
    // Tombstone-blocked rows need revokeTombstone first (issue #1579 OcuDx/Ocu1l).
    if (memory.frontmatter.blockedBy) return false;
    return this.writeMemoryFrontmatter(memory, {
      status: "active",
      // Keep frontmatter confidence in step with the re-scored trust —
      // new smart writes persist trust as confidence, and a promoted
      // row must not keep its stale borderline value.
      ...(typeof confidence === "number" && Number.isFinite(confidence)
        ? { confidence: Math.min(1, Math.max(0, confidence)) }
        : {}),
      structuredAttributes: {
        ...(memory.frontmatter.structuredAttributes ?? {}),
        ...attributeUpdates,
      },
    });
  }

  /**
   * Demote a pending_review wearable memory to rejected when a re-pass
   * produced an explicit judge-reject verdict, merging the evidence.
   * Returns false when the memory is missing or no longer
   * pending_review — active rows are NEVER auto-demoted (operator
   * approvals and accrued recall signals win; contradiction scans and
   * supersession own active-row retirement).
   */
  async demoteWearableMemory(id: string, attributeUpdates: Record<string, string>): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((entry) => entry.frontmatter.id === id);
    if (!memory) return false;
    if (memory.frontmatter.status !== "pending_review") return false;
    return this.writeMemoryFrontmatter(memory, {
      status: "rejected",
      structuredAttributes: {
        ...(memory.frontmatter.structuredAttributes ?? {}),
        ...attributeUpdates,
      },
    });
  }

  private get factsDir(): string {
    return path.join(this.baseDir, "facts");
  }
  private get correctionsDir(): string {
    return path.join(this.baseDir, "corrections");
  }
  private get proceduresDir(): string {
    return path.join(this.baseDir, "procedures");
  }
  private get reasoningTracesDir(): string {
    return path.join(this.baseDir, "reasoning-traces");
  }
  private get entitiesDir(): string {
    return path.join(this.baseDir, "entities");
  }
  private resolveEntityFilePath(name: string): string | null {
    if (typeof name !== "string") return null;
    const filePath = path.resolve(this.entitiesDir, `${name}.md`);
    const relative = path.relative(this.entitiesDir, filePath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return filePath;
  }
  private readStorageSecureFile(filePath: string): Promise<string> {
    return readMaybeEncryptedFile(filePath, this._secureStoreKey, this.baseDir);
  }
  protected writeStorageSecureFile(filePath: string, content: string | Buffer, forceEncrypt = false): Promise<void> {
    const writeKey = this.resolveWriteKey(forceEncrypt);
    return writeMaybeEncryptedFile(filePath, content, writeKey, {}, this.baseDir).then(() => {
      // No manual sniff-cache update needed (issue #1909 round 10): this rewrite
      // changes the file's (size, mtime), so isEncryptedFileHeader re-sniffs on
      // the next append when its identity check misses. Identity validation also
      // covers PEER rewrites that this hook never sees.
      this.notifyCatalogWriteForPath(filePath);
    });
  }

  protected assertManagedStoragePath(filePath: string, method: string): string {
    const resolved = path.resolve(filePath);
    const base = path.resolve(this.baseDir);
    const rel = path.relative(base, resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`${method}: file path escapes memory dir`);
    }
    return resolved;
  }

  private parseDeletionRevisionMetadata(raw: string): Map<string, number> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Deletion revision metadata is invalid.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Deletion revision metadata is invalid.");
    }
    const root = parsed as Record<string, unknown>;
    if (
      Object.keys(root).sort().join(",") !== "deletions,version" ||
      root.version !== 1 ||
      !Array.isArray(root.deletions)
    ) {
      throw new Error("Deletion revision metadata is invalid.");
    }
    const revisions = new Map<string, number>();
    const pathByIdentity = new Map<string, string>();
    for (const rawEntry of root.deletions) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new Error("Deletion revision metadata is invalid.");
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        Object.keys(entry).sort().join(",") !== "mtimeMs,path" ||
        !isValidDeletionRevisionPath(entry.path) ||
        typeof entry.mtimeMs !== "number" ||
        !Number.isFinite(entry.mtimeMs) ||
        entry.mtimeMs < 0 ||
        entry.mtimeMs > DELETION_REVISION_MAX_MTIME_MS ||
        revisions.has(entry.path)
      ) {
        throw new Error("Deletion revision metadata is invalid.");
      }
      const identity = deletionRevisionPathIdentity(entry.path);
      if (pathByIdentity.has(identity)) {
        throw new Error("Deletion revision metadata is invalid.");
      }
      pathByIdentity.set(identity, entry.path);
      revisions.set(entry.path, entry.mtimeMs);
    }
    return new Map([...revisions.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  }

  private async readDeletionRevisionMetadata(): Promise<Map<string, number>> {
    let raw: string;
    try {
      raw = await readFile(this.deletionRevisionMetadataPath, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return new Map();
      throw new Error("Deletion revision metadata is unavailable.");
    }
    return this.parseDeletionRevisionMetadata(raw);
  }

  private async writeDeletionRevisionMetadata(
    revisions: ReadonlyMap<string, number>,
    lock: HeldFileLockController
  ): Promise<void> {
    const deletions = [...revisions.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([entryPath, mtimeMs]) => ({ path: entryPath, mtimeMs }));
    const metadata: DeletionRevisionMetadata = { version: 1, deletions };
    const temporaryPath = `${this.deletionRevisionMetadataPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (!(await lock.refresh())) {
        throw new Error("Deletion revision metadata lock was lost.");
      }
      await rename(temporaryPath, this.deletionRevisionMetadataPath);
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isErrnoCode(error, "ENOENT")) throw error;
      });
    }
  }

  private async withDeletionRevisionLock<T>(task: (lock: HeldFileLockController) => Promise<T>): Promise<T> {
    return withHeldFileLock(
      this.deletionRevisionLockPath,
      {
        staleMs: DELETION_REVISION_LOCK_STALE_MS,
        maxWaitMs: DELETION_REVISION_LOCK_MAX_WAIT_MS,
      },
      async (acquired, lock) => {
        if (!acquired) throw new Error("Deletion revision metadata lock is unavailable.");
        return task(lock);
      }
    );
  }

  async readDeletionRevisions(): Promise<ReadonlyMap<string, number>> {
    return this.withDeletionRevisionLock(async () => this.readDeletionRevisionMetadata());
  }

  async recordReplicatedDeletionRevision(filePath: string, mtimeMs: number): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.recordReplicatedDeletionRevision");
    if (
      typeof mtimeMs !== "number" ||
      !Number.isFinite(mtimeMs) ||
      mtimeMs < 0 ||
      mtimeMs > DELETION_REVISION_MAX_MTIME_MS
    ) {
      throw new Error("Deletion revision timestamp is invalid.");
    }
    const relativePath = path.relative(this.baseDir, target).split(path.sep).join("/");
    if (!isValidDeletionRevisionPath(relativePath)) {
      throw new Error("Deletion revision path is invalid.");
    }
    await this.withDeletionRevisionLock(async (lock) => {
      const revisions = await this.readDeletionRevisionMetadata();
      const identity = deletionRevisionPathIdentity(relativePath);
      let existingPath: string | undefined;
      for (const candidatePath of revisions.keys()) {
        if (deletionRevisionPathIdentity(candidatePath) === identity) {
          existingPath = candidatePath;
          break;
        }
      }
      const existingMtimeMs = existingPath === undefined ? undefined : revisions.get(existingPath);
      if (existingMtimeMs !== undefined && existingMtimeMs >= mtimeMs) return;

      const updated = new Map(revisions);
      if (existingPath !== undefined) updated.delete(existingPath);
      updated.set(relativePath, mtimeMs);
      await this.writeDeletionRevisionMetadata(updated, lock);
    });
  }

  protected async writeManagedStorageFile(filePath: string, write: () => Promise<void>): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.writeManagedStorageFile");
    const relativePath = path.relative(this.baseDir, target).split(path.sep).join("/");
    if (!isValidDeletionRevisionPath(relativePath)) {
      throw new Error("Deletion revision path is invalid.");
    }
    await this.withDeletionRevisionLock(async (lock) => {
      const before = await this.readDeletionRevisionMetadata();
      const identity = deletionRevisionPathIdentity(relativePath);
      const existingPath = [...before.keys()].find(
        (candidatePath) => deletionRevisionPathIdentity(candidatePath) === identity
      );
      await write();
      if (existingPath === undefined) return;
      const updated = new Map(before);
      updated.delete(existingPath);
      await this.writeDeletionRevisionMetadata(updated, lock);
    });
  }

  protected async deleteManagedStorageFile(filePath: string, deletionMtimeMs?: number | null): Promise<boolean> {
    const target = this.assertManagedStoragePath(filePath, "storage.deleteManagedStorageFile");
    if (
      deletionMtimeMs !== undefined &&
      deletionMtimeMs !== null &&
      (typeof deletionMtimeMs !== "number" ||
        !Number.isFinite(deletionMtimeMs) ||
        deletionMtimeMs < 0 ||
        deletionMtimeMs > DELETION_REVISION_MAX_MTIME_MS)
    ) {
      throw new Error("Deletion revision timestamp is invalid.");
    }
    return this.withDeletionRevisionLock(async (lock) => {
      try {
        await lstat(target);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return false;
        throw error;
      }
      const relativePath = path.relative(this.baseDir, target).split(path.sep).join("/");
      if (!isValidDeletionRevisionPath(relativePath)) {
        throw new Error("Deletion revision path is invalid.");
      }
      const revision = deletionMtimeMs === null ? undefined : (deletionMtimeMs ?? Date.now());
      const before = await this.readDeletionRevisionMetadata();
      const identity = deletionRevisionPathIdentity(relativePath);
      let existingPath: string | undefined;
      for (const candidatePath of before.keys()) {
        if (deletionRevisionPathIdentity(candidatePath) === identity) {
          existingPath = candidatePath;
          break;
        }
      }
      const existing = existingPath === undefined ? undefined : before.get(existingPath);
      const changed =
        (existingPath !== undefined && existingPath !== relativePath) ||
        (revision === undefined ? existing !== undefined : existing !== revision);
      if (changed) {
        const updated = new Map(before);
        if (existingPath !== undefined) updated.delete(existingPath);
        if (revision !== undefined) updated.set(relativePath, revision);
        await this.writeDeletionRevisionMetadata(updated, lock);
      }
      try {
        await unlink(target);
        return true;
      } catch (error) {
        if (changed) await this.writeDeletionRevisionMetadata(before, lock);
        if (isErrnoCode(error, "ENOENT")) return false;
        throw error;
      }
    });
  }

  async readOfflineSyncFile(filePath: string): Promise<Buffer> {
    const target = this.assertManagedStoragePath(filePath, "storage.readOfflineSyncFile");
    return readMaybeEncryptedFileBuffer(target, this._secureStoreKey, this.baseDir);
  }

  async digestOfflineSyncFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
    const target = this.assertManagedStoragePath(filePath, "storage.digestOfflineSyncFile");
    const st = await stat(target);
    const relPath = path.relative(this.baseDir, target).split(path.sep).join("/");
    const cache = await this.loadOfflineSyncDigestCache();
    const cached = cache.get(relPath);
    if (
      cached &&
      cached.statBytes === st.size &&
      cached.mtimeMs === st.mtimeMs &&
      cached.ctimeMs === st.ctimeMs &&
      !cached.encrypted
    ) {
      return {
        sha256: cached.sha256,
        bytes: cached.bytes,
      };
    }

    const encrypted = await this.offlineSyncFileIsEncrypted(target);
    let digest: { sha256: string; bytes: number };
    if (encrypted) {
      const content = await readMaybeEncryptedFileBuffer(target, this._secureStoreKey, this.baseDir);
      digest = {
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
      };
    } else {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const rawChunk of createReadStream(target)) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        hash.update(chunk);
        bytes += chunk.length;
      }
      digest = {
        sha256: hash.digest("hex"),
        bytes,
      };
    }
    if (!encrypted) {
      this.rememberOfflineSyncDigest(relPath, st, digest);
    }
    return digest;
  }

  private async loadOfflineSyncDigestCache(): Promise<Map<string, OfflineSyncDigestCacheEntry>> {
    if (this.offlineSyncDigestCache) return this.offlineSyncDigestCache;
    if (!this.offlineSyncDigestCacheLoadPromise) {
      this.offlineSyncDigestCacheLoadPromise = this.readOfflineSyncDigestCache();
    }
    this.offlineSyncDigestCache = await this.offlineSyncDigestCacheLoadPromise;
    return this.offlineSyncDigestCache;
  }

  private async readOfflineSyncDigestCache(): Promise<Map<string, OfflineSyncDigestCacheEntry>> {
    const cache = new Map<string, OfflineSyncDigestCacheEntry>();
    try {
      const raw = await readFile(this.offlineSyncDigestCachePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return cache;
      const entries = (parsed as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) return cache;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        const cachePath = typeof record.path === "string" ? record.path : "";
        const statBytes = typeof record.statBytes === "number" ? record.statBytes : NaN;
        const mtimeMs = typeof record.mtimeMs === "number" ? record.mtimeMs : NaN;
        const ctimeMs = typeof record.ctimeMs === "number" ? record.ctimeMs : NaN;
        const bytes = typeof record.bytes === "number" ? record.bytes : NaN;
        const sha256 = typeof record.sha256 === "string" ? record.sha256 : "";
        const encrypted = record.encrypted === true;
        if (
          cachePath.length === 0 ||
          cachePath === ".." ||
          cachePath.startsWith("../") ||
          path.isAbsolute(cachePath) ||
          !Number.isFinite(statBytes) ||
          !Number.isFinite(mtimeMs) ||
          !Number.isFinite(ctimeMs) ||
          !Number.isFinite(bytes) ||
          !/^[a-f0-9]{64}$/i.test(sha256)
        ) {
          continue;
        }
        cache.set(cachePath, { statBytes, mtimeMs, ctimeMs, encrypted, sha256, bytes });
      }
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) {
        log.warn(
          `storage.offlineSyncDigestCache: ignoring unreadable cache: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return cache;
  }

  private rememberOfflineSyncDigest(
    relPath: string,
    st: { size: number; mtimeMs: number; ctimeMs: number },
    digest: { sha256: string; bytes: number }
  ): void {
    const cache = this.offlineSyncDigestCache;
    if (!cache) return;
    cache.set(relPath, {
      statBytes: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      encrypted: false,
      sha256: digest.sha256,
      bytes: digest.bytes,
    });
    this.scheduleOfflineSyncDigestCacheWrite();
  }

  private scheduleOfflineSyncDigestCacheWrite(): void {
    if (this.offlineSyncDigestCacheWriteTimer) {
      clearTimeout(this.offlineSyncDigestCacheWriteTimer);
    }
    this.offlineSyncDigestCacheWriteTimer = setTimeout(() => {
      this.offlineSyncDigestCacheWriteTimer = null;
      this.queueOfflineSyncDigestCacheWrite();
    }, 1_000);
    this.offlineSyncDigestCacheWriteTimer.unref?.();
  }

  private queueOfflineSyncDigestCacheWrite(): void {
    this.offlineSyncDigestCacheWriteChain = this.offlineSyncDigestCacheWriteChain
      .catch(() => undefined)
      .then(async () => {
        const cache = this.offlineSyncDigestCache;
        if (!cache) return;
        const entries = [...cache.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([entryPath, entry]) => ({ path: entryPath, ...entry }));
        await mkdir(path.dirname(this.offlineSyncDigestCachePath), { recursive: true });
        await writeFile(this.offlineSyncDigestCachePath, `${JSON.stringify({ version: 1, entries })}\n`, "utf-8");
      })
      .catch((err) => {
        log.warn(
          `storage.offlineSyncDigestCache: failed to write cache: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  private async offlineSyncFileIsEncrypted(filePath: string): Promise<boolean> {
    const handle = await open(filePath, "r");
    try {
      const header = Buffer.alloc(MAGIC_HEADER_SIZE);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead >= MAGIC_HEADER_SIZE && isEncryptedFile(header);
    } finally {
      await handle.close();
    }
  }

  async writeOfflineSyncStagingFile(filePath: string, content: Buffer): Promise<void> {
    const target = this.assertManagedStoragePath(filePath, "storage.writeOfflineSyncStagingFile");
    await this.writeStorageSecureFile(target, content);
  }

  createContentHashIndex(): ContentHashIndex {
    return new ContentHashIndex(
      this.stateDir,
      () => this._secureStoreKey,
      () => this.resolveWriteKey(),
      this.baseDir,
      this.factHashIndexLockOptions
    );
  }

  private async appendStorageSecureFile(filePath: string, content: string): Promise<void> {
    const previous = this.secureAppendChains.get(filePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.appendStorageSecureFileUnlocked(filePath, content));
    const next = current.catch(() => undefined);
    this.secureAppendChains.set(filePath, next);
    try {
      await current;
    } finally {
      if (this.secureAppendChains.get(filePath) === next) {
        this.secureAppendChains.delete(filePath);
      }
    }
  }

  /**
   * Classify a file as encrypted by reading ONLY the fixed-size magic header
   * (issue #1909), never the whole file. The result is cached per-path but
   * VALIDATED against the file's (size, mtime) identity (review round 10 finding
   * 1): a `stat` on each call is O(1), and the 12-byte header read happens only
   * on a cache miss or when the on-disk identity changed — so a PEER process
   * rewriting/encrypting the file is detected and we never append raw bytes into
   * an encrypted body. ENOENT and short/empty files classify as not-encrypted
   * (fall through to a plain `appendFile`).
   */
  private async isEncryptedFileHeader(filePath: string): Promise<boolean> {
    let st;
    try {
      st = await stat(filePath);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return false;
      throw err;
    }
    const cached = this.secureFileEncryptionSniffCache.get(filePath);
    if (cached && cached.identity.size === st.size && cached.identity.mtimeMs === st.mtimeMs) {
      return cached.encrypted;
    }
    let handle;
    try {
      handle = await open(filePath, "r");
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return false;
      throw err;
    }
    try {
      const header = Buffer.alloc(MAGIC_HEADER_SIZE);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const encrypted = isEncryptedFile(header.subarray(0, bytesRead));
      this.secureFileEncryptionSniffCache.set(filePath, {
        identity: { size: st.size, mtimeMs: st.mtimeMs },
        encrypted,
      });
      return encrypted;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async appendStorageSecureFileUnlocked(filePath: string, content: string): Promise<void> {
    const writeKey = this.resolveWriteKey();
    await mkdir(path.dirname(filePath), { recursive: true });
    if (writeKey === null) {
      try {
        // Header-only sniff (issue #1909): reads at most MAGIC_HEADER_SIZE bytes
        // instead of the whole target file (a lifecycle ledger can grow to
        // hundreds of MB on a large corpus) to decide "is this encrypted?". A
        // plaintext append below cannot flip the classification, so a cached
        // `false` stays valid across appends.
        if (await this.isEncryptedFileHeader(filePath)) {
          const existing = await this.readStorageSecureFile(filePath);
          await writeMaybeEncryptedFile(filePath, `${existing}${content}`, null, {}, this.baseDir);
          this.notifyCatalogWriteForPath(filePath);
          return;
        }
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) throw err;
      }
      // Plaintext append does not touch the header. isEncryptedFileHeader is now
      // (size, mtime)-identity-validated (issue #1909 round 10), so a PEER
      // process that encrypted this file since our last sniff is detected on the
      // stat above and re-sniffed — we will NOT append raw bytes into an
      // encrypted body. A residual sub-call TOCTOU (a peer encrypts between this
      // stat and the appendFile below) is inherent to any check-then-act and is
      // out of scope; the identity check closes the long-lived stale-cache hole.
      await appendFile(filePath, content, "utf-8");
      this.notifyCatalogWriteForPath(filePath);
      return;
    }

    // Encrypted-store branch (issue #1909, known limitation): the sealed format
    // has no append primitive, so this inherently decrypts + concatenates +
    // rewrites the whole file. Only the plaintext-path sniff read was wasteful.
    let existing = "";
    try {
      existing = await this.readStorageSecureFile(filePath);
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
    }
    await writeMaybeEncryptedFile(filePath, `${existing}${content}`, writeKey, {}, this.baseDir);
    this.notifyCatalogWriteForPath(filePath);
  }
  private get stateDir(): string {
    return path.join(this.baseDir, "state");
  }
  private get offlineSyncDigestCachePath(): string {
    return path.join(this.baseDir, ".offline-sync", "digest-cache.v1.json");
  }
  private get deletionRevisionMetadataPath(): string {
    return path.join(this.baseDir, ".offline-sync", "deletion-revisions.v1.json");
  }
  private get deletionRevisionLockPath(): string {
    return `${this.deletionRevisionMetadataPath}.lock`;
  }
  private get entitySynthesisQueuePath(): string {
    return path.join(this.stateDir, "entity-synthesis-queue.json");
  }
  // ── Tombstone store access (issue #1579) ─────────────────────────────────
  /**
   * The on-disk tombstone log path. Lives under `<stateDir>/tombstones.jsonl`
   * so it is co-located with the fact-hash index and encrypted at rest when
   * the secure-store is enabled (the StorageManager's secure read/write
   * helpers are injected into the store).
   */
  private get tombstonesPath(): string {
    return path.join(this.stateDir, "tombstones.jsonl");
  }

  /**
   * Configure the tombstone invariant for this storage instance. Installed
   * by the orchestrator after construction (same pattern as
   * `setVersioningConfig` / `citationTemplate`). When `enabled` is false
   * (default until the orchestrator wires config), the chokepoint check is a
   * no-op — pre-feature behavior for rollback safety (rule 30).
   */
  setTombstonesConfig(config: {
    enabled: boolean;
    semanticMatch: boolean;
    semanticThreshold: number;
    namespace: string;
  }): void {
    this.tombstonesConfig = { ...config };
    // Reset the store so the next access rebuilds with the new options.
    if (this.tombstoneStore) {
      this.tombstoneStore.invalidate();
      this.tombstoneStore = null;
      this.tombstoneStoreLoadPromise = null;
    }
  }

  private buildTombstoneStore(): TombstoneStore {
    const options: TombstoneStoreOptions = {
      enabled: this.tombstonesConfig.enabled,
      semanticMatch: this.tombstonesConfig.semanticMatch,
      semanticThreshold: this.tombstonesConfig.semanticThreshold,
      // Wire the SAME helpers the dedup index uses (rule 23 / checklist §13):
      // hashContent = ContentHashIndex.computeHash, normalizeText =
      // ContentHashIndex.normalizeContent. Importing them here (not copying)
      // guarantees the tombstone tiers can never drift from dedup.
      hashContent: ContentHashIndex.computeHash,
      normalizeText: ContentHashIndex.normalizeContent,
    };
    const io: TombstoneFileIo = {
      read: (filePath) => this.readStorageSecureFile(filePath),
      append: (filePath, content) => this.appendStorageSecureFile(filePath, content),
      write: (filePath, content) => this.writeStorageSecureFile(filePath, content),
      // stat lets the store own its cross-process staleness probe (#1579).
      stat: (filePath) => statSync(filePath),
    };
    return new TombstoneStore(this.tombstonesPath, this.tombstonesConfig.namespace, options, io);
  }

  /**
   * Lazily load the tombstone store. Mirrors the fact-hash-index lazy-load
   * pattern: a single in-flight load promise dedups concurrent first-access.
   * The cross-process staleness probe lives inside the store now (#1579): on
   * each cached access it stats its own file and invalidates if a peer process
   * appended, so the next lookup reloads from disk. If the probe just
   * invalidated the store, fall through to the reload branch — returning null
   * here was the original regression (the chokepoint threw and failed OPEN).
   */
  getTombstoneStore(): Promise<TombstoneStore> {
    if (this.tombstoneStore) {
      // The store owns the staleness probe + reload (#1579): on a cached hit it
      // stats its own file and, if a peer process appended, invalidates + reloads
      // in place. We await it so the chokepoint's lookup always sees a fresh index.
      const cached = this.tombstoneStore;
      return cached.ensureFreshAgainstDisk().then(() => cached);
    }
    if (!this.tombstoneStoreLoadPromise) {
      const store = this.buildTombstoneStore();
      this.tombstoneStoreLoadPromise = store
        .load()
        .then(() => {
          this.tombstoneStore = store;
          return store;
        })
        .catch((err) => {
          this.tombstoneStoreLoadPromise = null;
          throw err;
        });
    }
    return this.tombstoneStoreLoadPromise;
  }

  /**
   * Whether tombstones are enabled on this storage. Callers that need to
   * distinguish "tombstones disabled" (null return is expected) from
   * "persistence failed" (appendTombstone swallows store errors and also
   * returns null) use this to fail closed when enabled (#1580 review OgIqp).
   */
  isTombstonesEnabled(): boolean {
    return this.tombstonesConfig.enabled;
  }

  /**
   * Append a tombstone for a retired memory (issue #1579 emitters).
   * Best-effort: a tombstone append failure MUST NOT fail the supersession /
   * correction that triggered it (gotcha #13 / rule 34). The memory is
   * already retired on disk; the tombstone is the non-resurrection guard.
   */
  async appendTombstone(input: {
    reason: TombstoneReason;
    createdBy: TombstoneCreatedBy;
    sourceMemoryId: string;
    rawContent: string;
    entityRef?: string;
    supersessionKey?: string;
    createdAt?: string;
    /** Canonical contentHash from the retired memory's frontmatter (#1579). */
    contentHash?: string;
  }): Promise<string | null> {
    if (!this.tombstonesConfig.enabled) return null;
    try {
      const store = await this.getTombstoneStore();
      // Chokepoint citation strip (#1579 review): both the exact-tier hash
      // and the normalized-text tier must match re-extraction, which hashes
      // the citation-stripped contentHashSource. Idempotent on pre-stripped
      // text (e.g. recordSupersession).
      const strippedRawContent = stripCitationForTemplate(input.rawContent, this.citationTemplate);
      // Canonicalization + post-append recheck (#2213) live in the helper.
      return await entityRefs.appendCanonicalizedTombstone(
        this.stateDir,
        input,
        () => this.currentHistoricalIds(),
        (identity) => store.appendTombstone({ ...input, rawContent: strippedRawContent, ...identity }),
        (tombstoneId) => store.revoke(tombstoneId, input.createdBy),
        input.sourceMemoryId
      );
    } catch (err) {
      log.warn(`tombstone append failed (memory=${input.sourceMemoryId}): ${err}`);
      return null;
    }
  }

  /**
   * Revoke a tombstone (re-allow the content). Used by the review-queue
   * approval path when an operator approves a blocked memory.
   */
  async revokeTombstone(tombstoneId: string, createdBy: TombstoneCreatedBy): Promise<string | null> {
    if (!this.tombstonesConfig.enabled) return null;
    try {
      const store = await this.getTombstoneStore();
      return await store.revoke(tombstoneId, createdBy);
    } catch (err) {
      log.warn(`tombstone revoke failed (id=${tombstoneId}): ${err}`);
      return null;
    }
  }

  /** Aggregate tombstone stats for `remnic doctor`. */
  async getTombstoneStats(): Promise<TombstoneStats | null> {
    if (!this.tombstonesConfig.enabled) return null;
    try {
      const store = await this.getTombstoneStore();
      return store.stats();
    } catch (err) {
      log.warn(`tombstone stats failed: ${err}`);
      return null;
    }
  }

  /**
   * Rebuild the tombstone log from retired memories on disk. Exposed for
   * `remnic doctor --rebuild-tombstones` and tests.
   */
  async rebuildTombstonesFromFiles(): Promise<number> {
    if (!this.tombstonesConfig.enabled) return 0;
    const store = await this.getTombstoneStore();
    const all = [...(await this.readAllMemories()), ...(await this.readAllColdMemories())];
    // Pure projection (lifecycle/tombstones.ts) keeps this method thin (#1520).
    const retired = collectRetiredMemoriesForRebuild(all, {
      stripCitation: (text) => stripCitationForTemplate(text, this.citationTemplate),
      supersessionKeysForFact,
    });
    return await store.rebuild(retired);
  }
  protected markFactHashIndexNotAuthoritative(): void {
    this.factHashIndexAuthoritative = false;
  }
  protected tombstoneBlockedCaptureIndexOptions(): TombstoneBlockedCaptureIndexOptions {
    return {
      stateDir: this.stateDir,
      memoryDir: this.baseDir,
      secureStoreKeyProvider: () => this._secureStoreKey,
      secureStoreWriteKeyProvider: () => this.resolveWriteKey(),
      lockOptions: () => this.factHashIndexLockOptions,
      parseMemory: (filePath, content) =>
        parseTombstoneBlockedOfflineSyncMemory(
          filePath,
          content,
          this.baseDir,
          parseFrontmatter,
          normalizeFrontmatterForPath,
          toMemoryPathRel
        ),
      readAllMemories: () => this.readAllMemories(),
      readAllColdMemories: () => this.readAllColdMemories(),
    };
  }
  private async getFactHashIndex(): Promise<ContentHashIndex> {
    if (this.factHashIndex) {
      return this.factHashIndex;
    }
    if (!this.factHashIndexLoadPromise) {
      const index = this.createContentHashIndex();
      this.factHashIndexLoadPromise = index
        .load()
        .then(() => {
          this.factHashIndex = index;
          return index;
        })
        .catch((err) => {
          this.factHashIndexLoadPromise = null;
          throw err;
        });
    }
    return this.factHashIndexLoadPromise;
  }
  /**
   * Return the fact-hash index after ensuring it is authoritative — i.e. rebuilt
   * from the durable fact corpus (issue #1909 review round 12). This is the ONE
   * coherent dedup source: the orchestrator's dedup layer
   * (contentHashIndexForStorage) shares THIS instance instead of loading a raw,
   * possibly-stale fact-hashes.txt, so after a crash+restart the orchestrator's
   * hasContentHashDedup sees the same corpus-rebuilt hashes StorageManager does
   * and never re-creates a fact whose per-write flush was deferred and lost.
   */
  async getAuthoritativeFactHashIndex(): Promise<ContentHashIndex> {
    if (!(await this.ensureFactHashIndexAuthoritative())) {
      throw new FactHashIndexNotAuthoritativeError(this.stateDir);
    }
    return this.getFactHashIndex();
  }
  /**
   * Return the shared fact-hash index instance, corpus-rebuilt under the lock
   * when the lock is free. Unlike {@link getAuthoritativeFactHashIndex} this
   * NEVER throws on lock contention — it returns the shared instance (the loaded
   * snapshot when a locked rebuild could not run) so registration writes still
   * land in the one shared index and reconcile to disk. Callers that trust a
   * dedup MISS MUST also consult {@link isFactContentHashAuthoritative} and
   * confirm against the corpus when it is false (PR #2016).
   */
  async getSharedFactHashIndex(): Promise<ContentHashIndex> {
    await this.ensureFactHashIndexAuthoritative();
    return this.getFactHashIndex();
  }
  private async ensureFactHashIndexAuthoritative(): Promise<boolean> {
    if (this.factHashIndexAuthoritative === true) {
      // PR #2016 review: authority is NOT permanent. A peer process can advance
      // the durable fact-hash index after our rebuild, leaving our in-memory
      // snapshot stale but still flagged authoritative — so a dedup MISS is
      // wrongly trusted and a duplicate active memory is written. Gate the fast
      // path on a cheap one-stat freshness check: when the durable index file is
      // unchanged since our last sync we stay authoritative (hot path preserved);
      // when a peer advanced it (or freshness cannot be established) drop
      // authority and rebuild from the corpus below so the miss confirms against
      // ground truth.
      if (this.factHashIndex && (await this.factHashIndex.isDiskFingerprintCurrent())) {
        return true;
      }
      this.factHashIndexAuthoritative = null;
    }
    if (this.factHashIndexAuthoritativePromise) {
      return this.factHashIndexAuthoritativePromise;
    }
    this.factHashIndexAuthoritative = false;
    this.factHashIndexAuthoritativePromise = (async () => {
      // Round 11: ALWAYS rebuild the fact-hash index from the durable corpus on
      // first use per process — no on-disk "ready" marker is written or trusted,
      // so a deferred write, crash, or multi-process interleave can never leave a
      // stale index trusted. The scan AND publish run under the SAME per-index
      // cross-process lock the reconciling saves use (rebuildUnderLock), so the
      // rebuild can never overwrite a peer's newer lock-merged or deferred
      // additions with an unlocked overwrite.
      //
      // PR #2016 (findings 1-2): bounded-retry the LOCKED rebuild so transient
      // contention (a peer mid reconcile-save) clears within a short budget
      // instead of surrendering authority on the first miss. Each attempt uses
      // the same non-reentrant, bounded-wait file lock, so it can never deadlock
      // with a deferred reconcile-retry. On exhaustion the index is left
      // non-authoritative: getAuthoritativeFactHashIndex() fails explicitly and
      // hasFactContentHash()/isFactContentHashAuthoritative() fall back to the
      // durable corpus so a stale loaded snapshot never answers as current.
      const factHashIndex = await this.getFactHashIndex();
      const maxAttempts = this.factHashIndexLockOptions.retryMaxAttempts ?? FACT_HASH_INDEX_REBUILD_MAX_ATTEMPTS;
      const baseMs = this.factHashIndexLockOptions.retryBaseMs ?? FACT_HASH_INDEX_REBUILD_RETRY_BASE_MS;
      let published = false;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        published = await factHashIndex.rebuildUnderLock(() => this.rebuildFactHashIndexFromCorpus(factHashIndex));
        if (published || attempt === maxAttempts - 1) break;
        const wait = Math.min(baseMs * 2 ** attempt, CONTENT_HASH_INDEX_RETRY_MAX_DELAY_MS);
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
      this.factHashIndexAuthoritative = published;
      if (!published) {
        log.warn(
          `ensureFactHashIndexAuthoritative: fact-hash index lock unavailable after ${maxAttempts} attempt(s); ` +
            `index left non-authoritative (reads verify against the durable corpus; next use retries the locked rebuild)`
        );
      }
      return published;
    })().finally(() => {
      this.factHashIndexAuthoritativePromise = null;
    });
    return this.factHashIndexAuthoritativePromise;
  }
  /**
   * Repopulate `factHashIndex` in memory from the durable HOT+COLD corpus. Runs
   * WHILE the per-index cross-process lock is held (see
   * ContentHashIndex.rebuildUnderLock, which publishes the rebuilt set); this
   * method itself never writes to disk.
   */
  private async rebuildFactHashIndexFromCorpus(factHashIndex: ContentHashIndex): Promise<void> {
    factHashIndex.clear();
    // Fact-ONLY membership rebuilt in lockstep (PR #2016): hasFactContentHash
    // reads THIS set, never the category-agnostic shared index below, so an
    // over-included non-fact body can never satisfy a fact-hash check. Repopulate
    // the LIVE set in place (clear + add) rather than building a fresh set and
    // reassigning: a concurrent in-process writeMemory that adds a fact hash
    // during the corpus-read awaits below would be lost by a publish-time
    // reassignment (PR #2016 thread SDzOT), exactly as the shared index avoids
    // by mutating its `hashes` set in place.
    this.factOnlyHashes.clear();
    // #1909 review round 14: index the HOT and COLD tiers together. A fact or
    // procedure demoted to cold/ is still active and its content-hash must
    // survive the corpus rebuild, or a restart would drop the hash and let the
    // next extraction re-create the demoted memory. Matches the hot+cold union
    // that removeFactContentHashesForMemories already reconciles against.
    const existing = [...(await this.readAllMemories()), ...(await this.readAllColdMemories())];
    let legacyRecovered = 0;
    for (const memory of existing) {
      // #1909 review round 15 (PR #2016): the content-hash dedup index is
      // SHARED across EVERY registered write category. persistExtraction calls
      // addContentHashDedup for every writeCategory it persists — fact,
      // procedure, preference, decision, commitment, correction, and any other
      // extracted category — into THIS one index. A rebuild restricted to
      // fact+procedure dropped every other category's hash on restart, so the
      // next extraction re-created identical active preference/decision/
      // commitment memories (the retired fact-hashes.txt load used to preserve
      // them). Index every active memory regardless of category so the corpus
      // rebuild covers the full registration surface. Over-inclusion is safe:
      // the dedup consumers (hasContentHashDedup in persistExtraction, the
      // explicit-capture negative pre-filter) confirm a hash hit with a
      // same-category corpus scan before dropping anything, so a surplus hash
      // only costs a scan — it can never wrongly suppress a write. Procedures
      // keep their round-13 behaviour: they carry no frontmatter contentHash
      // (writeMemory sets it only for facts), so they fall through to the
      // citation-strip reconstruction below, hashing the stored persist body
      // (title + steps) exactly as buildProcedurePersistBody registered it.
      if (inferMemoryStatus(memory.frontmatter, memory.path) !== "active") continue;
      const hash = this.corpusRegisteredHash(memory);
      if (hash === null) {
        // Body carries a citation from an unknown/custom template we cannot
        // safely strip — skip rather than register a wrong hash. A
        // false-negative miss beats a wrong entry that would permanently
        // suppress legitimate duplicate writes (see corpusRegisteredHash).
        legacyRecovered++;
        continue;
      }
      factHashIndex.addByHash(hash);
      if (memory.frontmatter.category === "fact") this.factOnlyHashes.add(hash);
    }
    if (legacyRecovered > 0) {
      log.info(
        `ensureFactHashIndexAuthoritative: skipped ${legacyRecovered} legacy memory(ies) with no contentHash in frontmatter`
      );
    }
  }
  /**
   * The content-hash the corpus rebuild registers for `memory`, or null when the
   * body carries a citation from an unknown/custom template that cannot be
   * safely stripped. Shared by the authoritative rebuild and the fact-only
   * corpus confirmation (`hasFactContentHash`) so both derive the identical
   * hash for a given stored body.
   *
   * Preference order:
   *  1. frontmatter.contentHash — the raw pre-citation hash writeMemory records
   *     for facts (issue #369 round 8); matches hasFactContentHash(rawFact).
   *  2. Reconstruct from the stored body: strip the "[Attributes: …]" suffix
   *     writeMemory appends for structuredAttributes (registration hashed the
   *     raw canonical content WITHOUT it — a no-op when absent), then strip a
   *     recognised citation and hash the bare body, or hash a citation-free
   *     body as-is.
   *  3. A body with a citation from an unknown/custom template → null: a
   *     false-negative miss beats a wrong hash that would permanently suppress
   *     legitimate duplicate writes.
   */
  private corpusRegisteredHash(memory: MemoryFile): string | null {
    if (memory.frontmatter.contentHash) {
      return memory.frontmatter.contentHash;
    }
    const content = stripAttributesSuffix(memory.content);
    const stripped = stripCitationForTemplate(content, this.citationTemplate);
    if (stripped !== content) {
      return ContentHashIndex.computeHash(sanitizeMemoryContent(stripped).text);
    }
    if (!hasCitation(content)) {
      return ContentHashIndex.computeHash(sanitizeMemoryContent(content).text);
    }
    return null;
  }
  private get questionsDir(): string {
    return path.join(this.baseDir, "questions");
  }
  private get artifactsDir(): string {
    return path.join(this.baseDir, "artifacts");
  }
  private get identityDir(): string {
    return path.join(this.baseDir, "identity");
  }
  private get identityAnchorPath(): string {
    return path.join(this.identityDir, "identity-anchor.md");
  }
  private get identityIncidentsDir(): string {
    return path.join(this.identityDir, "incidents");
  }
  private get identityAuditsWeeklyDir(): string {
    return path.join(this.identityDir, "audits", "weekly");
  }
  private get identityAuditsMonthlyDir(): string {
    return path.join(this.identityDir, "audits", "monthly");
  }
  private get identityImprovementLoopsPath(): string {
    return path.join(this.identityDir, "improvement-loops.md");
  }
  private get identityReflectionsPath(): string {
    return path.join(this.identityDir, "reflections.md");
  }
  private get profilePath(): string {
    return path.join(this.baseDir, "profile.md");
  }
  private get memoryActionsPath(): string {
    return path.join(this.stateDir, "memory-actions.jsonl");
  }
  private get memoryLifecycleLedgerPath(): string {
    return path.join(this.stateDir, "memory-lifecycle-ledger.jsonl");
  }
  private get compressionGuidelinesPath(): string {
    return path.join(this.stateDir, "compression-guidelines.md");
  }
  private get compressionGuidelineDraftPath(): string {
    return path.join(this.stateDir, "compression-guidelines.draft.md");
  }
  private get compressionGuidelineStatePath(): string {
    return path.join(this.stateDir, "compression-guideline-state.json");
  }
  private get compressionGuidelineDraftStatePath(): string {
    return path.join(this.stateDir, "compression-guideline-draft-state.json");
  }
  private get behaviorSignalsPath(): string {
    return path.join(this.stateDir, "behavior-signals.jsonl");
  }
  /**
   * In-memory dedup key set for behavior-signals appends (issue #1909),
   * validated by (size, mtime) file identity like the catalog `compactedCache`.
   * Avoids re-reading + JSON.parsing the whole `behavior-signals.jsonl` on
   * every append. A foreign write changes size/mtime, forcing a reload; this
   * process's own appends refresh the identity in place. null => reload.
   */
  private behaviorSignalsKeyCache: { identity: { size: number; mtimeMs: number }; keys: Set<string> } | null = null;
  /**
   * Per-instance serializer for `appendBehaviorSignals` (issue #1909 review
   * round 3). The read→dedup→append→cache-commit transaction must run to
   * completion before the next append starts; otherwise two concurrent callers
   * each snapshot their own `existingKeys`, and the later one commits an
   * INCOMPLETE set under the final file identity, so a subsequent call
   * cache-hits a set missing the earlier batch and writes duplicate signals.
   * The `.catch` links keep the chain alive after a rejected append
   * (AGENTS.md #28).
   */
  private behaviorSignalsAppendChain: Promise<unknown> = Promise.resolve();
  /**
   * Buffer surprise telemetry ledger (issue #563 PR 3).
   *
   * Append-only JSONL of per-turn `BUFFER_SURPRISE` events emitted by
   * `SmartBuffer` when `bufferSurpriseTriggerEnabled` is on. Each row
   * captures the score, the threshold in force at the time, whether the
   * turn caused an extract_now upgrade, and the buffer size. Kept in
   * `state/` alongside the other append-only ledgers so cleanup and
   * governance sweeps can treat it uniformly.
   */
  private get bufferSurpriseLedgerPath(): string {
    return path.join(this.stateDir, "buffer-surprise-ledger.jsonl");
  }

  /**
   * Entity alias table loaded from THIS store's config/aliases.json.
   * Instance-scoped on purpose (issue #1534): multiple StorageManager
   * instances in one process (namespaces, hosted profiles, tenants) must
   * never share alias state — the previous module-level table let whichever
   * store loaded last rewrite every other store's canonical entity ids.
   */
  private userAliases: Record<string, string> = {};
  private readonly historicalEntityCanonicalIds = new entityRefs.HistoricalEntityCanonicalIdCache();
  private currentHistoricalIds(): Readonly<Record<string, string>> {
    return this.historicalEntityCanonicalIds.get(this.stateDir);
  }
  /** Post-persist repair subsystem (issue #2213) — storage/entity-ref-repair.ts. */
  private _entityRefRepair: EntityRefRepair | undefined;
  private get entityRefRepair(): EntityRefRepair {
    if (!this._entityRefRepair) {
      this._entityRefRepair = new EntityRefRepair({
        stateDir: this.stateDir,
        baseDir: this.baseDir,
        currentHistoricalIds: () => this.currentHistoricalIds(),
        serializeFrontmatter,
        writeTombstoneBlockedMemory: (pathname, fileContent, frontmatter, content) =>
          this.writeTombstoneBlockedMemory(pathname, fileContent, frontmatter, content),
        invalidateAllMemoriesCache: () => this.invalidateAllMemoriesCache(),
        getTombstoneStore: () => this.getTombstoneStore(),
        tombstonesEnabled: () => this.tombstonesConfig.enabled,
        tombstonesNamespace: () => this.tombstonesConfig.namespace,
      });
    }
    return this._entityRefRepair;
  }
  private readonly entityCanonicalIdMigration = new EntityCanonicalIdMigrationRunner(
    () => !(this._secureStoreRequired && !this.isSecureStoreUnlocked()),
    () => this.runLegacyEntityCanonicalIdMigration(),
    () => entityMigration.getFingerprint(this.baseDir, this.entitiesDir, () => String(this.getEntityMutationVersion()))
  );
  normalizeEntityName(raw: string, type: string): string {
    return entityRefs.resolveHistoricalEntityCanonicalId(
      this.entityStore.normalizeEntityName(raw, type),
      this.currentHistoricalIds()
    );
  }

  /**
   * Read-only view of this store's user alias table, for call sites that
   * normalize outside the manager (pass it to the free `normalizeEntityName`).
   */
  get entityAliases(): Readonly<Record<string, string>> {
    return this.userAliases;
  }

  /**
   * Reload user-defined entity aliases from config/aliases.json in the memory
   * store. File format: { "variant": "canonical", ... }. The constructor
   * already loads aliases, so this is only needed to pick up file changes
   * (e.g. orchestrator.initialize() re-running on a live instance).
   * Non-object payloads and non-string or empty alias values are ignored.
   */
  async loadAliases(): Promise<void> {
    this.loadAliasesSync();
  }

  private loadAliasesSync(): void {
    const aliasPath = path.join(this.baseDir, "config", "aliases.json");
    this.userAliases = {};
    const raw = readEntityAliasConfigSync(this.baseDir);
    if (raw === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.debug("invalid config/aliases.json — using built-in aliases only");
      return;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const cleaned: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value.trim().length > 0) {
          assertSafeEntityId(value);
          cleaned[key] = value;
        }
      }
      this.userAliases = cleaned;
      log.debug(`loaded ${Object.keys(cleaned).length} entity aliases from ${aliasPath}`);
    } else {
      log.warn(`ignoring ${aliasPath}: payload must be a JSON object mapping variant → canonical strings`);
    }
  }
  private async runLegacyEntityCanonicalIdMigration(): Promise<string | undefined> {
    const completionFingerprint = await runLegacyEntityCanonicalIdMigration(
      this as unknown as EntityCanonicalIdMigrationHost,
      (content) => parseEntityFile(content, this.entitySchemas),
      (entity) => serializeEntityFile(entity, this.entitySchemas),
      createMemoryEntityRefSerializer(serializeFrontmatter)
    );
    return completionFingerprint;
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await entityMigration.validateRoots(this.baseDir, this.entitiesDir, this.stateDir, this.archiveDir);
    const today = new Date().toISOString().slice(0, 10);
    await mkdir(path.join(this.factsDir, today), { recursive: true });
    await mkdir(path.join(this.proceduresDir, today), { recursive: true });
    await mkdir(path.join(this.reasoningTracesDir, today), { recursive: true });
    await mkdir(this.correctionsDir, { recursive: true });
    await mkdir(this.entitiesDir, { recursive: true });
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(this.questionsDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
    await mkdir(this.identityDir, { recursive: true });
    await mkdir(this.identityIncidentsDir, { recursive: true });
    await mkdir(this.identityAuditsWeeklyDir, { recursive: true });
    await mkdir(this.identityAuditsMonthlyDir, { recursive: true });
    await mkdir(path.join(this.baseDir, "config"), { recursive: true });
    await this.entityCanonicalIdMigration.ensure();
    // Activate the corpus sentinel at setup (issue #1902, Cursor Medium): an
    // existing corpus predating this feature has a size-0/absent sentinel, which
    // getCachedMemories treats as a miss — so a read-heavy workload would never
    // engage the hot cache until the first mutation bumped it. The daemon calls
    // ensureDirectories() at startup (orchestration/orchestrator-init.ts) before
    // serving recall reads, so seeding a nonzero version here makes the cache
    // engage from the first read. Fires once, only while the version is still 0.
    // Deliberately NOT done on the readAllMemories() path: a write-side-effect
    // during a read perturbs concurrent hot/cold reads in the tier-migration
    // cycle. Fail-open: a failed bump falls back to the in-process counter.
    if (this.hotMemoriesCacheEnabled && this.getMemoryCorpusVersion() === 0) {
      this.bumpMemoryCorpusVersion();
    }
    await this.entityCanonicalIdMigration.markDirectoriesInitialized();
  }

  /**
   * Resolve the on-disk write path for a memory of the given category, creating
   * the target directory. Category routing goes through the shared
   * `getCategoryDir()` chokepoint (utils/category-dir.ts → CATEGORY_DIR_MAP) so
   * decision/preference/moment/etc. outputs land in their dedicated dirs
   * (`decisions/`, `preferences/`, ...) instead of collapsing into `facts/`
   * (issue #1546; CLAUDE.md rule 39). `correction` keeps its historical flat
   * layout (no `<date>` subdir) as the corrections pipeline expects; every other
   * category — including `fact`/`entity`, which fall back to `facts/` — is dated
   * as `<dir>/<date>/`. Read/scan/reindex already iterate every category dir
   * (RECALL_FALLBACK_DIRS; QMD scans baseDir recursively), so writes stay found.
   */
  private async resolveCategoryWritePath(category: MemoryCategory, id: string, today: string): Promise<string> {
    if (category === "correction") {
      await mkdir(this.correctionsDir, { recursive: true });
      return path.join(this.correctionsDir, `${id}.md`);
    }
    const datedDir = path.join(getCategoryDir(this.baseDir, category), today);
    await mkdir(datedDir, { recursive: true });
    return path.join(datedDir, `${id}.md`);
  }

  private async findExistingTombstoneBlockedMemory(
    content: string,
    category: MemoryCategory,
    sourceConnector?: string
  ): Promise<MemoryFile | null> {
    const identity = buildExplicitCaptureDedupKey(content, category, sourceConnector);
    const memories = [...(await this.readAllMemories()), ...(await this.readAllColdMemories())];
    return (
      memories.find((memory) => {
        if (memory.frontmatter.status !== "pending_review" || !memory.frontmatter.blockedBy) return false;
        return (
          buildExplicitCaptureDedupKey(
            memory.content,
            memory.frontmatter.category,
            memory.frontmatter.sourceConnector
          ) === identity
        );
      }) ?? null
    );
  }
  async writeMemory(
    category: MemoryCategory,
    content: string,
    options: WriteMemoryOptions = {}
  ): Promise<MemoryWriteResult> {
    await this.ensureDirectories();
    const rawEntityRef = options.entityRef;
    let refIds = typeof options.entityRef === "string" ? this.currentHistoricalIds() : null;
    if (refIds) options = entityRefs.canonicalizeEntityRefOption(options, refIds);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const id = `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const conf = options.confidence ?? 0.8;
    const tier = confidenceTier(conf);
    const validAt = normalizeMemoryWriteTimestamp("validAt", options.validAt);
    const observedAt = normalizeMemoryWriteTimestamp("observedAt", options.observedAt);

    // Auto-set TTL for speculative memories
    let expiresAt: string | undefined;
    if (typeof options.expiresAt === "string" && options.expiresAt.length > 0) {
      expiresAt = options.expiresAt;
    } else if (tier === "speculative") {
      const expiry = new Date(now.getTime() + SPECULATIVE_TTL_DAYS * 24 * 60 * 60 * 1000);
      expiresAt = expiry.toISOString();
    }

    const fm: MemoryFrontmatter = {
      id,
      category,
      created: now.toISOString(),
      updated: now.toISOString(),
      source: options.source ?? "extraction",
      confidence: conf,
      confidenceTier: tier,
      tags: options.tags ?? [],
      entityRef: options.entityRef,
      supersedes: options.supersedes,
      expiresAt,
      lineage: options.lineage,
      importance: options.importance,
      links: options.links,
      intentGoal: options.intentGoal,
      intentActionType: options.intentActionType,
      intentEntityTypes: options.intentEntityTypes,
      artifactType: options.artifactType,
      sourceMemoryId: options.sourceMemoryId,
      sourceTurnId: options.sourceTurnId,
      memoryKind: options.memoryKind,
      valid_at: validAt,
      observedAt,
      eventTimeSource: options.eventTimeSource,
      invalid_at: normalizeMemoryWriteTimestamp("invalidAt", options.invalidAt),
      structuredAttributes: options.structuredAttributes,
    };
    if (options.status !== undefined) {
      fm.status = options.status;
    }
    // Consolidation provenance (issue #561 PR 2).  Fields are independent
    // at the storage layer:
    //   - `derivedFrom: []` → coerced to undefined so we never emit the
    //     invalid `derived_from: []` form the write validator rejects.
    //   - `derivedVia` may stand alone: an orphan operator marker (e.g.
    //     `derived_via: merge` with no `derived_from`) is the correct
    //     serialization when page-versioning is disabled and snapshots
    //     can't be captured.  Downstream logic still needs to identify
    //     the memory as a consolidation output.  Review feedback: PR #624
    //     codex / cursor threads.
    if (options.derivedFrom !== undefined && options.derivedFrom.length > 0) {
      fm.derived_from = options.derivedFrom;
    }
    if (options.derivedVia !== undefined) {
      fm.derived_via = options.derivedVia;
    }
    // Faithfulness gate frontmatter (issue #1576).
    if (options.faithfulness !== undefined) {
      fm.faithfulness = options.faithfulness;
    }
    // Claim-level provenance (issue #1575 PR 2). Wire through to frontmatter
    // so verified spans survive extraction → storage → memory_get end-to-end.
    if (options.sources !== undefined) {
      fm.sources = options.sources;
    }
    if (options.provenance !== undefined) {
      fm.provenance = options.provenance;
    }
    if (options.sourceConnector !== undefined) {
      fm.sourceConnector = options.sourceConnector;
    }

    // Assemble the persisted body (attribute-suffix enrichment + combined
    // sanitize) via the SHARED helper — the sealed-envelope composer uses the
    // same one, so the two write paths cannot diverge (issue #1989 PR2).
    const sanitized = assemblePersistedBody(content, options.structuredAttributes);
    if (!sanitized.clean) {
      log.warn(`memory content sanitized for ${id}; violations=${sanitized.violations.join(", ")}`);
    }
    if (
      options.toolScoped ||
      withholdToolScopedFromSharedNamespace({
        content: sanitized.text,
        sourceConnector: options.sourceConnector,
      })
    ) {
      fm.toolScoped = true;
    }

    // Persist the raw-content dedup hash on the frontmatter so archive and
    // consolidation paths can remove the correct hash from ContentHashIndex
    // regardless of what citation format (if any) has been appended to the
    // stored body. Mirrors the logic in the fact-hash-index update below.
    let factHashSourceForTombstone: string | null = null;
    if (category === "fact") {
      const hashSource =
        options.contentHashSource !== undefined && options.contentHashSource.length > 0
          ? sanitizeMemoryContent(options.contentHashSource).text
          : sanitized.text;
      fm.contentHash = ContentHashIndex.computeHash(hashSource);
      factHashSourceForTombstone = hashSource;
    }

    // ── Non-resurrection chokepoint (issue #1579) ────────────────────────
    // A match persists the fact as pending_review + blockedBy — VISIBLE,
    // never a silent drop (rule 34) — and skips active dedup registration
    // (rule 44). Pre-gate revalidation (#2213): re-resolve from the caller's
    // ORIGINAL ref so the lookup and the persisted ref share one id space.
    if (refIds && typeof rawEntityRef === "string" && this.currentHistoricalIds() !== refIds) {
      refIds = this.currentHistoricalIds();
      fm.entityRef = entityRefs.resolveHistoricalEntityCanonicalId(rawEntityRef, refIds);
    }
    let tombstoneBlocked = false;
    let gateRef: string | undefined;
    let statusBeforeBlock: MemoryFrontmatter["status"];
    // Closure so the post-persist repair can RE-RUN it when a journal move
    // changed the final entityRef: a verdict is only valid for the ref it was
    // computed under, so reset and re-evaluate (parked mappings fall BACK to
    // the legacy claimant; entity-independent tiers re-block in the lookup).
    const applyTombstoneGate = async (): Promise<void> => {
      if (tombstoneBlocked) {
        if (fm.entityRef === gateRef) return;
        tombstoneBlocked = false;
        fm.status = statusBeforeBlock;
        delete fm.blockedBy;
        delete fm.tombstoneBlockTier;
      }
      // Status semantics (thread ObteQ: pending_review candidates included,
      // terminal statuses respected) live in applyTombstoneResurrectionGate.
      if (category !== "fact" || factHashSourceForTombstone === null) return;
      const statusBefore = fm.status;
      const match = await this.entityRefRepair.gate(fm, factHashSourceForTombstone, options.structuredAttributes);
      if (match) {
        gateRef = fm.entityRef;
        statusBeforeBlock = statusBefore;
        tombstoneBlocked = true;
      }
    };
    await applyTombstoneGate();

    const fileContent = `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`;

    const filePath = await this.resolveCategoryWritePath(category, id, today);
    const persistFile = async (): Promise<MemoryFile | null> => {
      if (tombstoneBlocked) {
        const duplicate = await this.findExistingTombstoneBlockedMemory(sanitized.text, category, fm.sourceConnector);
        if (duplicate) return duplicate;
      }
      await this.snapshotBeforeWrite(filePath, "write");
      await this.writeTombstoneBlockedMemory(filePath, fileContent, fm, sanitized.text, async () => {
        this.invalidateAllMemoriesCache();
      });
      if (refIds && typeof rawEntityRef === "string") {
        const refBeforeRepair = fm.entityRef;
        try {
          await entityRefs.repairEntityRefAfterJournalMove({
            stateDir: this.stateDir,
            currentIds: () => this.currentHistoricalIds(),
            idsAtResolve: refIds,
            rawRef: rawEntityRef,
            frontmatter: fm,
            rewrite: async () => {
              await applyTombstoneGate();
              await this.writeTombstoneBlockedMemory(
                filePath,
                `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`,
                fm,
                sanitized.text,
                async () => this.invalidateAllMemoriesCache()
              );
              this.invalidateAllMemoriesCache();
            },
          });
        } catch (err) {
          await unlink(filePath).catch(() => undefined);
          this.invalidateAllMemoriesCache();
          await this.rebuildTombstoneBlockedCaptureAfterInvalidationForPath(filePath);
          throw err;
        }
        await this.entityRefRepair.syncProjection(id, refBeforeRepair, fm.entityRef);
      }
      return null;
    };
    const duplicateBlocked = await this.withTombstoneBlockedCaptureWriteLock(persistFile, [
      buildCapturePathLockIdentity(filePath),
      buildExplicitCaptureDedupKey(sanitized.text, category, fm.sourceConnector),
    ]);
    if (duplicateBlocked) {
      return {
        id: duplicateBlocked.frontmatter.id,
        tombstoneBlocked: true,
        blockedBy: duplicateBlocked.frontmatter.blockedBy,
        duplicateOf: duplicateBlocked.frontmatter.id,
      };
    }
    await this.patchHotMemoriesCache({ addedPath: filePath }, "memory-create");
    this.notifyMemoryWrite(filePath);
    await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.writeMemory", {
      memoryId: id,
      eventType: "created",
      timestamp: fm.created,
      actor: options.actor ?? "storage.writeMemory",
      after: this.summarizeLifecycleState(fm, filePath),
      relatedMemoryIds: [
        ...(options.supersedes ? [options.supersedes] : []),
        ...(options.lineage ?? []).filter(Boolean),
      ],
    });
    if (category === "fact" && !tombstoneBlocked) {
      // Rule 44 (#1579): only active (un-blocked) facts enter the hash
      // index — a blocked entry would silently ban the content on the next
      // extraction.
      try {
        const factHashIndex = await this.getFactHashIndex();
        // Index the caller's contentHashSource (raw fact text before
        // citation annotation) when provided, so hasFactContentHash(rawFact)
        // matches subsequent extractions; else the sanitized persisted body.
        const hashText =
          options.contentHashSource !== undefined && options.contentHashSource.length > 0
            ? sanitizeMemoryContent(options.contentHashSource).text
            : sanitized.text;
        factHashIndex.add(hashText);
        this.factOnlyHashes.add(ContentHashIndex.computeHash(hashText));
        // Gate only the flush (issue #1909): the `.add(...)` above already set
        // dirty=true. When the caller defers, it owns the batch save
        // (extraction persist -> saveContentHashIndexes()). Single-write callers
        // (explicit capture, import, wearable, native writes) flush immediately —
        // via the SAME cross-process locked reconcile the batch/append and
        // rebuild paths use (PR #2016 thread SDyCk), never the unlocked whole-file
        // save() that could clobber, or be clobbered by, a peer's concurrent
        // locked rebuild/reconcile and drop this durable fact from the index.
        if (!options.deferHashIndexSave) {
          await factHashIndex.saveMergingWithDisk();
          // A locked reconcile that times out defers to an unref'd background
          // retry and returns WITHOUT publishing (dirty retained). A single-write
          // caller must not observe that as durable (PR #2016 thread SD7Tk):
          // drain the deferred retry inline so the addition lands on disk (or
          // exhausts its bounded attempts, falling back to the corpus-rebuild
          // safety net) before writeMemory returns. No-op when the save already
          // published (not dirty).
          await factHashIndex.flushReconcileRetry();
        }
      } catch (err) {
        log.warn(`storage.writeMemory completed but failed to update fact hash index: ${err}`);
      }
    }
    log.debug(`wrote memory ${id} to ${filePath}`);
    return { id, tombstoneBlocked, ...(fm.blockedBy ? { blockedBy: fm.blockedBy } : {}) };
  }

  /**
   * Sealed-envelope write entry point (issue #1989 PR2).
   *
   * Byte-identity with `writeMemory` is BY DELEGATION: the envelope-owned
   * fields are unpacked into the exact `writeMemory` arguments a legacy
   * caller would have passed, so the persisted output is produced by the
   * same code path. The composer's `persistedBody` was assembled with the
   * same `assemblePersistedBody` helper `writeMemory` uses, so fingerprints
   * derived from the envelope match the stored body (§13).
   *
   * Differences from a raw `writeMemory` call are REJECTIONS, not silent
   * changes: the composer enforces tag/attribute caps, strict validAt, and
   * plain-object attributes that the legacy path never validated.
   *
   * `envelope.ttl` maps to `expiresAt` verbatim; converting duration
   * expressions (`"90d"`) to instants remains the access layer's job (PR3).
   * `envelope.sourceReason` is access-layer metadata with no frontmatter
   * field and is deliberately not persisted here.
   */
  async writeSealedMemory(envelope: SealedMemoryEnvelope, extras: SealedWriteExtras = {}): Promise<MemoryWriteResult> {
    if (!isSealedMemoryEnvelope(envelope)) {
      throw new Error(
        "writeSealedMemory: value is not a valid sealed memory envelope (fails the composeMemoryEnvelope contract)"
      );
    }
    const { category, content, options } = sealedWriteToLegacyArgs(envelope, extras);
    return this.writeMemory(category, content, options as WriteMemoryOptions);
  }

  async hasFactContentHash(content: string): Promise<boolean> {
    const authoritative = await this.ensureFactHashIndexAuthoritative();
    const sanitized = sanitizeMemoryContent(content);
    const hash = ContentHashIndex.computeHash(sanitized.text);
    // Fact-ONLY answer (PR #2016). The shared content-hash index is
    // category-agnostic — the round-15 authoritative rebuild indexes EVERY
    // active category and addContentHashDedup registers all of them — so it
    // cannot tell a FACT from an unrelated preference/decision/note/moment with
    // the same normalized body. Direct consumers
    // (createWearableMemoryWriter.hasFactContentHash, the explicit-capture
    // negative pre-filter) treat a hit as terminal BEFORE their own source/
    // category confirmation, so answering from the shared index would let a
    // non-fact suppress a real fact candidate. Only category === "fact" registers
    // a fact-content hash at write time (writeMemory), so answer from the
    // fact-only membership rebuilt in lockstep with the shared index. When the
    // index is authoritative that set is current (rebuild + write/removal
    // upkeep); otherwise the snapshot may be stale, so verify against the durable
    // fact corpus (ground truth) so a lock-contended read never suppresses a fact.
    if (authoritative) {
      return this.factOnlyHashes.has(hash);
    }
    return await this.factContentHashPresentInCorpus(hash);
  }

  private async factContentHashPresentInCorpus(targetHash: string): Promise<boolean> {
    const existing = [...(await this.readAllMemories()), ...(await this.readAllColdMemories())];
    for (const memory of existing) {
      if (memory.frontmatter.category !== "fact") continue;
      if (inferMemoryStatus(memory.frontmatter, memory.path) !== "active") continue;
      if (this.corpusRegisteredHash(memory) === targetHash) return true;
    }
    return false;
  }

  private factContentHashForRemoval(memory: MemoryFile): string | null {
    if (memory.frontmatter.category !== "fact") return null;
    if (typeof memory.frontmatter.contentHash === "string" && memory.frontmatter.contentHash.length > 0) {
      return memory.frontmatter.contentHash;
    }
    const configuredHashSource = stripCitationMarkersForHashRemoval(memory.content, this.citationTemplate);
    const hashSource =
      configuredHashSource !== memory.content
        ? configuredHashSource
        : stripDefaultCitationMarkersWithoutRegex(memory.content);
    return ContentHashIndex.computeHash(sanitizeMemoryContent(hashSource).text);
  }

  private async addActiveFactContentHash(memory: MemoryFile): Promise<void> {
    if (memory.frontmatter.category !== "fact") return;
    if (inferMemoryStatus(memory.frontmatter, memory.path) !== "active") return;
    const hash = this.factContentHashForRemoval(memory);
    if (!hash) return;

    await this.ensureFactHashIndexAuthoritative();
    const factHashIndex = await this.getFactHashIndex();
    factHashIndex.addByHash(hash);
    this.factOnlyHashes.add(hash);
    // PR #2016 thread SDzOP: flush through the SAME cross-process locked
    // reconcile the write/batch/rebuild paths use, never the unlocked whole-file
    // save() — an unlocked overwrite drops a concurrent extraction's appended
    // hash and can be clobbered by a peer's locked publish. saveMergingWithDisk
    // republishes only OUR delta ((on-disk \ removed) ∪ added) under the lock.
    await factHashIndex.saveMergingWithDisk();
    // A locked reconcile that times out defers to an unref'd background retry
    // and returns WITHOUT publishing (dirty retained). The reactivation path is
    // a lifecycle boundary just like writeMemory (PR #2016 thread
    // PRRT_kwDORJXyws6SEHvh): a short-lived caller must not observe the deferral
    // as durable. Drain the deferred retry inline so the reintroduced hash lands
    // on disk (or exhausts its bounded attempts, falling back to the
    // corpus-rebuild safety net) before returning. No-op — no duplicated retry
    // work — when the save already published (not dirty).
    await factHashIndex.flushReconcileRetry();
  }

  /**
   * Re-register a fact's contentHash in the dedup index after a tombstone
   * block is lifted on approval (issue #1579 thread ObnTy). `writeMemory`
   * skips hash-index registration for tombstone-blocked facts (rule 44); when
   * the review queue later promotes such a fact back to `status: active`, the
   * hash must enter the index or the next extraction of the same content
   * creates a second active fact. Reads the memory by id so the caller (the
   * review CLI) does not need to re-parse the file. No-op for non-facts or
   * facts that are not active.
   */
  async restoreFactHashAfterApproval(memoryId: string): Promise<void> {
    const all = await this.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === memoryId);
    if (!memory) return;
    await this.addActiveFactContentHash(memory);
  }

  private async syncFactHashIndexAfterRewrite(before: MemoryFile, after: MemoryFile): Promise<void> {
    if (before.frontmatter.category !== "fact" && after.frontmatter.category !== "fact") return;

    const beforeHash = this.factContentHashForRemoval(before);
    const afterHash = this.factContentHashForRemoval(after);
    const beforeStatus = inferMemoryStatus(before.frontmatter, before.path);
    const afterStatus = inferMemoryStatus(after.frontmatter, after.path);
    if (beforeHash === afterHash && beforeStatus === afterStatus) return;

    if (beforeStatus === "active" && beforeHash && (beforeHash !== afterHash || afterStatus !== "active")) {
      await this.removeFactContentHashesForMemories([before]);
    }
    if (afterStatus === "active" && afterHash && (beforeHash !== afterHash || beforeStatus !== "active")) {
      await this.addActiveFactContentHash(after);
    }
  }

  async removeFactContentHashesForMemories(memories: MemoryFile[]): Promise<void> {
    await this.ensureFactHashIndexAuthoritative();
    const factHashIndex = await this.getFactHashIndex();
    const removedIds = new Set(
      memories
        .map((memory) => memory.frontmatter.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    );
    const removedHashes = new Map<MemoryFile, string>();
    for (const memory of memories) {
      const hash = this.factContentHashForRemoval(memory);
      if (hash) {
        removedHashes.set(memory, hash);
      }
    }
    if (removedHashes.size === 0) return;

    const remainingActiveHashes = new Set<string>();
    const remainingMemories = [...(await this.readAllMemories()), ...(await this.readAllColdMemories())];
    for (const memory of remainingMemories) {
      if (memory.frontmatter.category !== "fact") continue;
      if (removedIds.has(memory.frontmatter.id)) continue;
      if (inferMemoryStatus(memory.frontmatter, memory.path) !== "active") continue;
      const hash = this.factContentHashForRemoval(memory);
      if (hash) {
        remainingActiveHashes.add(hash);
      }
    }

    for (const hash of removedHashes.values()) {
      if (!remainingActiveHashes.has(hash)) {
        factHashIndex.removeByHash(hash);
        this.factOnlyHashes.delete(hash);
      }
    }
    // PR #2016 thread SDzOP: serialize the removal with the per-index lock via
    // the removal-aware reconcile, never the unlocked whole-file save(). The
    // unlocked overwrite republished this instance's stale in-memory set,
    // silently clobbering a concurrent extraction's appended hash; the reconcile
    // reads the latest on-disk state, drops only OUR removed hashes, and keeps a
    // peer's concurrent append.
    await factHashIndex.saveMergingWithDisk();
  }

  /**
   * Remove a memory's fact-ONLY hash membership in lockstep with the shared,
   * category-agnostic index removal the orchestrator's
   * `removeContentHashForMemory` performs on archival / semantic consolidation
   * (PR #2016 threads SDzOP / SDzOR). Without this, `factOnlyHashes` kept a
   * removed/superseded fact's hash and `hasFactContentHash` returned a stale
   * `true` until the next corpus rebuild, so wearable / explicit-capture /
   * promotion callers skipped a valid write. In-memory only — `factOnlyHashes`
   * is never persisted; it is rebuilt from the corpus. No-op for non-facts.
   * Matches the shared index's unconditional per-hash removal so the two stay
   * coherent.
   */
  removeFactOnlyHashForMemory(memory: MemoryFile): void {
    if (memory.frontmatter.category !== "fact") return;
    const hash = this.factContentHashForRemoval(memory);
    if (hash) this.factOnlyHashes.delete(hash);
  }

  async isFactContentHashAuthoritative(): Promise<boolean> {
    return await this.ensureFactHashIndexAuthoritative();
  }

  async writeArtifact(
    quote: string,
    options: {
      actor?: string;
      tags?: string[];
      confidence?: number;
      artifactType?: MemoryFrontmatter["artifactType"];
      sourceMemoryId?: string;
      sourceTurnId?: string;
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
      sourceConnector?: string;
      toolScoped?: true;
    } = {}
  ): Promise<string> {
    await this.ensureDirectories();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const dir = path.join(this.artifactsDir, day);
    await mkdir(dir, { recursive: true });

    const id = `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const fm: MemoryFrontmatter = {
      id,
      category: "fact",
      created: now.toISOString(),
      updated: now.toISOString(),
      source: "artifact",
      confidence: options.confidence ?? 0.9,
      confidenceTier: confidenceTier(options.confidence ?? 0.9),
      tags: options.tags ?? [],
      artifactType: options.artifactType ?? "fact",
      sourceMemoryId: options.sourceMemoryId,
      sourceTurnId: options.sourceTurnId,
      intentGoal: options.intentGoal,
      intentActionType: options.intentActionType,
      intentEntityTypes: options.intentEntityTypes,
      ...(options.sourceConnector ? { sourceConnector: options.sourceConnector } : {}),
      ...(options.toolScoped ? { toolScoped: true as const } : {}),
    };

    const sanitized = sanitizeMemoryContent(quote);
    if (!sanitized.clean) {
      log.warn(`artifact content rejected for ${id}; violations=${sanitized.violations.join(", ")}`);
      return "";
    }
    const filePath = path.join(dir, `${id}.md`);
    await this.writeStorageSecureFile(filePath, `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`);
    const actor =
      typeof options.actor === "string" && options.actor.length > 0 ? options.actor : "storage.writeArtifact";
    await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.writeArtifact", {
      memoryId: id,
      eventType: "created",
      timestamp: fm.created,
      actor,
      after: this.summarizeLifecycleState(fm, filePath),
      relatedMemoryIds: options.sourceMemoryId ? [options.sourceMemoryId] : [],
    });
    this.bumpArtifactWriteVersion();
    // Always invalidate on write. This avoids stale mixed snapshots when multiple
    // processes share the same memoryDir and write concurrently.
    this.artifactIndexCache = null;
    return id;
  }

  private async readAllArtifactsCached(): Promise<MemoryFile[]> {
    return this.memoryReadStore.readAllArtifactsCached();
  }

  async searchArtifacts(query: string, maxResults: number): Promise<MemoryFile[]> {
    const tokens = tokenizeArtifactSearchText(query);
    if (tokens.length === 0) return [];

    const artifacts = await this.readAllArtifactsCached();
    const hits: Array<{ score: number; memory: MemoryFile }> = [];
    for (const memory of artifacts) {
      const indexedTokens = new Set(
        tokenizeArtifactSearchText(`${memory.content} ${(memory.frontmatter.tags ?? []).join(" ")}`)
      );
      const score = tokens.reduce((sum, t) => sum + (indexedTokens.has(t) ? 1 : 0), 0);
      if (score > 0) {
        hits.push({ score, memory });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, maxResults).map((h) => h.memory);
  }

  async writeEntity(
    name: string,
    type: string,
    facts: string[],
    options: {
      timestamp?: string;
      source?: string;
      sessionKey?: string;
      principal?: string;
      structuredSections?: EntityStructuredSection[];
    } = {}
  ): Promise<string> {
    return this.entityStore.writeEntity(name, type, facts, options);
  }

  async readProfile(): Promise<string> {
    try {
      return await readMaybeEncryptedFile(this.profilePath, this._secureStoreKey, this.baseDir);
    } catch (error) {
      if (error instanceof SecureStoreLockedError) {
        throw error;
      }
      if (isErrnoCode(error, "ENOENT")) return "";
      throw error;
    }
  }

  async writeProfile(content: string): Promise<void> {
    const stampedContent = renderProfileWithLastUpdated(content, new Date().toISOString());
    await this.ensureDirectories();
    await this.snapshotBeforeWrite(this.profilePath, "consolidation");
    await this.writeStorageSecureFile(this.profilePath, stampedContent);
    log.debug("updated profile.md");
  }

  private static normalizeForDedup(s: string): string {
    if (typeof s !== "string") return "";
    return s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Check if a new bullet is a fuzzy duplicate of any existing bullet.
   * Returns true if the new bullet should be skipped.
   */
  private static isFuzzyDuplicate(newNorm: string, existingNorms: string[]): boolean {
    for (const existing of existingNorms) {
      // Exact normalized match
      if (newNorm === existing) return true;

      // Containment check: shorter must be >60% length of longer
      const shorter = newNorm.length <= existing.length ? newNorm : existing;
      const longer = newNorm.length > existing.length ? newNorm : existing;
      if (shorter.length > 20 && shorter.length / longer.length > 0.6 && longer.includes(shorter)) {
        return true;
      }
    }
    return false;
  }

  async appendToProfile(updates: string[]): Promise<void> {
    // Filter out non-string entries that the LLM may return
    updates = updates.filter((u) => typeof u === "string" && u.trim().length > 0);
    if (updates.length === 0) return;
    const existing = await this.readProfile();

    const lines = existing ? existing.split("\n") : [];
    const existingBulletRaw = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
    const existingNorms = existingBulletRaw.map(StorageManager.normalizeForDedup);

    const newBullets = updates.filter((u) => {
      const norm = StorageManager.normalizeForDedup(u);
      return !StorageManager.isFuzzyDuplicate(norm, existingNorms);
    });
    if (newBullets.length === 0) return;

    if (!existing) {
      const content = ["# Behavioral Profile", "", ...newBullets.map((b) => `- ${b}`), ""].join("\n");
      await this.writeProfile(content);
    } else {
      const withBullets = existing.trimEnd() + "\n" + newBullets.map((b) => `- ${b}`).join("\n") + "\n";
      await this.writeProfile(withBullets);
    }
  }

  /** Check if profile.md exceeds the max line cap and needs LLM consolidation */
  async profileNeedsConsolidation(triggerLines?: number): Promise<boolean> {
    const profile = await this.readProfile();
    if (!profile) return false;
    const lineCount = profile.split("\n").length;
    const threshold =
      typeof triggerLines === "number" ? Math.max(0, Math.floor(triggerLines)) : StorageManager.PROFILE_MAX_LINES;
    return lineCount > threshold;
  }

  private rememberMemorySnapshot<T extends MemoryFile | null>(memory: T): T {
    if (memory !== null && !StorageManager.loadedMemorySnapshots.has(memory)) {
      StorageManager.loadedMemorySnapshots.set(memory, JSON.stringify([memory.frontmatter, memory.content]));
    }
    return memory;
  }

  private rememberMemorySnapshots(memories: MemoryFile[]): MemoryFile[] {
    for (const memory of memories) this.rememberMemorySnapshot(memory);
    return memories;
  }

  async readAllMemories(): Promise<MemoryFile[]> {
    if (this.hotMemoriesCacheEnabled) {
      const cached = getCachedMemories(
        this.baseDir,
        this.getMemoryCorpusVersion(),
        this.hotCacheKeyId(),
        this.hotCacheTtlMs()
      );
      if (cached !== null) return this.rememberMemorySnapshots(cached);
    }
    // Snapshot the secure-store key identity ONCE (issue #1902, Codex Medium):
    // hotCacheKeyId() can change mid-scan if setSecureStoreKey(null/other) runs
    // during the await. Recomputing it at publish time would store K-decrypted
    // results under the new ""/other identity, letting a locked/differently-keyed
    // read match the entry and receive plaintext instead of SecureStoreLockedError.
    // The in-flight slot get/set/delete also key on this snapshot so a mid-scan
    // key change can't orphan the slot registered under the old identity.
    const keyId = this.hotCacheKeyId();
    const inFlight = getInFlightRead(this.baseDir, keyId);
    if (inFlight) return this.rememberMemorySnapshots(await inFlight);

    const readPromise = (async (): Promise<MemoryFile[]> => {
      const version = this.getMemoryCorpusVersion();
      const memories = await this._readAllMemoriesFromDisk();
      // Publish only if neither the corpus version NOR the key identity changed
      // during the scan. The version guard prevents clobbering a newer patched +
      // re-keyed entry; the keyId guard prevents publishing this key's decrypted
      // corpus under a since-changed identity (Codex Medium, #1902).
      if (this.hotMemoriesCacheEnabled && this.getMemoryCorpusVersion() === version && this.hotCacheKeyId() === keyId) {
        setCachedMemories(this.baseDir, memories, version, keyId, this.hotCacheTtlMs());
      }
      return memories;
    })();
    setInFlightRead(this.baseDir, keyId, readPromise);
    try {
      return this.rememberMemorySnapshots(await readPromise);
    } finally {
      deleteInFlightRead(this.baseDir, keyId, readPromise);
    }
  }

  /** Invalidate the readAllMemories() cache after writes that add/remove memories. */
  /** Public cache invalidation for callers that need authoritative disk reads
   *  (e.g. projection verify/rebuild). */
  invalidateAllMemoriesCacheForDir(): void {
    this.invalidateAllMemoriesCache();
  }

  /** Invalidate only the cache layers affected by direct tier file deletes. */
  invalidateMemoryCachesForTiers(tiers: Iterable<"hot" | "cold" | "archive">): void {
    let hotChanged = false;
    let coldChanged = false;
    for (const tier of tiers) {
      if (tier === "cold") {
        coldChanged = true;
      } else if (tier === "hot" || tier === "archive") {
        hotChanged = true;
      }
    }
    if (hotChanged) {
      this.invalidateAllMemoriesCache();
    }
    if (coldChanged) {
      this.invalidateColdMemoriesCache();
    }
  }

  /** Clear ALL static caches. Use in tests that write files directly
   *  (bypassing StorageManager.writeMemory) to avoid stale reads. */
  static clearAllStaticCaches(): void {
    clearInFlightReads();
    StorageManager.questionsCache.clear();
    StorageManager.coldMemoriesCache.clear(); // also wipe the cold-scan TTL cache
    // Also clear the module-level memory-cache layers (hot-memories result cache
    // + entity/derived/QMD layers) so the reset seam is authoritative for tests
    // that write files directly (issue #1902).
    clearMemoryCache();
    // Reset the hot-cache config statics to construction defaults so each test
    // starts from a clean slate (issue #1902). resetStaticCaches() runs before
    // every contract test; without this the per-dir maps and the first-writer
    // process-wide seed would leak across tests.
    StorageManager.hotMemoriesCacheDefaultByDir.clear();
    StorageManager.hotMemoriesCacheTtlByDir.clear();
    StorageManager.hotMemoriesCacheDefault = true;
    StorageManager.hotMemoriesCacheTtlMs = 60_000;
    StorageManager.hotMemoriesCacheProcessDefaultSeeded = false;
    // Reset the #1904 scope-invalidation gate so a legacy-mode (=false) test
    // dir cannot leak its setting into a later test constructing over a reused
    // temp path.
    StorageManager.scopedCacheInvalidationByDir.clear();
  }

  /** Cancel any in-flight concurrent read so the next readAllMemories()
   *  starts a fresh disk scan and sees the just-written data.
   *
   *  Finding UvBq (PR #402 round-11): this method intentionally does NOT
   *  invalidate the cold-scan cache.  Ordinary hot-tier writes (writeMemory)
   *  do not change cold-tier content, so evicting the cold cache on every hot
   *  write was defeating the burst-dedup optimisation — the cold cache was
   *  cleared before applyTemporalSupersession ran, causing a full cold-tree
   *  disk scan on every write in a burst.  Cold cache invalidation is handled
   *  exclusively by invalidateColdMemoriesCache(), which is called only when
   *  cold content actually changes (hot→cold demotions, writeMemoryFileAtomic
   *  inside cold/, archiveMemory, etc.). */
  protected invalidateAllMemoriesCache(): void {
    deleteInFlightReadsForDir(this.baseDir);
    // Bulk/ambiguous mutations drop the hot layer wholesale (below); bump the
    // corpus sentinel too so PEER processes rescan instead of serving a warm
    // pre-mutation corpus entry (issue #1902 cross-process coherence).
    this.bumpMemoryCorpusVersion();
    // Invalidation chokepoint (issue #1535 / #1904): evict the layers a
    // memory-mutate can affect — hot, archive, derived episode/rule views, and
    // both QMD result caches (qmdSearchCache and qmdRecallCache). Before the QMD
    // caches were invalidated on mutations, recall served pre-edit bundles for
    // the remainder of its fresh/stale TTL window. The `entities` layer is NOT
    // in memory-mutate scope: these funnel callers (update/frontmatter/move/
    // archive/invalidate/bulk/offline-sync) never rewrite entity files, and the
    // ones that touch entity-derived state additionally bump the status version
    // (which does the full clear). scopedCacheInvalidationEnabled=false restores
    // the pre-#1904 full clear of every layer (rollback lever).
    if (StorageManager.scopedCacheInvalidationByDir.get(this.baseDir) ?? true) {
      invalidateForScope(this.baseDir, "memory-mutate");
    } else {
      invalidateAllForDir(this.baseDir);
    }
    // Issue #1579 — tombstone store is a cache layer too (rule 25: clear ALL
    // cache layers). A tombstone append from another path (supersession /
    // correction) must be visible to the next writeMemory lookup on this
    // instance without waiting for a process restart.
    if (this.tombstoneStore) {
      this.tombstoneStore.invalidate();
      this.tombstoneStore = null;
      this.tombstoneStoreLoadPromise = null;
    }
  }

  /**
   * Single-file write/delete fast path for the hot-memories cache (issue
   * #1902). Keeps THIS process's version-keyed corpus entry warm by patching
   * the changed memory in place, bumps the dedicated `.memory-corpus-version.log`
   * sentinel so PEER processes rescan (memory-status is deliberately NOT bumped
   * here so plain creates/content edits don't invalidate the entity cache), and
   * evicts only the derived/global layers (which
   * are cheap to rebuild and are never patched). Mirrors the in-flight-dedup
   * and tombstone-store invalidation that invalidateAllMemoriesCache() does.
   *
   * `added` is the written MemoryFile (writes/overwrites); `removedPath` is a
   * deleted path. A path outside the active scan roots (under cold/ or
   * archive/) is NOT applied to the hot map — that cache holds active memories
   * only — but the version bump and derived/global eviction still run so
   * coherence is preserved. Bulk/ambiguous mutations keep the wholesale
   * invalidateAllMemoriesCache() drop instead (issue #1902 Step 5).
   */
  private async patchHotMemoriesCache(
    opts: { addedPath?: string; removedPath?: string },
    scope: "memory-create" | "memory-mutate" = "memory-mutate"
  ): Promise<void> {
    const prevVersion = this.getMemoryCorpusVersion();
    // Snapshot the key identity once (issue #1902, Codex Medium): a mid-await
    // setSecureStoreKey change would otherwise let the post-await patch/re-key
    // store this key's decrypted memory under a since-changed identity.
    const keyId = this.hotCacheKeyId();
    const warm =
      this.hotMemoriesCacheEnabled &&
      getCachedMemories(this.baseDir, prevVersion, keyId, this.hotCacheTtlMs()) !== null;
    if (warm && opts.removedPath !== undefined && !this.isColdOrArchiveTierPath(opts.removedPath)) {
      updateCacheOnDelete(this.baseDir, opts.removedPath, keyId);
    }
    // Bump the corpus sentinel AND drop the in-flight slot BEFORE the awaited
    // one-file re-parse below (Cursor Medium, #1902). The on-disk write already
    // landed in the caller, so advancing the version now makes any concurrent
    // readAllMemories() during the re-parse window miss the still-old hot entry
    // and start a FRESH scan of disk truth (which includes the write) instead of
    // serving the pre-write corpus or joining a pre-write in-flight scan.
    // memory-status is deliberately NOT bumped here so plain creates/content
    // edits don't invalidate the entity cache (issue #1902).
    const { produced, exclusive } = this.bumpMemoryCorpusVersionExclusive();
    deleteInFlightReadsForDir(this.baseDir);
    let patchedOk = warm;
    if (warm && opts.addedPath !== undefined && !this.isColdOrArchiveTierPath(opts.addedPath)) {
      // Re-read + parse the ONE just-written file so the cached object is
      // exactly what a fresh disk scan would yield — serialize→parse normalizes
      // fields (e.g. an empty array becomes undefined), and the in-memory write
      // object would otherwise diverge from disk truth. This is a single O(1)
      // read (the file is page-cache-hot), NOT the O(corpus) scan the cache
      // exists to avoid.
      // Best-effort re-parse: this cache patch runs AFTER the on-disk write and
      // corpus-version bump have already persisted, so it must never fail the
      // completed mutation. If the re-read throws (e.g. setSecureStoreKey(null)
      // locked the store mid-await → SecureStoreLockedError), treat the entry as
      // unpatchable — leave it version-invalidated so the next read rescans —
      // rather than propagating and making writeMemory/updateMemory reject an
      // already-durable write (which a caller would retry, duplicating memories).
      // Issue #1902, Codex Medium.
      let parsed: MemoryFile | undefined;
      try {
        [parsed] = await this.readParsedMemoriesFromPaths([opts.addedPath], 1);
      } catch {
        parsed = undefined;
      }
      if (parsed) {
        updateCacheOnWrite(this.baseDir, parsed, keyId);
      } else {
        // Could not re-parse the write — don't trust the patched entry; leaving
        // it tagged at prevVersion means the version-bumped read rejects it
        // (version mismatch) and rescans.
        patchedOk = false;
      }
    }
    if (
      patchedOk &&
      exclusive &&
      produced === prevVersion + 1 &&
      this.getMemoryCorpusVersion() === produced &&
      this.hotCacheKeyId() === keyId
    ) {
      // Re-key the patched entry (still tagged prevVersion) to the version THIS
      // mutation produced — ONLY if no peer appended between prevVersion capture
      // and our bump (produced === prevVersion + 1), our bump was exclusive, and
      // no further peer append landed during the re-parse (still === produced).
      // Otherwise a concurrent read has already republished disk truth at the
      // newer version, or our patched corpus lacks a peer's write — either way
      // leave it version-rejected so the next read rescans.
      const patched = getCachedMemories(this.baseDir, prevVersion, keyId);
      if (patched) setCachedMemories(this.baseDir, patched, produced, keyId, this.hotCacheTtlMs());
    }
    // Evict the non-hot layers; the hot layer is patched (or intentionally left
    // to be version-rejected) above, not dropped here. Scope-aware (issue #1904):
    // a `memory-create` evicts ONLY the derived episode/rule views, keeping the
    // global QMD result caches and the version-keyed entity cache warm (a create
    // adds a doc that is not yet in the QMD index and changes no existing doc's
    // recall visibility). A `memory-mutate` (or scoped-off rollback) still evicts
    // the derived + global QMD views so a superseded/edited memory cannot resurface
    // from a stale recall bundle (issue #1535 correctness contract).
    if (scope === "memory-create" && (StorageManager.scopedCacheInvalidationByDir.get(this.baseDir) ?? true)) {
      invalidateForScopeExceptHot(this.baseDir, "memory-create");
    } else {
      invalidateDerivedAndGlobalForDir(this.baseDir);
    }
    if (this.tombstoneStore) {
      this.tombstoneStore.invalidate();
      this.tombstoneStore = null;
      this.tombstoneStoreLoadPromise = null;
    }
  }

  /**
   * Invalidate the cold-scan cache for this storage root and bump the
   * on-disk cold-version sentinel so that other processes (gateway, CLI) see
   * the change immediately on their next readAllColdMemories() call.
   *
   * Must be called whenever a memory is written INTO the cold tier — hot→cold
   * demotion, atomic writes inside cold/, archiving a cold memory, etc.
   * NOT called on ordinary hot-tier writes (those don't change cold contents).
   *
   * Finding UvUy (PR #402 round-11): bumping the sentinel here makes the
   * per-process in-memory cache safe across process boundaries.
   */
  protected invalidateColdMemoriesCache(): void {
    const coldRoot = path.join(this.baseDir, "cold");
    StorageManager.coldMemoriesCache.delete(coldRoot);
    this.bumpColdWriteVersion();
    // Invalidation chokepoint (issue #1535): cold-tier mutations can reach
    // this funnel without invalidateAllMemoriesCache() (e.g. the cold-only
    // branch of invalidateMemoryCachesForTiers used by maintenance/purge), so
    // the chokepoint must fire here too — cold memories are recallable and a
    // cold delete must not leave stale QMD recall bundles behind.
    invalidateAllForDir(this.baseDir);
  }

  /** Return the current cold-write version counter for this storage root.
   *  Reads the on-disk sentinel (state/cold-write.log) so it reflects writes
   *  made by other processes. */
  private readColdWriteVersion(): number {
    return this.readSharedVersion("cold-write", StorageManager.coldWriteVersionByDir);
  }

  /** Bump the on-disk cold-write version sentinel and update the in-process
   *  fallback map.  Called by invalidateColdMemoriesCache(). */
  private bumpColdWriteVersion(): void {
    this.bumpSharedVersion("cold-write", StorageManager.coldWriteVersionByDir);
  }

  private normalizeMemoryReadBatchSize(batchSize?: number): number {
    if (typeof batchSize !== "number" || !Number.isFinite(batchSize)) {
      return 50;
    }
    return Math.max(1, Math.floor(batchSize));
  }

  /**
   * Public cheap active-memory path scan (issue #2149 corpus watermark). Lists
   * active memory file paths without parsing frontmatter — safe on a 100k+
   * corpus, unlike readAllMemories().
   */
  async collectActiveMemoryPaths(options?: { propagateReadErrors?: boolean }): Promise<string[]> {
    return this.memoryReadStore.collectActiveMemoryPaths(options);
  }

  /**
   * Public cheap cold-tier path scan (issue #2156 finding D corpus census).
   * Lists demoted-but-reachable memory paths under `cold/` without parsing
   * frontmatter, so the divergence watermark counts the cold tier too.
   */
  async collectColdMemoryPaths(options?: { propagateReadErrors?: boolean }): Promise<string[]> {
    return this.memoryReadStore.collectColdMemoryPaths(options);
  }

  /**
   * Combined hot+cold corpus-mutation sentinel (issue #2156). Changes whenever
   * EITHER tier is written, so a divergence census can bracket its hot/cold scan
   * and detect a tier migration (write-cold-then-unlink-hot) racing the walkers,
   * then retry for a consistent snapshot instead of caching a transient
   * double-count or miss.
   */
  getCorpusScanVersion(): string {
    return `${this.getMemoryCorpusVersion()}:${this.readColdWriteVersion()}`;
  }

  private async readParsedMemoriesFromPaths(filePaths: string[], batchSize?: number): Promise<MemoryFile[]> {
    if (filePaths.length === 0) return [];

    const normalizedBatchSize = this.normalizeMemoryReadBatchSize(batchSize);
    const memories: MemoryFile[] = [];
    for (let i = 0; i < filePaths.length; i += normalizedBatchSize) {
      const batch = filePaths.slice(i, i + normalizedBatchSize);
      const results = await Promise.all(
        batch.map(async (fullPath) => {
          try {
            const raw = await readMaybeEncryptedFile(fullPath, this._secureStoreKey, this.baseDir);
            const parsed = parseFrontmatter(raw);
            if (!parsed) return null;
            return rememberRawFrontmatter(
              {
                path: fullPath,
                frontmatter: normalizeFrontmatterForPath(
                  parsed.frontmatter,
                  toMemoryPathRel(this.baseDir, fullPath),
                  parsed.content
                ),
                content: parsed.content,
              } satisfies MemoryFile,
              raw
            );
          } catch (err) {
            // Re-throw store-locked errors so a locked encrypted store fails
            // loudly rather than appearing as an empty memory corpus (Cursor
            // review finding, PR #767).
            if (err instanceof SecureStoreLockedError) throw err;
            return null;
          }
        })
      );
      for (const memory of results) {
        if (memory !== null) memories.push(memory);
      }
    }
    return memories;
  }

  private async readWindowUpdatedMs(filePath: string): Promise<number | null> {
    try {
      const raw = await readMaybeEncryptedFile(filePath, this._secureStoreKey, this.baseDir);
      const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
      if (!match) return null;
      const frontmatterBlock = match[1];
      const rawUpdated =
        frontmatterBlock.match(/^updated:\s*"?([^"\n]*)"?/m)?.[1] ??
        frontmatterBlock.match(/^created:\s*"?([^"\n]*)"?/m)?.[1] ??
        null;
      const updatedMs = rawUpdated ? Date.parse(rawUpdated) : Number.NaN;
      return Number.isFinite(updatedMs) ? updatedMs : null;
    } catch {
      return null;
    }
  }

  private async filterWindowPathsByUpdatedAfter(filePaths: string[], updatedAfterMs: number): Promise<string[]> {
    const results = await Promise.all(
      filePaths.map(async (filePath) => {
        const updatedMs = await this.readWindowUpdatedMs(filePath);
        if (updatedMs !== null) {
          return updatedMs >= updatedAfterMs ? filePath : null;
        }
        try {
          const fileStat = await stat(filePath);
          return fileStat.mtimeMs >= updatedAfterMs ? filePath : null;
        } catch {
          return filePath;
        }
      })
    );
    return results.filter((filePath): filePath is string => filePath !== null);
  }

  private orderWindowPaths(filePaths: string[]): string[] {
    const correctionPaths: string[] = [];
    const factPaths: string[] = [];

    for (const filePath of filePaths) {
      if (filePath === this.correctionsDir || filePath.startsWith(`${this.correctionsDir}${path.sep}`)) {
        correctionPaths.push(filePath);
      } else {
        factPaths.push(filePath);
      }
    }

    correctionPaths.sort((left, right) => right.localeCompare(left));
    factPaths.sort((left, right) => right.localeCompare(left));

    if (correctionPaths.length === 0) return factPaths;
    if (factPaths.length === 0) return correctionPaths;

    const ordered: string[] = [];
    const maxLength = Math.max(correctionPaths.length, factPaths.length);
    for (let i = 0; i < maxLength; i += 1) {
      const correctionPath = correctionPaths[i];
      if (correctionPath) ordered.push(correctionPath);
      const factPath = factPaths[i];
      if (factPath) ordered.push(factPath);
    }
    return ordered;
  }

  private async readWindowBoundedBatch(
    candidateBatchPaths: string[],
    remainingSlots: number,
    remainingInspectionBudget: number,
    readBatchSize: number
  ): Promise<{ memories: MemoryFile[]; filePaths: string[] }> {
    const memories: MemoryFile[] = [];
    const filePaths: string[] = [];
    const normalizedReadBatchSize = this.normalizeMemoryReadBatchSize(readBatchSize);

    for (let index = 0; index < candidateBatchPaths.length; ) {
      if (memories.length >= remainingSlots || filePaths.length >= remainingInspectionBudget) break;
      const availableSlots = remainingSlots - memories.length;
      const availableInspectionBudget = remainingInspectionBudget - filePaths.length;
      const parallelWindow =
        availableSlots >= 4 && availableInspectionBudget >= 4 ? Math.min(normalizedReadBatchSize, 4) : 1;
      const candidatePaths = candidateBatchPaths.slice(
        index,
        index + Math.min(parallelWindow, availableInspectionBudget)
      );
      index += candidatePaths.length;
      if (candidatePaths.length === 0) break;
      filePaths.push(...candidatePaths);
      const parsedMemories = await this.readParsedMemoriesFromPaths(candidatePaths, candidatePaths.length);
      if (parsedMemories.length === 0) continue;
      memories.push(...parsedMemories.slice(0, availableSlots));
    }

    return { memories, filePaths };
  }

  async readMemoriesWindow(
    options: {
      maxMemories?: number;
      batchSize?: number;
      updatedAfter?: Date;
    } = {}
  ): Promise<{ memories: MemoryFile[]; filePaths: string[] }> {
    return this.memoryReadStore.readMemoriesWindow(options);
  }

  private async _readAllMemoriesFromDisk(): Promise<MemoryFile[]> {
    const filePaths = await this.collectActiveMemoryPaths();
    return this.readParsedMemoriesFromPaths(filePaths, 50);
  }

  async readAllColdMemories(): Promise<MemoryFile[]> {
    return this.rememberMemorySnapshots(await this.memoryReadStore.readAllColdMemories());
  }

  /**
   * Read archived memory markdown files under archive/.
   * Used by long-term recall fallback when hot recall has no hits.
   */
  async readArchivedMemories(): Promise<MemoryFile[]> {
    const memories: MemoryFile[] = [];
    const root = this.archiveDir;

    const readDir = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await readDir(fullPath);
          } else if (entry.name.endsWith(".md")) {
            try {
              const raw = await readMaybeEncryptedFile(fullPath, this._secureStoreKey, this.baseDir);
              const parsed = parseFrontmatter(raw);
              if (parsed) {
                memories.push(
                  rememberRawFrontmatter(
                    {
                      path: fullPath,
                      frontmatter: normalizeFrontmatterForPath(
                        parsed.frontmatter,
                        toMemoryPathRel(this.baseDir, fullPath),
                        parsed.content
                      ),
                      content: parsed.content,
                    },
                    raw
                  )
                );
              }
            } catch (err) {
              // Re-throw store-locked errors — a locked encrypted store
              // must fail loudly, not silently return an empty archive.
              if (err instanceof SecureStoreLockedError) throw err;
              // Skip other unreadable files (ENOENT, parse failures, etc.)
            }
          }
        }
      } catch {
        // Directory doesn't exist yet
      }
    };

    await readDir(root);
    return this.rememberMemorySnapshots(memories);
  }

  async readMemoryByPath(filePath: string): Promise<MemoryFile | null> {
    return this.rememberMemorySnapshot(await this.memoryReadStore.readMemoryByPath(filePath));
  }

  private resolveTierRootDir(tier: "hot" | "cold"): string {
    return tier === "cold" ? path.join(this.baseDir, "cold") : this.baseDir;
  }

  private resolveMemoryDateDir(memory: MemoryFile): string {
    const preferred = memory.frontmatter.created || memory.frontmatter.updated;
    const dateToken = (preferred ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(dateToken) ? dateToken : new Date().toISOString().slice(0, 10);
  }

  private isArtifactMemory(memory: MemoryFile): boolean {
    if (memory.frontmatter.source === "artifact") return true;
    if (memory.frontmatter.artifactType !== undefined) return true;
    return /[\\/]artifacts[\\/]/.test(memory.path);
  }

  buildTierMemoryPath(memory: MemoryFile, tier: "hot" | "cold"): string {
    const root = this.resolveTierRootDir(tier);
    if (this.isArtifactMemory(memory)) {
      return path.join(root, "artifacts", this.resolveMemoryDateDir(memory), `${memory.frontmatter.id}.md`);
    }
    if (memory.frontmatter.category === "correction") {
      // corrections/ is flat (no date subdir); preserved across tier moves.
      return path.join(root, "corrections", `${memory.frontmatter.id}.md`);
    }
    const dir = categoryDirName(memory.frontmatter.category);
    return path.join(root, dir, this.resolveMemoryDateDir(memory), `${memory.frontmatter.id}.md`);
  }
  private async writeMemoryFileAtomic(targetPath: string, memory: MemoryFile): Promise<void> {
    // Whole-record rewrite (tier moves) — #2213. Repair, not just detect:
    // the source is unlinked after the move, so a mapping parked across this
    // write would strand the moved copy with nothing left to reconcile from.
    const refIdsAtWrite = this.currentHistoricalIds();
    const rawRef = memory.frontmatter.entityRef;
    const frontmatter = entityRefs.canonicalizeEntityRefOption(memory.frontmatter, refIdsAtWrite);
    const persist = (): Promise<void> =>
      writeMaybeEncryptedFile(
        targetPath,
        `${serializeFrontmatter(frontmatter)}\n\n${memory.content}\n`,
        this.resolveWriteKey(),
        {},
        this.baseDir
      );
    // Snapshot pre-write destination bytes (raw — encryption-agnostic) so a
    // repair failure restores them or removes a fresh copy (§14): a retained
    // destination would duplicate the record across tiers under a stale ref.
    const priorDest = await readFile(targetPath).catch(() => null);
    await persist();
    if (typeof rawRef === "string") {
      const refBeforeRepair = frontmatter.entityRef;
      try {
        await entityRefs.repairEntityRefAfterJournalMove({
          stateDir: this.stateDir,
          currentIds: () => this.currentHistoricalIds(),
          idsAtResolve: refIdsAtWrite,
          rawRef,
          frontmatter,
          rewrite: persist,
        });
      } catch (err) {
        if (priorDest === null) {
          await unlink(targetPath).catch(() => undefined);
        } else {
          await writeFile(targetPath, priorDest).catch(() => undefined);
        }
        this.invalidateAllMemoriesCache();
        throw err;
      }
      await this.entityRefRepair.syncProjection(memory.frontmatter.id, refBeforeRepair, frontmatter.entityRef);
    }
    // Sync the caller's record with the ref the file now carries: tier-move
    // callers keep using the passed MemoryFile, and a stale legacy ref would
    // mis-route later attribution/projection work (Cursor Medium, round 21).
    if (memory.frontmatter.entityRef !== frontmatter.entityRef) {
      memory.frontmatter.entityRef = frontmatter.entityRef;
    }
    this.invalidateAllMemoriesCache();
    this.notifyCatalogWrite();
  }
  async moveMemoryToPath(memory: MemoryFile, targetPath: string): Promise<boolean> {
    return this.withTombstoneBlockedMemoryPathLock(
      memory.path,
      async (current) => {
        const destination = await this.readMemoryByPath(targetPath);
        if (current?.frontmatter.id !== memory.frontmatter.id) {
          if (current === null && destination?.frontmatter.id === memory.frontmatter.id) return false;
          throw new Error(`memory ${memory.frontmatter.id} changed before its tier move`);
        }
        const callerSnapshot = StorageManager.loadedMemorySnapshots.get(memory);
        const currentSnapshot = JSON.stringify([current.frontmatter, current.content]);
        if (
          callerSnapshot === undefined
            ? current.frontmatter.updated !== memory.frontmatter.updated
            : currentSnapshot !== callerSnapshot
        ) {
          throw new Error(`memory ${memory.frontmatter.id} changed before its tier move`);
        }
        const coordinate =
          tombstoneBlocked(current.frontmatter) ||
          isQueuedReviewMemory(current) ||
          (destination !== null && tombstoneBlocked(destination.frontmatter)) ||
          isQueuedReviewMemory(destination);
        const index = this.getTombstoneBlockedCaptureIndex();
        const marker = coordinate ? await index.prepareWrite() : undefined;
        let durable = false;
        try {
          if (destination?.frontmatter.id === current.frontmatter.id) {
            await this.deleteManagedStorageFile(current.path);
            durable = true;
            this.invalidateAllMemoriesCache();
            updateProjectedMemoryPath(this.baseDir, current.frontmatter.id, toMemoryPathRel(this.baseDir, targetPath));
          } else {
            await this.writeMemoryFileAtomic(targetPath, memory);
            durable = true;
            const sourcePath = path.resolve(current.path);
            const destPath = path.resolve(targetPath);
            if (sourcePath !== destPath) {
              await this.deleteManagedStorageFile(current.path);
              this.invalidateAllMemoriesCache();
              updateProjectedMemoryPath(
                this.baseDir,
                current.frontmatter.id,
                toMemoryPathRel(this.baseDir, targetPath)
              );
            }
          }
          if (marker !== undefined) await this.rebuildTombstoneBlockedCaptureAfterInvalidation(marker);
        } catch (error) {
          if (marker !== undefined && !durable) await index.discardWrite(marker).catch(() => index.markUntrusted());
          if (marker !== undefined && durable) index.markUntrusted();
          throw error;
        }
        return true;
      },
      [targetPath]
    );
  }

  async migrateMemoryToTier(
    memory: MemoryFile,
    targetTier: "hot" | "cold"
  ): Promise<{ changed: boolean; targetPath: string }> {
    const targetPath = this.buildTierMemoryPath(memory, targetTier);
    const sourcePath = path.resolve(memory.path);
    const destPath = path.resolve(targetPath);
    if (sourcePath === destPath) {
      return { changed: false, targetPath };
    }

    const changed = await this.moveMemoryToPath(memory, targetPath);
    if (!changed) return { changed: false, targetPath };
    this.invalidateAllMemoriesCache();
    if (targetTier === "cold") {
      this.invalidateColdMemoriesCache();
    }
    this.bumpMemoryStatusVersion();
    return { changed, targetPath };
  }

  private get archiveDir(): string {
    return path.join(this.baseDir, "archive");
  }

  /**
   * Archive a memory by moving it from facts/ to archive/YYYY-MM-DD/.
   * Updates frontmatter with archived status before moving.
   * Returns the new file path on success, null on failure.
   */
  async archiveMemory(memory: MemoryFile, lifecycle?: MemoryLifecycleEventWriteOptions): Promise<string | null> {
    const archiveCurrent = async (current: MemoryFile, markDurable: () => void): Promise<string | null> => {
      try {
        const now = lifecycle?.at ?? new Date();
        const today = now.toISOString().slice(0, 10);
        const destDir = path.join(this.archiveDir, today);
        await mkdir(destDir, { recursive: true });
        // Whole-record rewrite — inherited-entityRef rule (issue #2213).
        const refIdsAtWrite = this.currentHistoricalIds();
        const updatedFm: MemoryFrontmatter = entityRefs.canonicalizeEntityRefOption(
          {
            ...current.frontmatter,
            status: "archived",
            archivedAt: now.toISOString(),
            updated: now.toISOString(),
          },
          refIdsAtWrite
        );
        const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${current.content}\n`;
        const destPath = path.join(destDir, path.basename(current.path));
        // Snapshot a pre-existing destination (retried archive) so a repair
        // failure restores it instead of deleting the only archived copy (§14).
        const priorDest = await this.readStorageSecureFile(destPath).catch(() => null);
        await this.writeStorageSecureFile(destPath, fileContent);
        if (typeof current.frontmatter.entityRef === "string") {
          try {
            await this.entityRefRepair.repair(
              destPath,
              updatedFm,
              current.frontmatter.entityRef,
              refIdsAtWrite,
              current.content
            );
          } catch (err) {
            // Restore/remove the destination before reporting failure (§14):
            // a retained fresh copy would surface the memory in BOTH scans.
            if (priorDest === null) {
              await unlink(destPath).catch(() => undefined);
            } else {
              await this.writeStorageSecureFile(destPath, priorDest).catch(() => undefined);
            }
            throw err;
          }
        }
        if (!(await this.deleteManagedStorageFile(current.path))) return null;
        markDurable();
        markProjectedMemoryPathInvalid(this.baseDir, current.frontmatter.id);
        this.invalidateAllMemoriesCache();
        await this.appendGeneratedMemoryLifecycleEventFailOpen(
          "storage.archiveMemory",
          {
            memoryId: current.frontmatter.id,
            eventType: "archived",
            timestamp: updatedFm.archivedAt ?? updatedFm.updated,
            actor: lifecycle?.actor ?? "storage.archiveMemory",
            reasonCode: lifecycle?.reasonCode,
            before: this.summarizeLifecycleState(current.frontmatter, current.path),
            after: this.summarizeLifecycleState(updatedFm, destPath),
            relatedMemoryIds: lifecycle?.relatedMemoryIds,
            correlationId: lifecycle?.correlationId,
          },
          lifecycle?.ruleVersion
        );
        this.bumpMemoryStatusVersion();
        log.debug(`archived memory ${current.frontmatter.id} → ${destPath}`);
        return destPath;
      } catch (err) {
        log.warn(`failed to archive memory ${current.frontmatter.id}: ${err}`);
        return null;
      }
    };
    return await this.runTombstoneBlockedArchive(memory, archiveCurrent);
  }

  /** Alias of listEntityNames (kept for legacy callers; sorted). */
  async readEntities(): Promise<string[]> {
    return this.entityStore.listEntityNames();
  }

  async readEntity(name: string): Promise<string> {
    return this.entityStore.readEntity(name);
  }

  async listEntityNames(): Promise<string[]> {
    return this.entityStore.listEntityNames();
  }

  /**
   * Find an existing entity that fuzzy-matches the proposed name.
   * Returns the existing entity filename (without .md) or null if no match.
   *
   * Matching priority:
   * 1. Exact normalized match (handled by normalizeEntityName already)
   * 2. Dehyphenated match: "jane-doe" vs "janedoe"
   * 3. Substring containment: "handle-janedoe" contains "janedoe"
   * 4. Levenshtein ≤ 2 on dehyphenated names
   */
  async findMatchingEntity(proposedName: string, type: string): Promise<string | null> {
    const existing = await this.listEntityNames();
    if (existing.length === 0) return null;

    const typePrefix = `${type.toLowerCase()}-`;
    // Extract the name part from the proposed normalized name
    const proposedFull = this.normalizeEntityName(proposedName, type);
    const proposedNamePart = proposedFull.startsWith(typePrefix) ? proposedFull.slice(typePrefix.length) : proposedFull;
    const proposedDehyph = dehyphenate(proposedNamePart);

    // Only compare against entities of the same type
    const sameType = existing.filter((e) => e.startsWith(typePrefix));

    for (const entity of sameType) {
      const entityNamePart = entity.slice(typePrefix.length);
      const entityDehyph = dehyphenate(entityNamePart);

      // Already the exact normalized form
      if (entity === proposedFull) return entity;

      // Dehyphenated exact match
      if (entityDehyph === proposedDehyph) return entity;

      // Substring containment (shorter must be >60% length of longer)
      const shorter = proposedDehyph.length <= entityDehyph.length ? proposedDehyph : entityDehyph;
      const longer = proposedDehyph.length > entityDehyph.length ? proposedDehyph : entityDehyph;
      if (shorter.length > 3 && shorter.length / longer.length > 0.6 && longer.includes(shorter)) {
        return entity;
      }

      // Levenshtein distance ≤ 2 (only for names of reasonable length)
      if (proposedDehyph.length >= 4 && entityDehyph.length >= 4) {
        const dist = levenshtein(proposedDehyph, entityDehyph);
        if (dist <= 2) return entity;
      }
    }

    return null;
  }

  async invalidateMemory(id: string): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((candidate) => candidate.frontmatter.id === id);
    if (!memory) return false;

    return await this.runTombstoneBlockedInvalidation(memory, async (current, rebuildMarker, markDurable) => {
      if (!(await this.deleteManagedStorageFile(current.path))) return false;
      markDurable();
      markProjectedMemoryPathInvalid(this.baseDir, id);
      this.invalidateAllMemoriesCache();
      await this.rebuildTombstoneBlockedCaptureAfterInvalidation(rebuildMarker);
      this.bumpMemoryStatusVersion();
      log.debug(`invalidated memory ${id}`);
      return true;
    });
  }

  async updateMemory(
    id: string,
    newContent: string,
    options?: { supersedes?: string; lineage?: string[]; actor?: string; sourceConnector?: string }
  ): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    if (!memory) return false;

    const mergedLineage = [...(memory.frontmatter.lineage ?? []), ...(options?.lineage ?? [])].filter(
      (v, i, a) => a.indexOf(v) === i
    ); // dedupe

    // Whole-record rewrite — inherited-entityRef rule (issue #2213).
    const refIdsAtWrite = this.currentHistoricalIds();
    const updated: MemoryFrontmatter = entityRefs.canonicalizeEntityRefOption(
      {
        ...memory.frontmatter,
        updated: new Date().toISOString(),
        supersedes: options?.supersedes ?? memory.frontmatter.supersedes,
        lineage: mergedLineage.length > 0 ? mergedLineage : undefined,
        ...(memory.frontmatter.sourceConnector === undefined && options?.sourceConnector
          ? { sourceConnector: options.sourceConnector }
          : {}),
      },
      refIdsAtWrite
    );
    const sanitized = sanitizeMemoryContent(newContent);
    if (!sanitized.clean) {
      log.warn(`updated memory content sanitized for ${id}; violations=${sanitized.violations.join(", ")}`);
    }
    const fileContent = `${serializeFrontmatter(updated)}\n\n${sanitized.text}\n`;
    await this.writeTombstoneBlockedUpdate(memory, fileContent, updated, sanitized.text, async () => {
      this.invalidateAllMemoriesCache();
    });
    if (typeof memory.frontmatter.entityRef === "string") {
      await this.entityRefRepair.repair(
        memory.path,
        updated,
        memory.frontmatter.entityRef,
        refIdsAtWrite,
        sanitized.text,
        { onFailRestore: memory }
      );
    }
    await this.patchHotMemoriesCache({ addedPath: memory.path });
    await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.updateMemory", {
      memoryId: id,
      eventType: "updated",
      timestamp: updated.updated,
      actor: options?.actor ?? "storage.updateMemory",
      before: this.summarizeLifecycleState(memory.frontmatter, memory.path),
      after: this.summarizeLifecycleState(updated, memory.path),
      relatedMemoryIds: [
        ...(updated.supersedes ? [updated.supersedes] : []),
        ...(updated.lineage ?? []).filter(Boolean),
      ],
    });
    log.debug(`updated memory ${id}`);
    return true;
  }

  /**
   * Update frontmatter fields without changing memory content.
   * Returns false when the memory is not found.
   */
  async writeMemoryFrontmatter(
    memory: MemoryFile,
    patch: Partial<MemoryFrontmatter>,
    lifecycle?: MemoryLifecycleEventWriteOptions
  ): Promise<boolean> {
    const beforeStatus = memory.frontmatter.status ?? "active";
    // Canonicalize the EFFECTIVE merged entityRef (issue #2213) — an
    // unrelated patch must not rewrite an inherited legacy ref back out.
    const resolveIds = this.currentHistoricalIds();
    const updated: MemoryFrontmatter = entityRefs.canonicalizeEntityRefOption(
      { ...memory.frontmatter, ...patch },
      resolveIds
    );
    const refIds = typeof updated.entityRef === "string" ? resolveIds : null;
    const afterStatus = updated.status ?? "active";

    const fileContent = `${serializeFrontmatter(updated)}\n\n${memory.content}\n`;
    await this.writeTombstoneBlockedFrontmatter(memory, fileContent, updated, async () => {
      this.invalidateAllMemoriesCache();
      // Rebuild the blocked index from the post-write cold-tier cache.
      if (memory.path.includes(`${path.sep}cold${path.sep}`)) {
        this.invalidateColdMemoriesCache();
      }
    });
    const rawMergedRef = typeof patch.entityRef === "string" ? patch.entityRef : memory.frontmatter.entityRef;
    if (refIds && typeof rawMergedRef === "string") {
      await this.entityRefRepair.repair(memory.path, updated, rawMergedRef, refIds, memory.content, {
        onFailRestore: memory,
      });
    }
    await this.patchHotMemoriesCache({ addedPath: memory.path });
    if (memory.path.includes(`${path.sep}cold${path.sep}`)) {
      this.invalidateColdMemoriesCache();
    }
    try {
      await this.syncFactHashIndexAfterRewrite(memory, {
        ...memory,
        frontmatter: updated,
      });
    } catch (err) {
      log.warn(`storage.writeMemoryFrontmatter completed but failed to update fact hash index: ${err}`);
    }
    await this.appendGeneratedMemoryLifecycleEventFailOpen(
      "storage.writeMemoryFrontmatter",
      {
        memoryId: updated.id,
        eventType: this.frontmatterPatchEventType(memory.frontmatter, updated),
        timestamp: updated.updated ?? new Date().toISOString(),
        actor: lifecycle?.actor ?? "storage.writeMemoryFrontmatter",
        reasonCode: lifecycle?.reasonCode,
        before: this.summarizeLifecycleState(memory.frontmatter, memory.path),
        after: this.summarizeLifecycleState(updated, memory.path),
        relatedMemoryIds: [
          ...(lifecycle?.relatedMemoryIds ?? []),
          ...(updated.supersededBy ? [updated.supersededBy] : []),
          ...(updated.supersedes ? [updated.supersedes] : []),
        ],
        correlationId: lifecycle?.correlationId,
      },
      lifecycle?.ruleVersion
    );
    if (beforeStatus !== afterStatus) {
      // Status/lifecycle change must bump memory-status so the version-keyed
      // entity/derived caches and peer processes observe it (issue #1902:
      // restored — corpus bump alone doesn't cover status-derived views).
      this.bumpMemoryStatusVersion();
    }
    return true;
  }

  /**
   * Update frontmatter by memory ID.
   * Prefer writeMemoryFrontmatter(memory, patch) in batch loops to avoid full-corpus rescans.
   */
  async updateMemoryFrontmatter(id: string, patch: Partial<MemoryFrontmatter>): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    if (!memory) return false;
    return this.writeMemoryFrontmatter(memory, patch);
  }

  /** Remove memories past their TTL expiresAt date */
  async cleanExpiredTTL(): Promise<MemoryFile[]> {
    const memories = await this.readAllMemories();
    const now = Date.now();
    const deleted: MemoryFile[] = [];

    for (const m of memories) {
      if (!m.frontmatter.expiresAt) continue;
      const expiresAt = new Date(m.frontmatter.expiresAt).getTime();
      if (expiresAt >= now) continue;
      const removed = await this.deleteMemoryForMaintenance(m, (current) => {
        const currentExpiresAt = current.frontmatter.expiresAt
          ? new Date(current.frontmatter.expiresAt).getTime()
          : Number.NaN;
        return Number.isFinite(currentExpiresAt) && currentExpiresAt < now;
      });
      if (removed) {
        deleted.push(removed);
        log.debug(`cleaned expired memory ${removed.frontmatter.id} (TTL expired)`);
      }
    }

    if (deleted.length > 0) {
      this.invalidateAllMemoriesCache();
      this.bumpMemoryStatusVersion();
    }

    return deleted;
  }

  async loadBuffer(): Promise<BufferState> {
    const bufferPath = path.join(this.stateDir, "buffer.json");
    try {
      const raw = await this.readStorageSecureFile(bufferPath);
      return JSON.parse(raw) as BufferState;
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return { turns: [], lastExtractionAt: null, extractionCount: 0 };
    }
  }

  async saveBuffer(state: BufferState): Promise<void> {
    await this.ensureDirectories();
    const bufferPath = path.join(this.stateDir, "buffer.json");
    await this.writeStorageSecureFile(bufferPath, JSON.stringify(state, null, 2));
  }

  async loadMeta(): Promise<MetaState> {
    const metaPath = path.join(this.stateDir, "meta.json");
    try {
      const raw = await this.readStorageSecureFile(metaPath);
      const parsed = JSON.parse(raw) as MetaState;
      return {
        extractionCount: typeof parsed.extractionCount === "number" ? parsed.extractionCount : 0,
        lastExtractionAt: parsed.lastExtractionAt ?? null,
        lastConsolidationAt: parsed.lastConsolidationAt ?? null,
        totalMemories: typeof parsed.totalMemories === "number" ? parsed.totalMemories : 0,
        totalEntities: typeof parsed.totalEntities === "number" ? parsed.totalEntities : 0,
        processedExtractionFingerprints: Array.isArray(parsed.processedExtractionFingerprints)
          ? parsed.processedExtractionFingerprints
              .filter(
                (entry) =>
                  entry &&
                  typeof entry === "object" &&
                  typeof (entry as { fingerprint?: unknown }).fingerprint === "string" &&
                  typeof (entry as { observedAt?: unknown }).observedAt === "string"
              )
              .map((entry) => ({
                fingerprint: (entry as { fingerprint: string }).fingerprint,
                observedAt: (entry as { observedAt: string }).observedAt,
              }))
          : [],
        extractionRetryState: parseExtractionRetryStateEntries(parsed.extractionRetryState),
      };
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return {
        extractionCount: 0,
        lastExtractionAt: null,
        lastConsolidationAt: null,
        totalMemories: 0,
        totalEntities: 0,
        processedExtractionFingerprints: [],
      };
    }
  }

  async saveMeta(state: MetaState): Promise<void> {
    await this.ensureDirectories();
    const metaPath = path.join(this.stateDir, "meta.json");
    await this.writeStorageSecureFile(metaPath, JSON.stringify(state, null, 2));
  }

  async appendMemoryActionEvents(events: MemoryActionEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();

    const nowIso = new Date().toISOString();
    const payload = events
      .map((event) => {
        const normalized: MemoryActionEvent = {
          ...event,
          timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
        };
        return `${JSON.stringify(normalized)}\n`;
      })
      .join("");

    await this.appendStorageSecureFile(this.memoryActionsPath, payload);
    return events.length;
  }

  async appendMemoryLifecycleEvents(events: MemoryLifecycleEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();
    // Lock-serialized against compaction; on lock-budget exhaustion the event
    // spills to a durable encrypted pending queue, not dropped (#1910, #2033).
    await appendLifecycleEventsSerialized(
      this.memoryLifecycleLedgerPath,
      (p) => this.appendStorageSecureFile(this.memoryLifecycleLedgerPath, p),
      serializeLifecycleAppendPayload(events),
      { writeSecure: (p, c) => this.writeStorageSecureFile(p, c), readSecure: (p) => this.readStorageSecureFile(p) }
    );
    return events.length;
  }

  /** Drain the durable pending lifecycle-append spill into the ledger (#2033);
   *  fast no-op when nothing is pending. Returns true when rows were drained. */
  async drainPendingMemoryLifecycleEvents(): Promise<boolean> {
    return drainPendingLifecycleLedgerIfAny(
      this.memoryLifecycleLedgerPath,
      { writeSecure: (p, c) => this.writeStorageSecureFile(p, c), readSecure: (p) => this.readStorageSecureFile(p) },
      (p) => this.appendStorageSecureFile(this.memoryLifecycleLedgerPath, p),
      () => this.ensureDirectories()
    );
  }

  /** Offline-sync pre-snapshot drain (#2033): fold pending lifecycle spills into
   *  the active ledger and report whether durable rows STILL remain in the
   *  offline-sync-EXCLUDED pending queue. The caller aborts the snapshot when
   *  `pendingDeferred` is true so append-only rows are never silently omitted. */
  async drainPendingMemoryLifecycleEventsForSync(): Promise<DrainPendingLifecycleForSyncResult> {
    return drainPendingLifecycleLedgerForSync(
      this.memoryLifecycleLedgerPath,
      { writeSecure: (p, c) => this.writeStorageSecureFile(p, c), readSecure: (p) => this.readStorageSecureFile(p) },
      (p) => this.appendStorageSecureFile(this.memoryLifecycleLedgerPath, p),
      () => this.ensureDirectories()
    );
  }

  /** Drain pending lifecycle spills for any ledger inside this storage root.
   * The offline CLI uses this path-aware variant for per-namespace ledgers so
   * secure-store encryption and path-bound authentication remain consistent. */
  async drainPendingMemoryLifecycleEventsForSyncAt(ledgerPath: string): Promise<DrainPendingLifecycleForSyncResult> {
    const target = this.assertManagedStoragePath(ledgerPath, "storage.drainPendingMemoryLifecycleEventsForSyncAt");
    return drainPendingLifecycleLedgerForSync(
      target,
      {
        writeSecure: (p, c) => this.writeStorageSecureFile(p, c),
        readSecure: (p) => this.readStorageSecureFile(p),
      },
      (payload) => this.appendStorageSecureFile(target, payload),
      async () => {
        await mkdir(path.dirname(target), { recursive: true });
      }
    );
  }

  /** Rewrite the ledger through the secure writer (#1910); re-encrypts when unlocked, throws when locked.
   *  `targetPath` re-encrypts under a decryptable backup path's own AAD;
   *  Buffer content passes through verbatim (#2033). `forceEncrypt` preserves
   *  encryption at rest for an already-encrypted ledger/backup even when the
   *  `secureStoreEncryptOnWrite` policy is paused, so a compaction never
   *  downgrades encrypted state to plaintext (#2033); it never bypasses the lock. */
  async writeMemoryLifecycleLedgerContent(
    content: string | Buffer,
    targetPath: string = this.memoryLifecycleLedgerPath,
    forceEncrypt = false
  ): Promise<void> {
    await this.ensureDirectories();
    await this.writeStorageSecureFile(targetPath, content, forceEncrypt);
  }

  async appendBufferSurpriseEvents(events: BufferSurpriseEvent[]): Promise<number> {
    return this.memoryReadStore.appendBufferSurpriseEvents(events);
  }

  async readBufferSurpriseEvents(options: { limit?: number } = {}): Promise<BufferSurpriseEvent[]> {
    return this.memoryReadStore.readBufferSurpriseEvents(options);
  }

  async appendBehaviorSignals(events: BehaviorSignalEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    // Serialize the whole read→dedup→append→cache-commit transaction per
    // instance (issue #1909 review round 3) so concurrent callers cannot each
    // commit an incomplete dedup set. The chain recovers after a rejection.
    const run = this.behaviorSignalsAppendChain
      .catch(() => undefined)
      .then(() => this.appendBehaviorSignalsUnlocked(events));
    this.behaviorSignalsAppendChain = run.catch(() => undefined);
    return run;
  }

  private async appendBehaviorSignalsUnlocked(events: BehaviorSignalEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();

    let existingKeys: Set<string>;
    let identity: { size: number; mtimeMs: number } | null = null;
    try {
      const st = await stat(this.behaviorSignalsPath);
      identity = { size: st.size, mtimeMs: st.mtimeMs };
      if (
        this.behaviorSignalsKeyCache &&
        this.behaviorSignalsKeyCache.identity.size === identity.size &&
        this.behaviorSignalsKeyCache.identity.mtimeMs === identity.mtimeMs
      ) {
        // Cache hit (issue #1909): reuse the dedup set — no read, no parse.
        existingKeys = this.behaviorSignalsKeyCache.keys;
      } else {
        // Foreign change (or first load): rebuild by streaming the file so we
        // never materialize the whole (unbounded) ledger as one string.
        existingKeys = new Set<string>();
        for await (const line of readMaybeEncryptedLines(this.behaviorSignalsPath, () =>
          this.readStorageSecureFile(this.behaviorSignalsPath)
        )) {
          const row = line.trim();
          if (!row) continue;
          try {
            const parsed = JSON.parse(row) as Partial<BehaviorSignalEvent>;
            if (typeof parsed.memoryId === "string" && typeof parsed.signalHash === "string") {
              existingKeys.add(`${parsed.memoryId}:${parsed.signalHash}`);
            }
          } catch {
            // Ignore malformed rows (fail-open).
          }
        }
      }
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      existingKeys = new Set<string>();
      identity = null;
    }

    const nowIso = new Date().toISOString();
    // Collect newly-seen keys in a SEPARATE set — never mutate `existingKeys`
    // (which may alias the cached set) before the append is durable. A failed
    // append must leave the cached dedup set matching what is actually on disk,
    // otherwise a retry would cache-hit a poisoned set and silently drop the
    // events forever (issue #1909 review: pre-durability aliasing).
    const pending = new Set<string>();
    const deduped: BehaviorSignalEvent[] = [];
    for (const event of events) {
      const key = `${event.memoryId}:${event.signalHash}`;
      if (existingKeys.has(key) || pending.has(key)) continue;
      pending.add(key);
      deduped.push({
        ...event,
        timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
      });
    }

    if (deduped.length === 0) {
      // Nothing appended — the file identity is unchanged and `existingKeys` was
      // not mutated, so caching it lets the next append hit (issue #1909).
      if (identity) this.behaviorSignalsKeyCache = { identity, keys: existingKeys };
      return 0;
    }
    const payload = deduped.map((event) => `${JSON.stringify(event)}\n`).join("");
    // May throw (I/O error, SecureStoreLockedError). If it does, we fall through
    // to the caller WITHOUT having touched `existingKeys` or the cache, so the
    // dropped events can be retried.
    await this.appendStorageSecureFile(this.behaviorSignalsPath, payload);
    // Durable now: fold the new keys into the set (in place, O(new keys) — keeps
    // the per-append win). Only cache the refreshed identity if the file grew by
    // EXACTLY our payload — otherwise a foreign writer (another instance/process)
    // interleaved and the file now holds rows whose keys are NOT in existingKeys;
    // caching that identity would let a later same-instance append cache-hit an
    // incomplete set and write duplicates (review round 8 thread 5). On any
    // mismatch, invalidate so the next append reloads from disk.
    for (const key of pending) existingKeys.add(key);
    try {
      const st = await stat(this.behaviorSignalsPath);
      const expectedSize = (identity?.size ?? 0) + Buffer.byteLength(payload, "utf-8");
      if (st.size === expectedSize) {
        this.behaviorSignalsKeyCache = {
          identity: { size: st.size, mtimeMs: st.mtimeMs },
          keys: existingKeys,
        };
      } else {
        // Foreign interleave (or encrypted whole-file rewrite): our key set may
        // be missing peer rows — force a reload on the next append.
        this.behaviorSignalsKeyCache = null;
      }
    } catch {
      // Fail-open: force a reload on the next append.
      this.behaviorSignalsKeyCache = null;
    }
    return deduped.length;
  }

  async appendReextractJobs(events: ReextractJobRequest[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();
    const filePath = path.join(this.stateDir, "reextract-jobs.jsonl");
    const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    try {
      await this.appendStorageSecureFile(filePath, lines);
      return events.length;
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return 0;
    }
  }

  async readReextractJobs(limit: number = 200): Promise<ReextractJobRequest[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 200;
    const filePath = path.join(this.stateDir, "reextract-jobs.jsonl");
    try {
      const raw = await this.readStorageSecureFile(filePath);
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      const parsed: ReextractJobRequest[] = [];
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Partial<ReextractJobRequest>;
          if (
            typeof record.memoryId !== "string" ||
            record.memoryId.length === 0 ||
            typeof record.model !== "string" ||
            record.model.length === 0 ||
            typeof record.requestedAt !== "string" ||
            record.requestedAt.length === 0 ||
            record.source !== "cli-migrate"
          ) {
            continue;
          }
          parsed.push({
            memoryId: record.memoryId,
            model: record.model,
            requestedAt: record.requestedAt,
            source: "cli-migrate",
          });
        } catch {
          continue;
        }
      }
      return parsed.slice(-safeLimit);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return [];
    }
  }

  async readBehaviorSignals(limit: number = 200): Promise<BehaviorSignalEvent[]> {
    const cappedLimit = Math.max(0, Math.floor(limit));
    if (cappedLimit === 0) return [];

    try {
      const raw = await this.readStorageSecureFile(this.behaviorSignalsPath);
      const out: BehaviorSignalEvent[] = [];
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < cappedLimit; i -= 1) {
        const row = lines[i]?.trim();
        if (!row) continue;
        try {
          const parsed = JSON.parse(row) as Partial<BehaviorSignalEvent>;
          if (
            typeof parsed.timestamp === "string" &&
            typeof parsed.namespace === "string" &&
            typeof parsed.memoryId === "string" &&
            typeof parsed.category === "string" &&
            typeof parsed.signalType === "string" &&
            typeof parsed.direction === "string" &&
            typeof parsed.confidence === "number" &&
            typeof parsed.signalHash === "string" &&
            typeof parsed.source === "string"
          ) {
            out.push(parsed as BehaviorSignalEvent);
          }
        } catch {
          // Ignore malformed rows (fail-open).
        }
      }
      return out.reverse();
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return [];
    }
  }

  async readMemoryActionEvents(limit: number = 200): Promise<MemoryActionEvent[]> {
    return (await this.readMemoryActionEventRows(limit)).map((row) => row.event);
  }

  async readMemoryActionEventRows(limit: number = 200): Promise<Array<{ line: number; event: MemoryActionEvent }>> {
    const cappedLimit = Math.max(0, Math.floor(limit));
    if (cappedLimit === 0 || Number.isNaN(cappedLimit)) return [];

    try {
      return await readMemoryActionEventRowsFromLines(
        readMaybeEncryptedLines(this.memoryActionsPath, () => this.readStorageSecureFile(this.memoryActionsPath)),
        cappedLimit
      );
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return [];
    }
  }

  async readAllMemoryLifecycleEvents(): Promise<MemoryLifecycleEvent[]> {
    return readAllLifecycleEventsFromLedger(this.memoryLifecycleLedgerPath, (p) => this.readStorageSecureFile(p));
  }

  /** Raw decrypted ledger bytes as a Buffer, never a string, so an oversized
   *  ledger cannot throw on decode before recovery (#2033). */
  async readMemoryLifecycleLedgerRawBufferForCompaction(): Promise<Buffer> {
    return readMaybeEncryptedFileBuffer(this.memoryLifecycleLedgerPath, this._secureStoreKey, this.baseDir);
  }
  async readAllMemoryLifecycleEventsForCompaction(): Promise<MemoryLifecycleEvent[]> {
    if (!(await probeEncryptedRegularFileHeader(this.memoryLifecycleLedgerPath))) {
      return readAllLifecycleEventsFromLedger(this.memoryLifecycleLedgerPath, (p) => this.readStorageSecureFile(p));
    }
    return readAllLifecycleEventsFromLedgerBuffer(this.memoryLifecycleLedgerPath, (p) =>
      readMaybeEncryptedFileBuffer(p, this._secureStoreKey, this.baseDir)
    );
  }

  async readMemoryLifecycleEvents(limit: number = 200): Promise<MemoryLifecycleEvent[]> {
    return readBoundedLifecycleEventsFromLedger(
      this.memoryLifecycleLedgerPath,
      (p) => this.readStorageSecureFile(p),
      limit
    );
  }

  async writeCompressionGuidelines(content: string): Promise<void> {
    await this.ensureDirectories();
    await this.writeStorageSecureFile(this.compressionGuidelinesPath, content);
  }

  async readCompressionGuidelines(): Promise<string | null> {
    try {
      return await this.readStorageSecureFile(this.compressionGuidelinesPath);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async writeCompressionGuidelineDraft(content: string): Promise<void> {
    await this.ensureDirectories();
    await this.writeStorageSecureFile(this.compressionGuidelineDraftPath, content);
  }

  async readCompressionGuidelineDraft(): Promise<string | null> {
    try {
      return await this.readStorageSecureFile(this.compressionGuidelineDraftPath);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async writeCompressionGuidelineOptimizerState(state: CompressionGuidelineOptimizerState): Promise<void> {
    await this.ensureDirectories();
    await this.writeStorageSecureFile(this.compressionGuidelineStatePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async writeCompressionGuidelineDraftState(state: CompressionGuidelineOptimizerState): Promise<void> {
    await this.ensureDirectories();
    await this.writeStorageSecureFile(this.compressionGuidelineDraftStatePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async readCompressionGuidelineOptimizerState(): Promise<CompressionGuidelineOptimizerState | null> {
    return this.readCompressionGuidelineStateFile(this.compressionGuidelineStatePath);
  }

  async readCompressionGuidelineDraftState(): Promise<CompressionGuidelineOptimizerState | null> {
    return this.readCompressionGuidelineStateFile(this.compressionGuidelineDraftStatePath);
  }

  async activateCompressionGuidelineDraft(options?: {
    expectedContentHash?: string;
    expectedGuidelineVersion?: number;
  }): Promise<boolean> {
    const [draftContent, draftState] = await Promise.all([
      this.readCompressionGuidelineDraft(),
      this.readCompressionGuidelineDraftState(),
    ]);
    if (!draftContent || !draftState) return false;
    if (
      typeof options?.expectedContentHash === "string" &&
      options.expectedContentHash.length > 0 &&
      draftState.contentHash !== options.expectedContentHash
    ) {
      return false;
    }
    if (
      typeof options?.expectedGuidelineVersion === "number" &&
      Number.isFinite(options.expectedGuidelineVersion) &&
      draftState.guidelineVersion !== options.expectedGuidelineVersion
    ) {
      return false;
    }
    if (draftState.contentHash) {
      const contentHash = createHash("sha256").update(draftContent).digest("hex");
      if (contentHash !== draftState.contentHash) return false;
    }

    await this.writeCompressionGuidelines(draftContent);
    await this.writeCompressionGuidelineOptimizerState({
      ...draftState,
      activationState: "active",
    });
    await Promise.all([
      unlink(this.compressionGuidelineDraftPath).catch(() => undefined),
      unlink(this.compressionGuidelineDraftStatePath).catch(() => undefined),
    ]);
    return true;
  }

  private async readCompressionGuidelineStateFile(
    filePath: string
  ): Promise<CompressionGuidelineOptimizerState | null> {
    return this.memoryReadStore.readCompressionGuidelineStateFile(filePath);
  }

  async writeIdentityAnchor(content: string): Promise<void> {
    return this.identityContinuityStore.writeIdentityAnchor(content);
  }

  async readIdentityAnchor(): Promise<string | null> {
    return this.identityContinuityStore.readIdentityAnchor();
  }

  async appendContinuityIncident(input: ContinuityIncidentOpenInput): Promise<ContinuityIncidentRecord> {
    return this.identityContinuityStore.appendContinuityIncident(input);
  }

  async readContinuityIncidents(
    limit: number = 200,
    state: "open" | "closed" | "all" = "all"
  ): Promise<ContinuityIncidentRecord[]> {
    return this.identityContinuityStore.readContinuityIncidents(limit, state);
  }

  async closeContinuityIncident(
    id: string,
    closure: ContinuityIncidentCloseInput
  ): Promise<ContinuityIncidentRecord | null> {
    return this.identityContinuityStore.closeContinuityIncident(id, closure);
  }

  async writeIdentityAudit(period: "weekly" | "monthly", key: string, content: string): Promise<string> {
    return this.identityContinuityStore.writeIdentityAudit(period, key, content);
  }

  async readIdentityAudit(period: "weekly" | "monthly", key: string): Promise<string | null> {
    return this.identityContinuityStore.readIdentityAudit(period, key);
  }

  async writeIdentityImprovementLoops(content: string): Promise<void> {
    return this.identityContinuityStore.writeIdentityImprovementLoops(content);
  }

  async readIdentityImprovementLoops(): Promise<string | null> {
    return this.identityContinuityStore.readIdentityImprovementLoops();
  }

  async readIdentityImprovementLoopRegister(): Promise<ContinuityImprovementLoop[]> {
    return this.identityContinuityStore.readIdentityImprovementLoopRegister();
  }

  async upsertIdentityImprovementLoop(input: ContinuityLoopUpsertInput): Promise<ContinuityImprovementLoop> {
    return this.identityContinuityStore.upsertIdentityImprovementLoop(input);
  }

  async reviewIdentityImprovementLoop(
    id: string,
    input: ContinuityLoopReviewInput
  ): Promise<ContinuityImprovementLoop | null> {
    return this.identityContinuityStore.reviewIdentityImprovementLoop(id, input);
  }

  // ---------------------------------------------------------------------------
  // Question storage
  // ---------------------------------------------------------------------------

  private generateId(prefix: string = "m"): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 4);
    return `${prefix}-${ts}-${rand}`;
  }

  async writeQuestion(question: string, context: string, priority: number): Promise<string> {
    await mkdir(this.questionsDir, { recursive: true });

    const id = this.generateId("q");
    const frontmatter = {
      id,
      created: new Date().toISOString(),
      priority,
      resolved: false,
    };

    const content = `---\n${Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n")}\n---\n\n${question}\n\n**Context:** ${context}\n`;

    const filePath = path.join(this.questionsDir, `${id}.md`);
    await this.writeStorageSecureFile(filePath, content);

    log.debug(`wrote question ${id} to ${filePath}`);
    this.invalidateQuestionsCache();
    return id;
  }

  async readQuestions(opts?: { unresolvedOnly?: boolean }): Promise<
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
    return this.memoryReadStore.readQuestions(opts);
  }

  /** Invalidate the questions cache (call after writing a question). */
  invalidateQuestionsCache(): void {
    StorageManager.questionsCache.delete(this.questionsDir);
  }

  private parseQuestionFile(
    raw: string,
    filePath: string
  ): {
    id: string;
    question: string;
    context: string;
    priority: number;
    resolved: boolean;
    created: string;
    filePath: string;
  } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatterStr = match[1];
    const body = match[2].trim();

    // Parse frontmatter
    const id = this.extractFrontmatterValue(frontmatterStr, "id") ?? path.basename(filePath, ".md");
    const created = this.extractFrontmatterValue(frontmatterStr, "created") ?? "";
    const priority = parseFloat(this.extractFrontmatterValue(frontmatterStr, "priority") ?? "0.5");
    const resolved = this.extractFrontmatterValue(frontmatterStr, "resolved") === "true";

    // Extract question and context from body
    const contextMatch = body.match(/\*\*Context:\*\*\s*(.*)/);
    const question = contextMatch ? body.slice(0, contextMatch.index).trim() : body;
    const context = contextMatch ? contextMatch[1].trim() : "";

    return { id, question, context, priority, resolved, created, filePath };
  }

  private extractFrontmatterValue(frontmatter: string, key: string): string | null {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, "m"));
    return match ? match[1] : null;
  }

  async resolveQuestion(id: string): Promise<boolean> {
    const questions = await this.readQuestions();
    const q = questions.find((q) => q.id === id);
    if (!q) return false;

    let raw = await this.readStorageSecureFile(q.filePath);
    raw = raw.replace(/resolved: false/, "resolved: true");
    raw = raw.replace(/---\n\n/, `resolvedAt: "${new Date().toISOString()}"\n---\n\n`);
    await this.writeStorageSecureFile(q.filePath, raw);
    this.invalidateQuestionsCache();
    log.debug(`resolved question ${id}`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Identity file
  // ---------------------------------------------------------------------------

  async readIdentity(workspaceDir: string, namespace?: string): Promise<string> {
    const identityPath = this.identityFilePath(workspaceDir, namespace);
    try {
      return await readFile(identityPath, "utf-8");
    } catch {
      return "";
    }
  }

  async writeIdentity(workspaceDir: string, content: string, namespace?: string): Promise<void> {
    const identityPath = this.identityFilePath(workspaceDir, namespace);
    await writeFile(identityPath, content, "utf-8");
    log.debug(`wrote consolidated IDENTITY.md (${content.length} chars)`);
  }

  /** Max size for IDENTITY.md before we stop appending reflections (15KB leaves room under 20KB gateway limit) */
  private static readonly IDENTITY_MAX_BYTES = 15_000;
  /** Minimum interval between reflections (1 hour) */
  private static readonly REFLECTION_COOLDOWN_MS = 60 * 60 * 1000;

  async appendToIdentity(
    workspaceDir: string,
    reflection: string,
    opts?: { hygiene?: FileHygieneConfig; namespace?: string }
  ): Promise<void> {
    const identityPath = this.identityFilePath(workspaceDir, opts?.namespace);

    let existing = "";
    try {
      existing = await readFile(identityPath, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    const hygiene = opts?.hygiene;
    const rotateEnabled =
      hygiene?.enabled === true &&
      hygiene.rotateEnabled === true &&
      Array.isArray(hygiene.rotatePaths) &&
      hygiene.rotatePaths.includes(path.basename(identityPath));

    // Rotation/splitting: preserve full history, keep the bootstrap file small.
    if (rotateEnabled) {
      const maxBytes = hygiene.rotateMaxBytes;
      if (existing.length > maxBytes) {
        const archiveDir = path.join(workspaceDir, hygiene.archiveDir);
        const { newContent } = await rotateMarkdownFileToArchive({
          filePath: identityPath,
          archiveDir,
          archivePrefix: "IDENTITY",
          keepTailChars: hygiene.rotateKeepTailChars,
        });
        await writeFile(identityPath, newContent, "utf-8");
        existing = newContent;
        log.info(`rotated IDENTITY.md to archive (size=${existing.length} chars, maxBytes=${maxBytes})`);
      }
    } else {
      // Legacy behavior: skip if file is too large
      if (existing.length > StorageManager.IDENTITY_MAX_BYTES) {
        log.debug(
          `IDENTITY.md is ${existing.length} chars (limit ${StorageManager.IDENTITY_MAX_BYTES}); skipping reflection`
        );
        return;
      }
    }

    // Rate-limit: skip if last reflection was less than 1 hour ago
    const lastMatch = existing.match(/## Reflection — (\S+)\s*$/m);
    if (lastMatch) {
      // Find the LAST reflection timestamp
      const allMatches = [...existing.matchAll(/## Reflection — (\S+)/g)];
      if (allMatches.length > 0) {
        const lastTimestamp = allMatches[allMatches.length - 1][1];
        const elapsed = Date.now() - new Date(lastTimestamp).getTime();
        if (elapsed < StorageManager.REFLECTION_COOLDOWN_MS) {
          log.debug(
            `reflection cooldown: ${Math.round(elapsed / 1000)}s since last (need ${StorageManager.REFLECTION_COOLDOWN_MS / 1000}s)`
          );
          return;
        }
      }
    }

    const timestamp = new Date().toISOString();
    const section = `\n\n## Reflection — ${timestamp}\n\n${reflection}\n`;

    await writeFile(identityPath, existing + section, "utf-8");
    log.debug(`appended reflection to ${identityPath}`);
  }

  async readIdentityReflections(): Promise<string | null> {
    try {
      return await this.readStorageSecureFile(this.identityReflectionsPath);
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async writeIdentityReflections(content: string): Promise<void> {
    await mkdir(this.identityDir, { recursive: true });
    await this.writeStorageSecureFile(this.identityReflectionsPath, content);
  }

  async appendIdentityReflection(reflection: string): Promise<void> {
    let existing = "";
    try {
      existing = await this.readStorageSecureFile(this.identityReflectionsPath);
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
      // File doesn't exist yet.
    }

    if (existing.length > StorageManager.IDENTITY_MAX_BYTES) {
      log.debug(
        `identity/reflections.md is ${existing.length} chars (limit ${StorageManager.IDENTITY_MAX_BYTES}); skipping reflection`
      );
      return;
    }

    const allMatches = [...existing.matchAll(/## Reflection — (\S+)/g)];
    if (allMatches.length > 0) {
      const lastTimestamp = allMatches[allMatches.length - 1][1];
      const elapsed = Date.now() - new Date(lastTimestamp).getTime();
      if (elapsed < StorageManager.REFLECTION_COOLDOWN_MS) {
        log.debug(
          `reflection cooldown: ${Math.round(elapsed / 1000)}s since last (need ${StorageManager.REFLECTION_COOLDOWN_MS / 1000}s)`
        );
        return;
      }
    }

    const timestamp = new Date().toISOString();
    const section = `${existing.trimEnd().length > 0 ? "\n\n" : ""}## Reflection — ${timestamp}\n\n${reflection}\n`;
    await mkdir(this.identityDir, { recursive: true });
    await this.writeStorageSecureFile(this.identityReflectionsPath, `${existing.trimEnd()}${section}`);
    log.debug(`appended namespace-local reflection to ${this.identityReflectionsPath}`);
  }

  // Entity-file mutators live on EntityStore (issue #2213): journal-resolved
  // with legacy-file fallback, under the entity-mutation lock.
  async addEntityRelationship(name: string, rel: EntityRelationship): Promise<void> {
    return this.entityStore.addEntityRelationship(name, rel);
  }

  async addEntityActivity(name: string, entry: EntityActivityEntry, maxEntries: number): Promise<void> {
    return this.entityStore.addEntityActivity(name, entry, maxEntries);
  }

  async addEntityAlias(name: string, alias: string): Promise<void> {
    return this.entityStore.addEntityAlias(name, alias);
  }

  async updateEntitySynthesis(
    name: string,
    synthesis: string,
    options: {
      entityUpdatedAt?: string;
      synthesisStructuredFactCount?: number;
      synthesisStructuredFactDigest?: string;
      synthesisTimelineCount?: number;
      updatedAt?: string;
      incrementVersion?: boolean;
    } = {}
  ): Promise<void> {
    return this.entityStore.updateEntitySynthesis(name, synthesis, options);
  }

  /** Backward-compatible alias for legacy callers/tests. */
  async updateEntitySummary(name: string, summary: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    const raw = await this.readEntity(name);
    await this.updateEntitySynthesis(name, summary, {
      entityUpdatedAt: updatedAt,
      synthesisTimelineCount: raw ? parseEntityFile(raw, this.entitySchemas).timeline.length : undefined,
      updatedAt,
    });
  }

  async readEntitySynthesisQueue(): Promise<string[]> {
    try {
      const raw = await this.readStorageSecureFile(this.entitySynthesisQueuePath);
      const parsed = JSON.parse(raw) as { entityNames?: unknown };
      return Array.isArray(parsed.entityNames)
        ? parsed.entityNames.filter((value): value is string => typeof value === "string")
        : [];
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return [];
    }
  }

  async refreshEntitySynthesisQueue(): Promise<string[]> {
    const entityNames = await this.listEntityNames();
    const entityQueueEntries = await Promise.all(
      entityNames.map(async (entityName) => {
        const raw = await this.readEntity(entityName);
        if (!raw) return null;
        return {
          entityName,
          entity: parseEntityFile(raw, this.entitySchemas),
        };
      })
    );
    const staleEntityNames = entityQueueEntries
      .filter((entry): entry is { entityName: string; entity: EntityFile } => entry !== null)
      .filter(({ entity }) => isEntitySynthesisStale(entity))
      .sort((left, right) => {
        const leftTs = latestEntityTimelineTimestamp(left.entity) ?? "";
        const rightTs = latestEntityTimelineTimestamp(right.entity) ?? "";
        return compareEntityTimestamps(rightTs, leftTs);
      })
      .map(({ entityName }) => entityName);

    await mkdir(this.stateDir, { recursive: true });
    await this.writeStorageSecureFile(
      this.entitySynthesisQueuePath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          entityNames: staleEntityNames,
        },
        null,
        2
      ) + "\n"
    );
    return staleEntityNames;
  }

  async removeEntitySynthesisQueueEntries(entityNames: string[]): Promise<void> {
    if (entityNames.length === 0) return;
    const queue = await this.readEntitySynthesisQueue();
    if (queue.length === 0) return;
    const removals = new Set(entityNames);
    const nextQueue = queue.filter((name) => !removals.has(name));
    await mkdir(this.stateDir, { recursive: true });
    await this.writeStorageSecureFile(
      this.entitySynthesisQueuePath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          entityNames: nextQueue,
        },
        null,
        2
      ) + "\n"
    );
  }

  async migrateEntityFilesToCompiledTruthTimeline(): Promise<{ total: number; migrated: number }> {
    return this.entityStore.migrateEntityFilesToCompiledTruthTimeline();
  }

  // ---------------------------------------------------------------------------
  // Scoring + Knowledge Index (Knowledge Graph v7.0)
  // ---------------------------------------------------------------------------

  async readAllEntityFiles(): Promise<EntityFile[]> {
    return this.entityStore.readAllEntityFiles();
  }

  /**
   * Score an entity based on recency, frequency, activity, type priority,
   * and relationship density.
   *
   * score = recency*0.40 + frequency*0.25 + activity*0.15 + typePriority*0.10 + relationshipDensity*0.10
   */
  static scoreEntity(entity: EntityFile, now: Date): number {
    // Recency: 1 / (1 + daysSince/7) — 7-day half-life
    const updated = entity.updated ? new Date(entity.updated).getTime() : 0;
    const daysSince = Math.max(0, (now.getTime() - updated) / (1000 * 60 * 60 * 24));
    const recency = 1 / (1 + daysSince / 7);

    // Frequency: min(facts.length / 20, 1.0)
    const frequency = Math.min(entity.facts.length / 20, 1.0);

    // Activity: min(activity.length / 10, 1.0)
    const activityScore = Math.min(entity.activity.length / 10, 1.0);

    // Type priority
    const TYPE_PRIORITY: Record<string, number> = {
      person: 1.0,
      project: 0.8,
      company: 0.7,
      tool: 0.6,
      place: 0.5,
      other: 0.3,
    };
    const typePriority = TYPE_PRIORITY[entity.type.toLowerCase()] ?? 0.3;

    // Relationship density: min(relationships.length / 8, 1.0)
    const relDensity = Math.min(entity.relationships.length / 8, 1.0);

    return recency * 0.4 + frequency * 0.25 + activityScore * 0.15 + typePriority * 0.1 + relDensity * 0.1;
  }

  async buildKnowledgeIndex(
    config: PluginConfig,
    overrides?: { maxEntities?: number; maxChars?: number }
  ): Promise<{ result: string; cached: boolean }> {
    return this.entityStore.buildKnowledgeIndex(config, overrides);
  }

  /** Invalidate the Knowledge Index cache (call after entity mutations). */
  invalidateKnowledgeIndexCache(): void {
    this.knowledgeIndexCache = null;
  }

  // ---------------------------------------------------------------------------
  // Commitment decay
  // ---------------------------------------------------------------------------

  /** Max lines for profile.md before LLM consolidation triggers */
  private static readonly PROFILE_MAX_LINES = 300;

  async mergeFragmentedEntities(): Promise<number> {
    return this.entityStore.mergeFragmentedEntities();
  }

  async cleanExpiredCommitments(decayDays: number): Promise<MemoryFile[]> {
    const memories = await this.readAllMemories();
    const cutoff = Date.now() - decayDays * 24 * 60 * 60 * 1000;
    const deleted: MemoryFile[] = [];

    for (const m of memories) {
      if (m.frontmatter.category !== "commitment") continue;
      // Only decay commitments that have been marked as resolved/expired
      // (indicated by tags containing "fulfilled" or "expired")
      const isResolved = m.frontmatter.tags.some((t) => t === "fulfilled" || t === "expired");
      if (!isResolved) continue;

      const updatedAt = new Date(m.frontmatter.updated).getTime();
      if (updatedAt >= cutoff) continue;
      try {
        const removed = await this.deleteMemoryForMaintenance(m, (current) => {
          const currentResolved = current.frontmatter.tags.some((tag) => tag === "fulfilled" || tag === "expired");
          const currentUpdatedAt = new Date(current.frontmatter.updated).getTime();
          return currentResolved && currentUpdatedAt < cutoff;
        });
        if (removed) {
          deleted.push(removed);
          log.debug(`cleaned expired commitment ${removed.frontmatter.id}`);
        }
      } catch {
        // Ignore
      }
    }

    if (deleted.length > 0) {
      this.bumpMemoryStatusVersion();
    }

    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Access Tracking (Phase 1A)
  // ---------------------------------------------------------------------------

  /**
   * Flush batched access tracking updates to disk.
   * Called during consolidation or when buffer exceeds max size.
   */
  async flushAccessTracking(entries: AccessTrackingEntry[]): Promise<number> {
    if (entries.length === 0) return 0;

    const memories = await this.readAllMemories();
    const memoryMap = new Map(memories.map((m) => [m.frontmatter.id, m]));
    const memoryPathMap = new Map(memories.map((m) => [path.resolve(m.path), m]));
    let updated = 0;
    // Capture the corpus version + warmth BEFORE writing so we can patch the hot
    // entries in place and then re-key them to the version this flush produces
    // (issue #1902). Access-tracking flush is batched (consolidation / buffer
    // full), not per-recall, so the single corpus bump below is cheap.
    const prevVersion = this.getMemoryCorpusVersion();
    // Snapshot the secure-store key identity once (Cursor Medium #1902), mirroring
    // readAllMemories/patchHotMemoriesCache: a mid-flush setSecureStoreKey change
    // would otherwise let loop patches or the re-keyed entry be stored under a
    // different identity than the one that decrypted this corpus.
    const keyId = this.hotCacheKeyId();
    const warm =
      this.hotMemoriesCacheEnabled &&
      getCachedMemories(this.baseDir, prevVersion, keyId, this.hotCacheTtlMs()) !== null;
    // Record each applied patch so the end-of-flush re-key can re-apply them on
    // top of whatever is cached at prevVersion — robust to a concurrent scan
    // that republished an UNpatched corpus mid-flush (Cursor Medium #1902).
    const appliedPatches = new Map<string, { accessCount: number; lastAccessed: string }>();

    for (const entry of entries) {
      const memory = entry.memoryPath
        ? memoryPathMap.get(path.resolve(entry.memoryPath))
        : memoryMap.get(entry.memoryId);
      if (!memory) continue;

      try {
        const applied = await this.withTombstoneBlockedMemoryPathLock(memory.path, async (current) => {
          if (current?.frontmatter.id !== entry.memoryId) return null;
          const rowIds = this.currentHistoricalIds();
          const newFm: MemoryFrontmatter = entityRefs.canonicalizeEntityRefOption(
            { ...current.frontmatter, accessCount: entry.newCount, lastAccessed: entry.lastAccessed },
            rowIds
          );
          const fileContent = `${serializeFrontmatter(newFm)}\n\n${current.content}\n`;
          await this.writeTombstoneBlockedFrontmatter(current, fileContent, newFm);
          if (typeof current.frontmatter.entityRef === "string") {
            await this.entityRefRepair.repair(
              current.path,
              newFm,
              current.frontmatter.entityRef,
              rowIds,
              current.content,
              { onFailRestore: current }
            );
          }
          return { current, newFm };
        });
        if (applied === null) continue;
        if (warm) {
          updateCacheOnWrite(this.baseDir, { ...applied.current, frontmatter: applied.newFm }, keyId);
        }
        appliedPatches.set(path.resolve(memory.path), {
          accessCount: entry.newCount,
          lastAccessed: entry.lastAccessed,
        });
        updated++;
      } catch (err) {
        log.debug(`failed to update access tracking for ${entry.memoryId}: ${err}`);
      }
    }

    if (updated > 0) {
      // Advance the corpus sentinel so PEER processes rescan and don't overwrite
      // this process's increments (Codex P2): WorkspaceOpsCoordinator computes
      // existingCount + update.count from the cached value, so a peer serving a
      // stale count would undercount. Re-key the locally patched entries to the
      // produced version so this process stays warm — only when our bump was
      // exclusive and still the current sentinel; otherwise a peer also wrote
      // and we must let the next read rescan.
      const { produced, exclusive } = this.bumpMemoryCorpusVersionExclusive();
      // Drop the in-flight read slot after the bump (parity with
      // patchHotMemoriesCache, Cursor Medium #1902): a readAllMemories scan that
      // started before the flush would otherwise keep awaiting a pre-flush scan
      // and could republish it at the old version, clobbering our patches. New
      // readers now start a fresh scan at the bumped version.
      deleteInFlightReadsForDir(this.baseDir);
      if (
        warm &&
        exclusive &&
        produced === prevVersion + 1 &&
        this.getMemoryCorpusVersion() === produced &&
        this.hotCacheKeyId() === keyId
      ) {
        const cur = getCachedMemories(this.baseDir, prevVersion, keyId);
        if (cur) {
          // Re-apply our patches on top of whatever is cached at prevVersion
          // before re-keying (Cursor Medium #1902): a concurrent readAllMemories
          // that finished in the prevVersion epoch may have republished a full
          // UNpatched corpus via its publish guard, clobbering our in-loop
          // updateCacheOnWrite patches. Re-applying is idempotent and makes the
          // re-key robust to that race; the publish guard blocks any scan
          // finishing AFTER our bump, so this is the only window.
          const reapplied = cur.map((m) => {
            const patch = appliedPatches.get(path.resolve(m.path));
            return patch
              ? {
                  ...m,
                  frontmatter: { ...m.frontmatter, accessCount: patch.accessCount, lastAccessed: patch.lastAccessed },
                }
              : m;
          });
          setCachedMemories(this.baseDir, reapplied, produced, keyId, this.hotCacheTtlMs());
        }
      }
      // Evict the derived (episode/rule) + global (QMD recall/search) layers,
      // mirroring patchHotMemoriesCache (Cursor Medium, #1902). The hot layer is
      // patched + re-keyed above; without this the derived caches linger at
      // prevVersion and the QMD recall bundle keeps pre-flush accessCount-based
      // boost ordering until an unrelated mutation invalidates them.
      invalidateDerivedAndGlobalForDir(this.baseDir);
      log.debug(`flushed access tracking for ${updated} memories`);
    }
    return updated;
  }

  /**
   * Get a memory by its ID.
   */
  async getMemoryById(id: string): Promise<MemoryFile | null> {
    const memories = await this.readAllMemories();
    return memories.find((m) => m.frontmatter.id === id) ?? null;
  }

  /**
   * Resolve existing active memory IDs to their on-disk paths.
   *
   * Uses a lightweight directory scan (collectActiveMemoryPaths) that reads
   * file names without parsing frontmatter — much cheaper than readAllMemories()
   * for citation usage tracking and other existence checks.
   */
  async findExistingMemoryPaths(
    ids: string[],
    preferredPaths: Map<string, string[]> = new Map()
  ): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const wantedIds = new Set(ids);
    const filePaths = await this.collectActiveMemoryPaths();
    const pathsById = new Map<string, string[]>();
    const filePathsById = new Map<string, string[]>();
    for (const filePath of filePaths) {
      const memoryId = path.basename(filePath, ".md");
      if (!wantedIds.has(memoryId)) continue;
      const paths = filePathsById.get(memoryId) ?? [];
      paths.push(filePath);
      filePathsById.set(memoryId, paths);
    }
    for (const id of wantedIds) {
      const existingPaths = filePathsById.get(id) ?? [];
      const preferred = preferredPaths.get(id) ?? [];
      const preferredMatches: string[] = [];
      for (const preferredPath of preferred) {
        const directCandidates = new Set(qmdResultPathCandidates(this.baseDir, preferredPath));
        const directMatch = existingPaths.find((filePath) => directCandidates.has(path.resolve(filePath)));
        if (directMatch) {
          preferredMatches.push(directMatch);
          continue;
        }

        const candidates = new Set<string>();
        const parts = qmdCollectionPathParts(preferredPath);
        if (parts) {
          for (const candidate of qmdResultPathCandidates(this.baseDir, parts.relativePath)) {
            candidates.add(candidate);
          }
        }
        const match = existingPaths.find((filePath) => candidates.has(path.resolve(filePath)));
        if (match) preferredMatches.push(match);
      }
      if (preferredMatches.length > 0) {
        pathsById.set(id, preferredMatches);
      } else if (existingPaths.length > 0) {
        pathsById.set(id, existingPaths);
      }
    }
    return pathsById;
  }

  /**
   * Check which of the given memory IDs actually exist on disk.
   */
  async filterExistingMemoryIds(ids: string[]): Promise<Set<string>> {
    return new Set((await this.findExistingMemoryPaths(ids)).keys());
  }

  async getProjectedMemoryState(id: string): Promise<MemoryProjectionCurrentState | null> {
    const projected = readProjectedMemoryState(this.baseDir, id);
    if (projected) return projected;
    warnProjectionFallback(this.baseDir, "getProjectedMemoryState");
    const active = await this.getMemoryById(id);
    if (active) return this.toProjectedCurrentState(active, "active");

    const archived = (await this.readArchivedMemories()).find((memory) => memory.frontmatter.id === id);
    if (!archived) return null;

    return this.toProjectedCurrentState(archived, "archived");
  }

  async browseProjectedMemories(options: ProjectedMemoryBrowseOptions): Promise<ProjectedMemoryBrowsePage | null> {
    return (
      readProjectedMemoryBrowse(this.baseDir, options) ??
      warnProjectionFallback(this.baseDir, "browseProjectedMemories")
    );
  }

  async getProjectedGovernanceRecord(): Promise<ReturnType<typeof readProjectedGovernanceRecord>> {
    return readProjectedGovernanceRecord(this.baseDir);
  }

  private toProjectedCurrentState(memory: MemoryFile, fallbackStatus: MemoryStatus): MemoryProjectionCurrentState {
    const pathRel = toMemoryPathRel(this.baseDir, memory.path);
    return {
      memoryId: memory.frontmatter.id,
      category: memory.frontmatter.category,
      status: inferCurrentStateStatus(memory.frontmatter, pathRel, fallbackStatus),
      lifecycleState: memory.frontmatter.lifecycleState,
      path: memory.path,
      pathRel,
      created: memory.frontmatter.created,
      updated: memory.frontmatter.updated,
      archivedAt: memory.frontmatter.archivedAt,
      supersededAt: memory.frontmatter.supersededAt,
      entityRef: memory.frontmatter.entityRef,
      source: memory.frontmatter.source,
      confidence: memory.frontmatter.confidence,
      confidenceTier: memory.frontmatter.confidenceTier,
      memoryKind: memory.frontmatter.memoryKind,
      accessCount: memory.frontmatter.accessCount,
      lastAccessed: memory.frontmatter.lastAccessed,
      tags: normalizeProjectionTags(memory.frontmatter.tags),
      preview: normalizeProjectionPreview(memory.content),
    };
  }

  async getMemoryTimeline(memoryId: string, limit: number = 200): Promise<MemoryLifecycleEvent[]> {
    const cappedLimit = Math.max(0, Math.floor(limit));
    if (cappedLimit === 0) return [];

    const projected = readProjectedMemoryTimeline(this.baseDir, memoryId, cappedLimit);
    if (projected && projected.length > 0) return projected;
    return this.projectionLedgerLagManager.resolveTimelineWithLag({
      baseDir: this.baseDir,
      ledgerPath: this.memoryLifecycleLedgerPath,
      memoryId,
      cappedLimit,
      readSecureFile: (p) => this.readStorageSecureFile(p),
      projectionAge: () => formatProjectionAge(readProjectionRebuiltAt(this.baseDir)),
    });
  }

  // ---------------------------------------------------------------------------
  // Chunking (Phase 2A)
  // ---------------------------------------------------------------------------

  /**
   * Write a memory chunk with parent reference.
   * Chunk IDs follow format: {parentId}-chunk-{index}
   */
  async writeChunk(
    parentId: string,
    chunkIndex: number,
    chunkTotal: number,
    category: MemoryCategory,
    content: string,
    options: {
      confidence?: number;
      tags?: string[];
      entityRef?: string;
      source?: string;
      importance?: ImportanceScore;
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
      memoryKind?: MemoryFrontmatter["memoryKind"];
      validAt?: string;
      /** Lifecycle status (issue #1576): pending_review chunks stay out of active recall. */
      status?: import("./types.js").MemoryStatus;
      /**
       * Tombstone block provenance (issue #1645): when the parent fact was
       * tombstone-blocked, propagate the tombstone id onto each chunk so an
       * independently-surfaced chunk (memory_get/x-ray/doctor) reveals the block
       * and the chunk stays pending_review, never an active resurrection.
       */
      blockedBy?: string;
      /** Faithfulness gate verdict (issue #1576), propagated from the parent fact. */
      faithfulness?: import("./types.js").FaithfulnessFrontmatter;
      /** Claim-level provenance spans (issue #1575 PR 2), propagated from the parent fact so a chunk surfaced independently (memory_get/x-ray) preserves them (chatgpt-codex-connector thread Ocvmo). */
      sources?: ProvenanceSource[];
      /** Coarse provenance tag (issue #1575 PR 2), propagated from the parent. */
      provenance?: "verified" | "unverified" | "none";
      // Issue #1578 — bi-temporal bounds + ingestion provenance propagated from
      // the parent fact so an independently-surfaced chunk expires at the same
      // invalid_at window and carries the same observed-at anchor.
      invalidAt?: string;
      observedAt?: string;
      eventTimeSource?: "extracted" | "assumed";
      sourceConnector?: string;
      toolScoped?: true;
    } = {}
  ): Promise<string> {
    await this.ensureDirectories();
    const rawEntityRef = options.entityRef;
    let refIds = typeof options.entityRef === "string" ? this.currentHistoricalIds() : null;
    if (refIds) options = entityRefs.canonicalizeEntityRefOption(options, refIds);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const id = `${parentId}-chunk-${chunkIndex}`;
    const conf = options.confidence ?? 0.8;
    const tier = confidenceTier(conf);
    const validAt = normalizeMemoryWriteTimestamp("validAt", options.validAt);
    const chunkInvalidAt = normalizeMemoryWriteTimestamp("invalidAt", options.invalidAt);
    const chunkObservedAt = normalizeMemoryWriteTimestamp("observedAt", options.observedAt);
    const sanitized = sanitizeMemoryContent(content);
    if (!sanitized.clean) {
      log.warn(`chunk content sanitized for ${id}; violations=${sanitized.violations.join(", ")}`);
    }

    const fm: MemoryFrontmatter = {
      id,
      category,
      created: now.toISOString(),
      updated: now.toISOString(),
      source: options.source ?? "chunking",
      confidence: conf,
      confidenceTier: tier,
      tags: options.tags ?? [],
      entityRef: options.entityRef,
      importance: options.importance,
      parentId,
      chunkIndex,
      chunkTotal,
      intentGoal: options.intentGoal,
      intentActionType: options.intentActionType,
      intentEntityTypes: options.intentEntityTypes,
      memoryKind: options.memoryKind,
      valid_at: validAt,
      invalid_at: chunkInvalidAt,
      observedAt: chunkObservedAt,
      eventTimeSource: options.eventTimeSource,
      ...(options.status ? { status: options.status } : {}),
      ...(options.blockedBy ? { blockedBy: options.blockedBy } : {}),
      ...(options.faithfulness ? { faithfulness: options.faithfulness } : {}),
      ...(options.sources ? { sources: options.sources } : {}),
      ...(options.provenance ? { provenance: options.provenance } : {}),
      ...(options.sourceConnector ? { sourceConnector: options.sourceConnector } : {}),
      ...(options.toolScoped ||
      withholdToolScopedFromSharedNamespace({
        content: sanitized.text,
        sourceConnector: options.sourceConnector,
      })
        ? { toolScoped: true as const }
        : {}),
    };

    const filePath = await this.resolveCategoryWritePath(category, id, today);
    const fileContent = `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`;

    const written = await this.writeTombstoneBlockedChunk(
      filePath,
      fileContent,
      fm,
      sanitized.text,
      () => this.findExistingTombstoneBlockedMemory(sanitized.text, category, fm.sourceConnector),
      async (priorChunk) => {
        if (refIds && typeof rawEntityRef === "string") {
          await this.entityRefRepair.repair(filePath, fm, rawEntityRef, refIds, sanitized.text, {
            regateFact: true,
            ...(priorChunk ? { onFailRestore: priorChunk } : { onFailRemove: filePath }),
          });
        }
        // Keep the version-keyed hot-memories cache coherent with the new chunk
        // file (issue #1902) — same single-file patch path writeMemory uses.
        await this.patchHotMemoriesCache({ addedPath: filePath }, "memory-create");
        log.debug(`wrote chunk ${id} (${chunkIndex + 1}/${chunkTotal}) to ${filePath}`);
      }
    );
    return written;
  }

  /**
   * Get all chunks for a given parent memory ID.
   * Returns chunks sorted by chunkIndex.
   */
  async getChunksForParent(parentId: string): Promise<MemoryFile[]> {
    const memories = await this.readAllMemories();
    return memories
      .filter((m) => m.frontmatter.parentId === parentId)
      .sort((a, b) => (a.frontmatter.chunkIndex ?? 0) - (b.frontmatter.chunkIndex ?? 0));
  }

  // ---------------------------------------------------------------------------
  // Contradiction Detection (Phase 2B)
  // ---------------------------------------------------------------------------

  /**
   * Mark a memory as superseded by another.
   * Updates the old memory's status and adds the supersededBy link.
   */
  async supersedeMemory(oldMemoryId: string, newMemoryId: string, reason: string): Promise<boolean> {
    const memories = await this.readAllMemories();
    const oldMemory = memories.find((m) => m.frontmatter.id === oldMemoryId);
    if (!oldMemory) return false;

    const now = new Date().toISOString();
    let currentBefore = oldMemory;
    let updatedFm = oldMemory.frontmatter;

    try {
      const written = await this.withTombstoneBlockedMemoryPathLock(oldMemory.path, async (current) => {
        if (current?.frontmatter.id !== oldMemoryId) return false;
        currentBefore = current;
        const refIdsAtWrite = this.currentHistoricalIds();
        updatedFm = entityRefs.canonicalizeEntityRefOption(
          { ...current.frontmatter, status: "superseded", supersededBy: newMemoryId, supersededAt: now, updated: now },
          refIdsAtWrite
        );
        const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${current.content}\n`;
        await this.writeTombstoneBlockedFrontmatter(current, fileContent, updatedFm);
        if (typeof current.frontmatter.entityRef === "string") {
          await this.entityRefRepair.repair(
            current.path,
            updatedFm,
            current.frontmatter.entityRef,
            refIdsAtWrite,
            current.content,
            { onFailRestore: current }
          );
        }
        return true;
      });
      if (!written) return false;
      // Advance the corpus sentinel immediately after the on-disk write, BEFORE
      // the awaited lifecycle append (Cursor Medium, #1902). Otherwise a warm
      // hot-memories cache keeps serving the pre-supersede snapshot during the
      // await window; bumpMemoryStatusVersion() below additionally invalidates
      // the entity cache for the status change.
      this.bumpMemoryCorpusVersion();
      await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.supersedeMemory", {
        memoryId: oldMemoryId,
        eventType: "superseded",
        timestamp: now,
        actor: "storage.supersedeMemory",
        reasonCode: reason,
        before: this.summarizeLifecycleState(currentBefore.frontmatter, currentBefore.path),
        after: this.summarizeLifecycleState(updatedFm, currentBefore.path),
        relatedMemoryIds: [newMemoryId],
      });
      this.bumpMemoryStatusVersion();
      log.debug(`superseded memory ${oldMemoryId} by ${newMemoryId}: ${reason}`);

      // #1579 — every contradiction verb (keep-a/keep-b/merge) funnels here,
      // so emitting covers each exactly once (rule 22); facts only. One
      // tombstone PER derived supersession key (thread Oci-Y) so a
      // paraphrased re-write is caught on the keyed tier.
      if (currentBefore.frontmatter.category === "fact") {
        for (const input of buildRetiredFactTombstoneInputs(
          {
            id: oldMemoryId,
            content: stripCitationForTemplate(currentBefore.content, this.citationTemplate),
            contentHash: currentBefore.frontmatter.contentHash,
            entityRef: updatedFm.entityRef,
            structuredAttributes: currentBefore.frontmatter.structuredAttributes,
          },
          {
            reason: "contradiction_resolution",
            createdBy: "contradiction_resolution",
            createdAt: now,
            supersessionKeysForFact,
          }
        )) {
          await this.appendTombstone(input);
        }
      }

      // Audit-trail correction — sealed even INSIDE the engine (#2022 review).
      const auditBody = `Superseded: ${currentBefore.content}\n\nReason: ${reason}`;
      const auditInput = {
        content: auditBody,
        category: "correction" as const,
        confidence: 1.0,
        tags: ["supersession", "auto-resolved"],
      };
      const auditEnvelope = composeMemoryEnvelope(auditInput, { source: "contradiction-detection" });
      await this.writeSealedMemory(auditEnvelope, { lineage: [oldMemoryId, newMemoryId] });

      return true;
    } catch (err) {
      log.error(`failed to supersede memory ${oldMemoryId}:`, err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Memory Summarization (Phase 4A)
  // ---------------------------------------------------------------------------

  private get summariesDir(): string {
    return path.join(this.baseDir, "summaries");
  }

  /**
   * Write a memory summary.
   */
  async writeSummary(summary: MemorySummary): Promise<void> {
    await mkdir(this.summariesDir, { recursive: true });
    const filePath = path.join(this.summariesDir, `${summary.id}.json`);
    await this.writeStorageSecureFile(filePath, JSON.stringify(summary, null, 2));
    log.debug(`wrote summary ${summary.id}`);
  }

  /**
   * Get all summaries.
   */
  async readSummaries(): Promise<MemorySummary[]> {
    try {
      const files = await readdir(this.summariesDir);
      const summaries: MemorySummary[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(this.summariesDir, file);
        const raw = await this.readStorageSecureFile(filePath);
        summaries.push(JSON.parse(raw) as MemorySummary);
      }

      return summaries;
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return [];
    }
  }

  /**
   * Archive memories (mark as archived, not delete).
   */
  async archiveMemories(memoryIds: string[], summaryId: string): Promise<number> {
    const memories = await this.readAllMemories();
    const memoryMap = new Map(memories.map((m) => [m.frontmatter.id, m]));
    let archived = 0;

    for (const id of memoryIds) {
      const memory = memoryMap.get(id);
      if (!memory) continue;

      const now = new Date().toISOString();
      let currentBefore = memory;
      let updatedFm = memory.frontmatter;

      try {
        const written = await this.withTombstoneBlockedMemoryPathLock(memory.path, async (current) => {
          if (current?.frontmatter.id !== id) return false;
          currentBefore = current;
          const rowIds = this.currentHistoricalIds();
          updatedFm = entityRefs.canonicalizeEntityRefOption(
            { ...current.frontmatter, status: "archived", archivedAt: now, updated: now },
            rowIds
          );
          const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${current.content}\n`;
          await this.writeTombstoneBlockedFrontmatter(current, fileContent, updatedFm);
          if (typeof current.frontmatter.entityRef === "string") {
            await this.entityRefRepair.repair(
              current.path,
              updatedFm,
              current.frontmatter.entityRef,
              rowIds,
              current.content,
              { onFailRestore: current }
            );
          }
          return true;
        });
        if (!written) continue;
        // Per-file corpus bump BEFORE the awaited lifecycle append (#1902):
        // the end-of-loop status bump fires only after the whole batch.
        this.bumpMemoryCorpusVersion();
        await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.archiveMemories", {
          memoryId: id,
          eventType: "archived",
          timestamp: updatedFm.archivedAt ?? updatedFm.updated,
          actor: "storage.archiveMemories",
          reasonCode: `summary:${summaryId}`,
          before: this.summarizeLifecycleState(currentBefore.frontmatter, currentBefore.path),
          after: this.summarizeLifecycleState(updatedFm, currentBefore.path),
          relatedMemoryIds: [summaryId],
        });
        archived++;
      } catch {
        // Ignore individual failures
      }
    }

    if (archived > 0) {
      this.bumpMemoryStatusVersion();
      log.debug(`archived ${archived} memories for summary ${summaryId}`);
    }
    return archived;
  }

  // ---------------------------------------------------------------------------
  // Topic Extraction (Phase 4B)
  // ---------------------------------------------------------------------------

  /**
   * Save topic scores to meta.json.
   */
  async saveTopics(topics: TopicScore[]): Promise<void> {
    const metaPath = path.join(this.stateDir, "topics.json");
    await mkdir(this.stateDir, { recursive: true });
    await this.writeStorageSecureFile(
      metaPath,
      JSON.stringify({ topics, updatedAt: new Date().toISOString() }, null, 2)
    );
    log.debug(`saved ${topics.length} topic scores`);
  }

  /**
   * Load topic scores from meta.json.
   */
  async loadTopics(): Promise<{ topics: TopicScore[]; updatedAt: string | null }> {
    const metaPath = path.join(this.stateDir, "topics.json");
    try {
      const raw = await this.readStorageSecureFile(metaPath);
      return JSON.parse(raw) as { topics: TopicScore[]; updatedAt: string | null };
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return { topics: [], updatedAt: null };
    }
  }

  /**
   * Add links to an existing memory.
   */
  async addLinksToMemory(
    memoryId: string,
    links: MemoryLink[],
    lifecycle?: MemoryLifecycleEventWriteOptions
  ): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === memoryId);
    if (!memory) return false;

    const existingLinks = memory.frontmatter.links ?? [];
    const mergedLinks = [...existingLinks];

    // Add new links, avoiding duplicates
    for (const link of links) {
      if (!mergedLinks.some((l) => l.targetId === link.targetId && l.linkType === link.linkType)) {
        mergedLinks.push(link);
      }
    }

    try {
      await this.writeMemoryFrontmatter(
        memory,
        {
          links: mergedLinks,
          updated: new Date().toISOString(),
        },
        lifecycle
      );
      log.debug(`added ${links.length} links to memory ${memoryId}`);
      return true;
    } catch (err) {
      log.error(`failed to add links to memory ${memoryId}:`, err);
      return false;
    }
  }

  private summarizeLifecycleState(frontmatter: MemoryFrontmatter, filePath: string): MemoryLifecycleStateSummary {
    return {
      category: frontmatter.category,
      path: filePath,
      status: frontmatter.status ?? "active",
      lifecycleState: frontmatter.lifecycleState,
    };
  }

  private frontmatterPatchEventType(before: MemoryFrontmatter, after: MemoryFrontmatter): MemoryLifecycleEventType {
    const beforeStatus = before.status ?? "active";
    const afterStatus = after.status ?? "active";
    if (beforeStatus !== "archived" && afterStatus === "archived") return "archived";
    if (beforeStatus !== "superseded" && afterStatus === "superseded") return "superseded";
    if (beforeStatus !== "rejected" && afterStatus === "rejected") return "rejected";
    if (beforeStatus !== "active" && afterStatus === "active") {
      return "restored";
    }
    return "updated";
  }

  private async appendGeneratedMemoryLifecycleEvent(
    input: Omit<MemoryLifecycleEvent, "eventId" | "ruleVersion">,
    ruleVersion = "memory-lifecycle-ledger.v1"
  ): Promise<void> {
    await this.appendMemoryLifecycleEvents([
      {
        ...input,
        eventId: this.generateId("mle"),
        ruleVersion,
      },
    ]);
  }

  private async appendGeneratedMemoryLifecycleEventFailOpen(
    operation: string,
    input: Omit<MemoryLifecycleEvent, "eventId" | "ruleVersion">,
    ruleVersion?: string
  ): Promise<void> {
    try {
      await this.appendGeneratedMemoryLifecycleEvent(input, ruleVersion);
    } catch (appendErr) {
      log.warn(`${operation} completed but failed to append lifecycle event: ${appendErr}`);
    }
  }
}
