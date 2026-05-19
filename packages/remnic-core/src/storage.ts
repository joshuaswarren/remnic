import { access, readdir, readFile, stat, writeFile, mkdir, unlink, rename, appendFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { log } from "./logger.js";
import { getCachedEntities, invalidateCachedEntities, setCachedEntities } from "./memory-cache.js";
import { rotateMarkdownFileToArchive } from "./hygiene.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import { createVersion as createPageVersion, type VersioningConfig, type VersionTrigger } from "./page-versioning.js";
import {
  SecureStoreLockedError,
  isEncryptedFile,
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
  CompressionGuidelineOptimizerState,
  PluginConfig,
  ScoredEntity,
  TopicScore,
  FileHygieneConfig,
} from "./types.js";
import { confidenceTier, SPECULATIVE_TTL_DAYS } from "./types.js";
import {
  type ProjectedMemoryBrowseOptions,
  type ProjectedMemoryBrowsePage,
  readProjectedMemoryState,
  readProjectedMemoryBrowse,
  readProjectedGovernanceRecord,
  readProjectedMemoryTimeline,
} from "./memory-projection-store.js";
import {
  inferMemoryStatus,
  isArchivedMemoryPath,
  sortMemoryLifecycleEvents,
  toMemoryPathRel,
} from "./memory-lifecycle-ledger-utils.js";
import {
  normalizeProjectionPreview,
  normalizeProjectionTags,
} from "./memory-projection-format.js";
import {
  closeContinuityIncidentRecord,
  createContinuityIncidentRecord,
  parseContinuityIncident,
  parseContinuityImprovementLoops,
  reviewContinuityLoopInMarkdown,
  serializeContinuityIncident,
  upsertContinuityLoopInMarkdown,
} from "./identity-continuity.js";
import { parseFlexibleIsoTimestamp } from "./utils/iso-timestamp.js";
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

function normalizeMemoryWriteTimestamp(
  field: string,
  value: string | undefined,
): string | undefined {
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

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function trimTrailingSpacesAndTabs(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === " " || value[end - 1] === "\t")) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function trimLeadingSpacesAndTabs(value: string): string {
  let start = 0;
  while (start < value.length && (value[start] === " " || value[start] === "\t")) {
    start += 1;
  }
  return start === 0 ? value : value.slice(start);
}

function stripDefaultCitationMarkersWithoutRegex(value: string): string {
  return stripCitationMarkersForHashRemoval(value, DEFAULT_CITATION_FORMAT);
}

function citationTemplateLiteralParts(template: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{", cursor);
    if (open === -1) {
      parts.push(template.slice(cursor));
      break;
    }
    parts.push(template.slice(cursor, open));
    const close = template.indexOf("}", open + 1);
    if (close === -1) {
      cursor = open + 1;
    } else {
      cursor = close + 1;
    }
  }
  return parts.filter((part) => part.length > 0);
}

function stripCitationMarkersForHashRemoval(value: string, template: string): string {
  const parts = citationTemplateLiteralParts(template);
  if (parts.length === 0) return value;
  const first = parts[0]!;
  const lowerValue = value.toLowerCase();
  const lowerFirst = first.toLowerCase();
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (!lowerValue.includes(lowerFirst)) return value;

  let result = "";
  let cursor = 0;
  let removed = false;
  while (cursor < value.length) {
    const markerStart = lowerValue.indexOf(lowerFirst, cursor);
    if (markerStart === -1) {
      result += value.slice(cursor);
      break;
    }
    const boundedEnd = first.startsWith("[") ? value.indexOf("]", markerStart + first.length) : -1;
    if (first.startsWith("[") && boundedEnd === -1) {
      result += value.slice(cursor);
      break;
    }
    const searchLimit = boundedEnd === -1 ? value.length : boundedEnd + 1;
    let markerEnd = markerStart + first.length;
    let matched = true;
    for (let i = 1; i < lowerParts.length; i += 1) {
      const partIndex = lowerValue.indexOf(lowerParts[i]!, markerEnd);
      if (partIndex === -1 || partIndex + parts[i]!.length > searchLimit) {
        matched = false;
        break;
      }
      markerEnd = partIndex + parts[i]!.length;
    }
    if (!matched) {
      result += value.slice(cursor);
      break;
    }
    result += trimTrailingSpacesAndTabs(value.slice(cursor, markerStart));
    cursor = markerEnd;
    removed = true;
  }

  return removed ? trimLeadingSpacesAndTabs(result) : value;
}

function serializeFrontmatter(fm: MemoryFrontmatter): string {
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
  if (fm.supersedes) lines.push(`supersedes: ${fm.supersedes}`);
  if (fm.expiresAt) lines.push(`expiresAt: ${fm.expiresAt}`);
  if (fm.lineage && fm.lineage.length > 0) {
    lines.push(`lineage: [${fm.lineage.map((l) => `"${l}"`).join(", ")}]`);
  }
  // Status management
  if (fm.status && fm.status !== "active") lines.push(`status: ${fm.status}`);
  if (fm.supersededBy) lines.push(`supersededBy: ${fm.supersededBy}`);
  if (fm.supersededAt) lines.push(`supersededAt: ${fm.supersededAt}`);
  if (fm.archivedAt) lines.push(`archivedAt: ${fm.archivedAt}`);
  // Issue #680 — explicit fact lifecycle.  Emit only when present so legacy
  // memories round-trip unchanged; readers default `valid_at` to `created`.
  if (fm.valid_at) lines.push(`validAt: ${fm.valid_at}`);
  if (fm.invalid_at) lines.push(`invalidAt: ${fm.invalid_at}`);
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
          .join(", ")}]`,
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
      throw new Error(
        `serializeFrontmatter: derived_from must be an array of "<path>:<version>" strings`,
      );
    }
    for (const entry of fm.derived_from) {
      if (!isValidDerivedFromEntry(entry)) {
        throw new Error(
          `serializeFrontmatter: invalid derived_from entry ${JSON.stringify(entry)} — expected "<path>:<version>" with version >= 0`,
        );
      }
    }
    if (fm.derived_from.length > 0) {
      lines.push(
        `derived_from: [${fm.derived_from
          .map((e) => `"${e.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
          .join(", ")}]`,
      );
    }
  }
  if (fm.derived_via !== undefined) {
    if (!isConsolidationOperator(fm.derived_via)) {
      throw new Error(
        `serializeFrontmatter: invalid derived_via ${JSON.stringify(fm.derived_via)} — expected one of "split" | "merge" | "update" | "pattern-reinforcement"`,
      );
    }
    lines.push(`derived_via: ${fm.derived_via}`);
  }
  // Pattern-reinforcement metadata (issue #687 PR 2/4).  Emit only when
  // present so memories never touched by reinforcement round-trip
  // unchanged; matches the `archivedAt` / `forgottenAt` precedent.
  if (fm.reinforcement_count !== undefined) {
    if (
      !Number.isInteger(fm.reinforcement_count) ||
      fm.reinforcement_count <= 0
    ) {
      throw new Error(
        `serializeFrontmatter: reinforcement_count must be a positive integer (got ${JSON.stringify(fm.reinforcement_count)})`,
      );
    }
    lines.push(`reinforcement_count: ${fm.reinforcement_count}`);
  }
  if (fm.last_reinforced_at) {
    lines.push(`last_reinforced_at: ${fm.last_reinforced_at}`);
  }
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

function parseFrontmatterStringValue(rawValue: string | undefined): string | undefined {
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

function parseFrontmatter(
  raw: string,
): { frontmatter: MemoryFrontmatter; content: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
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
          item = item
            .slice(1, -1)
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
        } else if (item.startsWith("'") && item.endsWith("'") && item.length >= 2) {
          item = item.slice(1, -1).replace(/''/g, "'");
        }
        items.push(item);
        j++;
      }
      if (items.length > 0) {
        const inline = items
          .map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
          .join(", ");
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
  const tagMatch = tagsStr.match(/\[(.*)]/);
  if (tagMatch) {
    tags = tagMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  let intentEntityTypes: string[] | undefined;
  const intentEntityTypesStr = fm.intentEntityTypes ?? "";
  const intentEntityTypesMatch = intentEntityTypesStr.match(/\[(.*)]/);
  if (intentEntityTypesMatch) {
    intentEntityTypes = intentEntityTypesMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  const conf = parseFloat(fm.confidence ?? "0.8");

  // Parse lineage array if present
  let lineage: string[] | undefined;
  const lineageStr = fm.lineage ?? "";
  const lineageMatch = lineageStr.match(/\[(.*)]/);
  if (lineageMatch) {
    lineage = lineageMatch[1]
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
      const reasonMatches = reasonsStr.matchAll(/"((?:\\.|[^"\\])*)"/g);
      for (const match of reasonMatches) {
        const reason = parseLinkReasonValue(match[1]);
        if (reason.length > 0) {
          reasons.push(reason);
        }
      }
    }

    // Parse importance keywords array
    let keywords: string[] = [];
    const keywordsStr = fm.importanceKeywords ?? "";
    const keywordsMatch = keywordsStr.match(/\[(.*)]/);
    if (keywordsMatch) {
      keywords = keywordsMatch[1]
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
      supersedes: fm.supersedes || undefined,
      expiresAt: fm.expiresAt || undefined,
      lineage: lineage && lineage.length > 0 ? lineage : undefined,
      // Status management
      status: (fm.status as MemoryStatus) || "active",
      supersededBy: fm.supersededBy || undefined,
      supersededAt: fm.supersededAt || undefined,
      archivedAt: fm.archivedAt || undefined,
      // Issue #680 — explicit fact lifecycle round-trip.
      valid_at: fm.validAt || undefined,
      invalid_at: fm.invalidAt || undefined,
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
      // Pattern-reinforcement metadata (issue #687 PR 2/4).  Parse
      // permissively: invalid values (negative, non-integer, blank
      // ISO-strings) are dropped to undefined so a corrupt frontmatter
      // never poisons downstream scoring.  Validation lives on the
      // write path in serializeFrontmatter.
      reinforcement_count: parseReinforcementCountField(fm.reinforcement_count),
      last_reinforced_at: fm.last_reinforced_at || undefined,
    },
    content,
  };

  // Parse links (YAML array format)
  // Note: Simple parsing - for full YAML we'd need a library.
  if (fmBlock.includes("links:")) {
    const links: MemoryLink[] = [];
    const linkMatches = fmBlock.matchAll(
      /- targetId: (\S+)\s+linkType: (\S+)\s+strength: ([\d.]+)(?:\s+reason: "((?:\\.|[^"\\])*)")?/g,
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
  const typeMatch = content.match(/^\*\*Type:\*\*\s*([^\n]+)/m)?.[1]?.trim().toLowerCase();
  return typeMatch || undefined;
}

const KNOWN_ENTITY_FILENAME_PREFIXES = new Set([
  "company",
  "other",
  "person",
  "place",
  "project",
  "tool",
  "topic",
]);

function inferEntityTypeFromFilename(pathRel: string): string | undefined {
  const basename = path.basename(pathRel, ".md").toLowerCase();
  const separator = basename.indexOf("-");
  if (separator <= 0) return undefined;
  const candidate = basename.slice(0, separator);
  return KNOWN_ENTITY_FILENAME_PREFIXES.has(candidate) ? candidate : undefined;
}

function normalizeFrontmatterForPath(frontmatter: MemoryFrontmatter, pathRel: string, content: string = ""): MemoryFrontmatter {
  const normalizedPath = pathRel.split(path.sep).join("/");
  let normalizedFrontmatter = frontmatter;

  if (normalizedPath === "entities" || normalizedPath.startsWith("entities/") || normalizedPath.includes("/entities/")) {
    const basename = path.basename(pathRel, ".md");
    const inferredType = inferEntityTypeFromContent(content) || inferEntityTypeFromFilename(pathRel) || "entity";
    const existingTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
    normalizedFrontmatter = {
      ...normalizedFrontmatter,
      id: typeof normalizedFrontmatter.id === "string" && normalizedFrontmatter.id.trim().length > 0
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
  fallbackStatus: MemoryStatus,
): MemoryStatus {
  return inferMemoryStatus(frontmatter, pathRel, fallbackStatus);
}

/**
 * Entity alias table loaded from the user's local config.
 * Populated by StorageManager.loadAliases() at startup.
 * Falls back to built-in structural aliases (e.g. "open-claw" → "openclaw").
 */
let userAliases: Record<string, string> = {};

/** Built-in aliases for common structural normalizations (no personal data) */
const BUILTIN_ALIASES: Record<string, string> = {
  openclaw: "openclaw",
  "open-claw": "openclaw",
};

/**
 * Normalize an entity name to a canonical form.
 * Strips non-alphanumeric chars, collapses hyphens, removes type prefix duplication.
 * e.g. "My Project" → "my-project"
 *
 * Checks user-defined aliases (from config/aliases.json) first, then built-in aliases.
 */
export function normalizeEntityName(raw: string, type: string): string {
  // Strip type prefix if present (e.g. name="person-jane-doe", type="person")
  const rawStr = typeof raw === "string" ? raw : "";
  const typeStr = typeof type === "string" && type.trim().length > 0 ? type : "entity";

  let name = rawStr.toLowerCase().trim();
  const typePrefix = `${typeStr.toLowerCase()}-`;
  if (name.startsWith(typePrefix)) {
    name = name.slice(typePrefix.length);
  }

  // Replace non-alphanumeric with hyphens, collapse multiples, trim edges
  let normalized = name
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // Check user aliases first, then built-in
  if (userAliases[normalized]) {
    normalized = userAliases[normalized];
  } else if (BUILTIN_ALIASES[normalized]) {
    normalized = BUILTIN_ALIASES[normalized];
  }

  return `${typeStr.toLowerCase()}-${normalized}`;
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
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Strip hyphens from a string for loose comparison */
function dehyphenate(s: string): string {
  return s.replace(/-/g, "");
}

/**
 * Content-hash dedup index for facts.
 * Normalizes content (lowercase, strip punctuation, collapse whitespace),
 * computes SHA-256, and stores hashes in a line-delimited file.
 * Prevents writing semantically identical facts.
 */
export class ContentHashIndex {
  private hashes: Set<string> = new Set();
  private dirty = false;
  private readonly filePath: string;
  private readonly secureStoreKeyProvider: () => Buffer | null;
  private readonly secureStoreWriteKeyProvider: () => Buffer | null;
  private readonly memoryDir: string;

  constructor(
    stateDir: string,
    secureStoreKeyProvider: () => Buffer | null = () => null,
    secureStoreWriteKeyProvider: () => Buffer | null = secureStoreKeyProvider,
    memoryDir: string = path.dirname(stateDir),
  ) {
    this.filePath = path.join(stateDir, "fact-hashes.txt");
    this.secureStoreKeyProvider = secureStoreKeyProvider;
    this.secureStoreWriteKeyProvider = secureStoreWriteKeyProvider;
    this.memoryDir = memoryDir;
  }

  /** Load existing hashes from disk. Safe to call multiple times. */
  async load(): Promise<void> {
    try {
      const raw = await readMaybeEncryptedFile(this.filePath, this.secureStoreKeyProvider(), this.memoryDir);
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          this.hashes.add(trimmed);
        }
      }
      log.debug(`content-hash index: loaded ${this.hashes.size} hashes`);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      log.debug("content-hash index: no existing index — starting fresh");
    }
  }

  /** Check if content already exists in the index. */
  has(content: string): boolean {
    return this.hashes.has(ContentHashIndex.computeHash(content));
  }

  /** Add content hash to the index. */
  add(content: string): void {
    const hash = ContentHashIndex.computeHash(content);
    if (!this.hashes.has(hash)) {
      this.hashes.add(hash);
      this.dirty = true;
    }
  }

  get size(): number {
    return this.hashes.size;
  }

  /** Persist index to disk if changed. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeMaybeEncryptedFile(
      this.filePath,
      [...this.hashes].join("\n") + "\n",
      this.secureStoreWriteKeyProvider(),
      {},
      this.memoryDir,
    );
    this.dirty = false;
    log.debug(`content-hash index: saved ${this.hashes.size} hashes`);
  }

  /** Remove a hash from the index (used when archiving/deleting). */
  remove(content: string): void {
    const hash = ContentHashIndex.computeHash(content);
    if (this.hashes.delete(hash)) {
      this.dirty = true;
    }
  }

  /**
   * Remove a pre-computed SHA-256 hash directly from the index without
   * re-hashing.  Use this when the caller already holds the stored hash
   * (e.g. `memory.frontmatter.contentHash`) to avoid the double-hash bug
   * where `remove(hash)` would compute `hash(hash)` and never match the
   * entry.
   */
  removeByHash(hash: string): void {
    if (this.hashes.delete(hash)) {
      this.dirty = true;
    }
  }

  /**
   * Add a pre-computed SHA-256 hash directly to the index without re-hashing.
   * Use this when the caller already holds the stored hash
   * (e.g. `memory.frontmatter.contentHash`) so that the index records the raw
   * content hash rather than re-hashing the citation-annotated body.
   *
   * @internal Only called from `StorageManager.ensureFactHashIndexAuthoritative`.
   * Not part of the public API — prefer `add(content)` for external callers.
   */
  addByHash(hash: string): void {
    if (!this.hashes.has(hash)) {
      this.hashes.add(hash);
      this.dirty = true;
    }
  }

  /** Normalize content and compute SHA-256 hash. */
  static normalizeContent(content: string): string {
    return content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Normalize content and compute SHA-256 hash. */
  static computeHash(content: string): string {
    const normalized = ContentHashIndex.normalizeContent(content);
    return createHash("sha256").update(normalized).digest("hex");
  }
}

// ---------------------------------------------------------------------------
// Attribute normalization helper
// ---------------------------------------------------------------------------

/**
 * Render a structured-attributes map into a stable, canonical string fragment
 * suitable for appending to enriched memory content before hashing.
 *
 * Normalization rules:
 *   - Keys are trimmed and lowercased (values are trimmed but preserve case)
 *   - Key-value pairs are sorted alphabetically by normalized key
 *   - Pairs are joined with "; " and rendered as "key: value"
 *
 * Using this helper at BOTH the write path (enrichedContent) and the
 * dedup-lookup path (dedupContent) guarantees identical output regardless of
 * the insertion order or casing used by the caller.
 *
 * @example
 *   normalizeAttributePairs({ foo: "bar", BAZ: "qux" })
 *   // → "baz: qux; foo: bar"
 */
export function normalizeAttributePairs(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => [k.trim().toLowerCase(), v.trim()] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Entity file parsing / serialization (Knowledge Graph v7.0)
// ---------------------------------------------------------------------------

function parseEntityFrontmatter(
  raw: string,
): {
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
      synthesisStructuredFactCount: Number.isFinite(synthesisStructuredFactCount) ? synthesisStructuredFactCount : undefined,
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
  } = {},
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
      options.skipTimelineBullets === true
      && trimmed.startsWith("- ")
      && isEntitySynthesisTimelinePromotionBullet(trimmed.slice(2))
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

function parseEntityTimelineBullet(
  bullet: string,
  fallbackTimestamp: string,
): EntityTimelineEntry | null {
  const trimmed = bullet.trim();
  if (!trimmed) return null;

  let rest = trimmed;
  const entry: EntityTimelineEntry = {
    timestamp: trimmed.startsWith("[") ? "" : fallbackTimestamp,
    text: "",
  };
  const consumedMetadataSegments: string[] = [];
  let literalSingleSourceSegment: string | undefined;

  if (!trimmed.startsWith("[")) {
    entry.text = trimmed;
    return entry.text ? entry : null;
  }

  const firstEnd = trimmed.indexOf("]");
  if (firstEnd === -1) {
    entry.text = trimmed;
    return entry.text ? entry : null;
  }

  const firstToken = trimmed.slice(1, firstEnd).trim();
  const parsedTimestamp = Date.parse(firstToken);
  if (Number.isFinite(parsedTimestamp)) {
    entry.timestamp = firstToken || fallbackTimestamp;
    rest = trimmed.slice(firstEnd + 1).trimStart();
  }

  while (rest.startsWith("[")) {
    const end = findEntityTimelineTokenEnd(rest);
    if (end === -1) break;
    const rawSegment = rest.slice(0, end + 1);
    const token = rest.slice(1, end).trim();
    const equalsIdx = token.indexOf("=");
    if (equalsIdx === -1) {
      if (rest === trimmed) {
        entry.text = trimmed;
        return entry.text ? entry : null;
      }
      break;
    }
    const key = token.slice(0, equalsIdx).trim().toLowerCase();
    const value = unescapeEntityTimelineMetadataValue(token.slice(equalsIdx + 1).trim());
    if (!value) break;
    const nextRest = rest.slice(end + 1).trimStart();
    switch (key) {
      case "source_meta":
        entry.source = value;
        break;
      case "source":
        if (
          consumedMetadataSegments.length === 0
          && !nextRest.startsWith("[")
          && nextRest.length > 0
          && !isManagedEntityTimelineSource(value)
        ) {
          literalSingleSourceSegment = rawSegment;
          rest = nextRest;
          break;
        }
        entry.source = value;
        break;
      case "session":
      case "sessionkey":
        entry.sessionKey = value;
        break;
      case "principal":
        entry.principal = value;
        break;
      default:
        entry.text = rest.trim();
        return entry.text ? entry : null;
    }
    if (literalSingleSourceSegment) break;
    consumedMetadataSegments.push(rawSegment);
    rest = nextRest;
  }

  if (literalSingleSourceSegment) {
    return {
      timestamp: entry.timestamp,
      text: `${literalSingleSourceSegment} ${rest}`.trim(),
    };
  }

  entry.text = rest.trim();
  if (!entry.text) return null;
  return entry;
}

function isEntitySynthesisTimelinePromotionBullet(bullet: string): boolean {
  const trimmed = bullet.trim();
  if (!trimmed.startsWith("[")) return false;

  const firstEnd = findEntityTimelineTokenEnd(trimmed);
  if (firstEnd === -1) return false;

  const firstToken = trimmed.slice(1, firstEnd).trim();
  return looksLikeEntityTimelineTimestamp(firstToken);
}

function looksLikeEntityTimelineTimestamp(token: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(token)) return false;
  return Number.isFinite(Date.parse(token));
}

function isManagedEntityTimelineSource(source: string): boolean {
  switch (source.trim().toLowerCase()) {
    case "artifact":
    case "chunking":
    case "cli-migrate":
    case "compounding-promotion":
    case "consolidation":
    case "contradiction-detection":
    case "entity_extraction":
    case "explicit":
    case "explicit-inline":
    case "explicit-inline-review":
    case "explicit-review":
    case "extraction":
    case "extraction-shared-promotion":
    case "manual":
    case "migration":
    case "migration-rechunk":
    case "proactive":
    case "replay":
    case "semantic-consolidation":
    case "unknown":
      return true;
    default:
      return false;
  }
}

function findEntityTimelineTokenEnd(input: string): number {
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "]") return index;
  }
  return -1;
}

function escapeEntityTimelineMetadataValue(value: string): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        escaped += "\\\\";
        break;
      case "]":
        escaped += "\\]";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      default: {
        const codePoint = char.codePointAt(0) ?? 0;
        if (codePoint < 0x20) {
          escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
        } else {
          escaped += char;
        }
      }
    }
  }
  return escaped;
}

function unescapeEntityTimelineMetadataValue(value: string): string {
  if (!value.includes("\\")) return value;

  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      continue;
    }

    const next = value[index + 1];
    if (!next) {
      result += "\\";
      break;
    }

    switch (next) {
      case "n":
        result += "\n";
        index += 1;
        break;
      case "r":
        result += "\r";
        index += 1;
        break;
      case "t":
        result += "\t";
        index += 1;
        break;
      case "u": {
        const hex = value.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16));
          index += 5;
          break;
        }
        result += "u";
        index += 1;
        break;
      }
      default:
        result += next;
        index += 1;
        break;
    }
  }
  return result;
}

function serializeEntityTimelineEntry(entry: EntityTimelineEntry): string {
  const tokens: string[] = [];
  if (entry.timestamp.trim().length > 0) {
    tokens.push(`[${entry.timestamp}]`);
  }
  if (entry.source) {
    const sourceKey = isManagedEntityTimelineSource(entry.source) ? "source" : "source_meta";
    tokens.push(`[${sourceKey}=${escapeEntityTimelineMetadataValue(entry.source)}]`);
  }
  if (entry.sessionKey) {
    tokens.push(`[session=${escapeEntityTimelineMetadataValue(entry.sessionKey)}]`);
  }
  if (entry.principal) {
    tokens.push(`[principal=${escapeEntityTimelineMetadataValue(entry.principal)}]`);
  }
  const serializedMetadata = tokens.length > 0 ? `${tokens.join(" ")} ` : "";
  return `- ${serializedMetadata}${entry.text}`.trimEnd();
}

function dedupeEntityTimelineFacts(timeline: EntityTimelineEntry[]): string[] {
  return [...new Set(
    timeline
      .map((entry) => entry.text.trim())
      .filter((entry) => entry.length > 0),
  )];
}

function normalizeEntitySectionFact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeStructuredSectionFacts(facts: string[]): string[] {
  return [...new Set(
    facts
      .map((fact) => normalizeEntitySectionFact(fact))
      .filter((fact) => fact.length > 0),
  )];
}

function collectStructuredSectionFacts(structuredSections: EntityStructuredSection[]): string[] {
  const facts: string[] = [];
  for (const section of structuredSections) {
    for (const fact of section.facts) {
      const normalized = normalizeEntitySectionFact(fact);
      if (!normalized) continue;
      facts.push(normalized);
    }
  }
  return [...new Set(facts)];
}

function compileEntityFacts(
  timeline: EntityTimelineEntry[],
  structuredSections: EntityStructuredSection[],
): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const fact of dedupeEntityTimelineFacts(timeline)) {
    if (seen.has(fact)) continue;
    seen.add(fact);
    facts.push(fact);
  }
  for (const fact of collectStructuredSectionFacts(structuredSections)) {
    if (seen.has(fact)) continue;
    seen.add(fact);
    facts.push(fact);
  }
  return facts;
}

function parseEntityStructuredSectionFacts(lines: string[]): string[] {
  const facts: string[] = [];
  let currentBlock: string[] = [];

  const flushCurrentBlock = (): void => {
    const normalized = normalizeEntitySectionFact(currentBlock.join(" "));
    if (normalized.length > 0) facts.push(normalized);
    currentBlock = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushCurrentBlock();
      continue;
    }
    if (line.startsWith("- ")) {
      flushCurrentBlock();
      currentBlock = [line.slice(2).trim()];
      continue;
    }
    currentBlock.push(line);
  }

  flushCurrentBlock();
  return [...new Set(facts)];
}

function looksLikeStructuredSectionFactList(lines: string[]): boolean {
  const firstNonBlank = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  return firstNonBlank.startsWith("- ");
}

function partitionEntityStructuredSections(
  entityType: string,
  extraSections: Array<{ title: string; lines: string[] }>,
  entitySchemas?: PluginConfig["entitySchemas"],
): {
  structuredSections: EntityStructuredSection[];
  remainingExtraSections: Array<{ title: string; lines: string[] }>;
} {
  const structuredSections: EntityStructuredSection[] = [];
  const remainingExtraSections: Array<{ title: string; lines: string[] }> = [];
  const structuredSectionIndex = new Map<string, EntityStructuredSection>();

  for (const section of extraSections) {
    const matchedSection = matchEntitySchemaSection(entityType, section.title, entitySchemas);
    if (!matchedSection && !looksLikeStructuredSectionFactList(section.lines)) {
      remainingExtraSections.push(section);
      continue;
    }
    const facts = parseEntityStructuredSectionFacts(section.lines);
    if (!matchedSection && facts.length === 0) {
      remainingExtraSections.push(section);
      continue;
    }
    const normalizedSection = matchedSection
      ? { key: matchedSection.key, title: matchedSection.title }
      : normalizeEntityStructuredSection(
        entityType,
        { key: section.title, title: section.title },
        entitySchemas,
      );
    if (facts.length === 0) {
      remainingExtraSections.push(section);
      continue;
    }
    const existing = structuredSectionIndex.get(normalizedSection.key);
    if (existing) {
      existing.facts = normalizeStructuredSectionFacts([...existing.facts, ...facts]);
      continue;
    }
    const structuredSection: EntityStructuredSection = {
      key: normalizedSection.key,
      title: normalizedSection.title,
      facts: normalizeStructuredSectionFacts(facts),
    };
    structuredSections.push(structuredSection);
    structuredSectionIndex.set(normalizedSection.key, structuredSection);
  }

  return {
    structuredSections,
    remainingExtraSections,
  };
}

function latestEntityTimelineTimestamp(entity: EntityFile): string | undefined {
  let latestRaw: string | undefined;
  for (const entry of entity.timeline) {
    const timestamp = entry.timestamp.trim();
    if (!timestamp) continue;
    if (!latestRaw || compareEntityTimestamps(timestamp, latestRaw) > 0) {
      latestRaw = timestamp;
    }
  }
  return latestRaw;
}

export function compareEntityTimestamps(left?: string, right?: string): number {
  const leftValue = left?.trim() ?? "";
  const rightValue = right?.trim() ?? "";

  if (!leftValue && !rightValue) return 0;
  if (!leftValue) return -1;
  if (!rightValue) return 1;

  const leftMs = Date.parse(leftValue);
  const rightMs = Date.parse(rightValue);
  const leftParsed = Number.isFinite(leftMs);
  const rightParsed = Number.isFinite(rightMs);

  if (leftParsed && rightParsed) {
    if (leftMs === rightMs) return 0;
    return leftMs > rightMs ? 1 : -1;
  }
  if (leftParsed) return 1;
  if (rightParsed) return -1;
  return leftValue.localeCompare(rightValue);
}

function countEntityStructuredFacts(entity: EntityFile): number {
  return (entity.structuredSections ?? []).reduce((count, section) => count + section.facts.length, 0);
}

export function fingerprintEntityStructuredFacts(entity: Pick<EntityFile, "structuredSections">): string | undefined {
  const normalizedSections = (entity.structuredSections ?? [])
    .map((section) => ({
      key: section.key.trim().toLowerCase(),
      title: section.title.replace(/\s+/g, " ").trim(),
      facts: normalizeStructuredSectionFacts(section.facts).slice().sort((left, right) => left.localeCompare(right)),
    }))
    .filter((section) => section.facts.length > 0)
    .sort((left, right) =>
      left.key.localeCompare(right.key)
      || left.title.localeCompare(right.title)
      || left.facts.join("\n").localeCompare(right.facts.join("\n")));
  if (normalizedSections.length === 0) return undefined;
  return createHash("sha256").update(JSON.stringify(normalizedSections)).digest("hex");
}

export function isEntitySynthesisStale(entity: EntityFile): boolean {
  const structuredFactCount = countEntityStructuredFacts(entity);
  const structuredFactDigest = fingerprintEntityStructuredFacts(entity);
  const storedStructuredFactDigest = entity.synthesisStructuredFactDigest?.trim() || undefined;
  if (entity.timeline.length === 0 && structuredFactCount === 0) return false;
  if (!entity.synthesis?.trim()) return true;
  if (entity.synthesisTimelineCount === undefined) return true;
  if (structuredFactCount > 0 && entity.synthesisStructuredFactCount === undefined) return true;
  if (structuredFactCount > 0 && !storedStructuredFactDigest) return true;
  const latestTimelineTimestamp = latestEntityTimelineTimestamp(entity);
  if (!latestTimelineTimestamp) {
    return entity.timeline.length > entity.synthesisTimelineCount
      || structuredFactCount > (entity.synthesisStructuredFactCount ?? 0)
      || structuredFactDigest !== storedStructuredFactDigest;
  }
  if (!entity.synthesisUpdatedAt?.trim()) return true;
  const timelineFreshness = compareEntityTimestamps(latestTimelineTimestamp, entity.synthesisUpdatedAt);
  if (timelineFreshness > 0) return true;
  return entity.timeline.length > entity.synthesisTimelineCount
    || structuredFactCount > (entity.synthesisStructuredFactCount ?? 0)
    || structuredFactDigest !== storedStructuredFactDigest;
}

/**
 * Parse an entity markdown file into a structured EntityFile.
 * Backward compatible: old files without new sections get empty arrays.
 */
export function parseEntityFile(
  content: string,
  entitySchemas?: PluginConfig["entitySchemas"],
): EntityFile {
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
  const preSectionCandidates = firstSectionIndex > -1
    ? lines.slice(preSectionStartIndex, firstSectionIndex)
    : lines.slice(preSectionStartIndex);
  const preSectionLines = preSectionCandidates.filter(
    (line) => !line.startsWith("**Type:**") && !line.startsWith("**Updated:**"),
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
        const parsed = parseEntityTimelineBullet(
          bullet,
          fallbackTimestamp,
        );
        if (parsed) timeline.push(parsed);
        break;
      }
      case "summary":
      case "synthesis":
        if (isEntitySynthesisTimelinePromotionBullet(bullet)) {
          const parsed = parseEntityTimelineBullet(
            bullet,
            fallbackTimestamp,
          );
          if (parsed) timeline.push(parsed);
        }
        // Summary/synthesis is typically a paragraph after the heading, not a bullet.
        break;
      case "connected to": {
        // Format: [[target-entity]] — relationship label
        const relMatch = bullet.match(/^\[\[([^\]]+)\]\]\s*[—–-]\s*(.+)$/);
        if (relMatch) {
          relationships.push({ target: relMatch[1].trim(), label: relMatch[2].trim() });
        }
        break;
      }
      case "activity": {
        // Format: YYYY-MM-DD: note
        const actMatch = bullet.match(/^(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
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
      timeline
        .map((entry) => entry.text.trim())
        .filter((entry) => entry.length > 0),
    );
    for (const fact of legacyFactTimelineEntries) {
      const normalizedFact = fact.text.trim();
      if (!normalizedFact || existingTimelineFacts.has(normalizedFact)) continue;
      timeline.push(fact);
      existingTimelineFacts.add(normalizedFact);
    }
  }

  const synthesis =
    readEntitySectionText(lines, ["Synthesis"], { preserveBullets: true, skipTimelineBullets: true })
    ?? readEntitySectionText(lines, ["Summary"], { preserveBullets: true, skipTimelineBullets: true });
  const synthesisUpdatedAt = frontmatter.synthesisUpdatedAt || undefined;
  const synthesisTimelineCount = frontmatter.synthesisTimelineCount;
  const synthesisStructuredFactCount = frontmatter.synthesisStructuredFactCount;
  const synthesisStructuredFactDigest = frontmatter.synthesisStructuredFactDigest;
  const { structuredSections, remainingExtraSections } = partitionEntityStructuredSections(
    type,
    extraSections,
    entitySchemas,
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
export function serializeEntityFile(
  entity: EntityFile,
  entitySchemas?: PluginConfig["entitySchemas"],
): string {
  const synthesis = entity.synthesis || entity.summary || "";
  const created = entity.created?.trim() || entity.updated || new Date().toISOString();
  const updated = entity.updated || created;
  const timeline = entity.timeline;
  const structuredSections = sortStructuredSectionsBySchema(
    entity.type,
    (entity.structuredSections ?? []).map((section) => ({
      ...section,
      facts: normalizeStructuredSectionFacts(section.facts),
    })).filter((section) => section.facts.length > 0),
    entitySchemas,
  );
  const sectionFacts = new Set(collectStructuredSectionFacts(structuredSections));
  const legacyFacts = timeline.length === 0
    ? [...new Set(
      entity.facts
        .map((fact) => normalizeEntitySectionFact(fact))
        .filter((fact) => fact.length > 0 && !sectionFacts.has(fact)),
    )]
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
    ...(synthesisTimelineCount === undefined
      ? []
      : [`synthesis_timeline_count: ${synthesisTimelineCount}`]),
    ...(synthesisStructuredFactCount === undefined
      ? []
      : [`synthesis_structured_fact_count: ${synthesisStructuredFactCount}`]),
    ...(synthesisStructuredFactDigest
      ? [`synthesis_structured_fact_digest: "${synthesisStructuredFactDigest}"`]
      : []),
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

function buildEntitySchemaCacheKey(entitySchemas?: PluginConfig["entitySchemas"]): string {
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
function isValidBufferSurpriseEvent(value: unknown): value is BufferSurpriseEvent {
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

export class StorageManager {
  private knowledgeIndexCache: { result: string; builtAt: number } | null = null;
  private static readonly KNOWLEDGE_INDEX_CACHE_TTL_MS = 600_000; // 10 minutes (entity mutations invalidate)
  private artifactIndexCache: { memories: MemoryFile[]; loadedAtMs: number; writeVersion: number } | null = null;
  private static readonly ARTIFACT_INDEX_CACHE_TTL_MS = 60_000; // 1 minute
  private static readonly artifactWriteVersionByDir = new Map<string, number>();
  private static readonly memoryStatusVersionByDir = new Map<string, number>();
  private static readonly secureStoreEntityCacheKeyIds = new WeakMap<Buffer, number>();
  private static nextSecureStoreEntityCacheKeyId = 1;
  // In-process fallback for the cold-write sentinel (used when the disk file
  // is not accessible).  The canonical source of truth is state/cold-write.log.
  private static readonly coldWriteVersionByDir = new Map<string, number>();

  // Module-level cache for readAllMemories() keyed by base directory.
  // Shared across all StorageManager instances to avoid duplicate I/O when
  // multiple concurrent callers (e.g. verifiedRecall + verifiedRules) read the
  // same directory simultaneously.  In-flight deduplication prevents multiple
  // concurrent reads of the same directory.
  //
  // Stale-while-revalidate: once the cache has a value, subsequent reads after
  // TTL expiry return the stale cached data immediately and kick off a background
  // refresh.  This eliminates the 13-60 s cold-scan penalty that would otherwise
  // block recall requests every 5 minutes on large memory collections (80k+ files).
  private static readonly allMemoriesInFlight = new Map<string, Promise<MemoryFile[]>>();

  // Cache for readAllColdMemories() — keyed by cold root directory path.
  // Prevents an uncached full-tree directory scan on every structured-attribute
  // write (Finding UOGi, PR #402 round-6).  The cache is only invalidated when
  // cold-tier content actually changes (via invalidateColdMemoriesCache), NOT
  // on every hot-tier write.  It also expires after COLD_SCAN_CACHE_TTL_MS as
  // a safety net.
  //
  // Finding UvUy (PR #402 round-11): cache entries now carry a `coldVersion`
  // sentinel that is bumped (via a file-size counter in state/cold-write.log)
  // on every write that modifies cold-tier content.  Before serving a cached
  // result, readAllColdMemories() reads the sentinel from disk and compares.
  // If they differ the entry is dropped and the cold tree is re-scanned.  This
  // makes the cache correct across process boundaries (gateway + CLI): a second
  // process that writes a new cold memory bumps the sentinel on disk, so the
  // first process's next readAllColdMemories() sees the change within one call
  // (rather than waiting up to 30s for TTL expiry).
  //
  // After Finding UTsP broadened readAllColdMemories to scan the entire cold/
  // subtree (not just facts/+corrections/), amortizing this I/O across
  // back-to-back writes in the same burst is even more important.
  private static readonly COLD_SCAN_CACHE_TTL_MS = 30_000; // 30 seconds
  private static readonly coldMemoriesCache = new Map<string, { memories: MemoryFile[]; loadedAt: number; coldVersion: number }>();

  // Cache for readQuestions() — avoids serially re-reading tens of thousands of
  // question files on every recall.  60-second TTL is intentionally short so that
  // newly written questions surface quickly.
  private static readonly QUESTIONS_CACHE_TTL_MS = 60_000; // 1 minute
  private static readonly questionsCache = new Map<
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
  private factHashIndexAuthoritativePromise: Promise<void> | null = null;
  private readonly secureAppendChains = new Map<string, Promise<void>>();
  /** Optional: set by the orchestrator after construction to enable template-aware citation stripping during legacy hash rebuild. */
  citationTemplate: string = DEFAULT_CITATION_FORMAT;

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
   * from `config.secureStoreEnabled`.
   */
  private _secureStoreRequired = false;

  /**
   * Set or clear the at-rest encryption key.
   *
   * Pass a 32-byte Buffer to enable encryption; pass null to clear
   * (lock) the store.  The caller is responsible for key lifecycle —
   * this method does not zero the buffer on replacement; the keyring
   * module (`keyring.ts`) owns zeroization.
   */
  setSecureStoreKey(key: Buffer | null, encryptOnWrite = true): void {
    this._secureStoreKey = key;
    this._secureStoreEncryptOnWrite = encryptOnWrite;
    invalidateCachedEntities(this.baseDir);
    this.invalidateKnowledgeIndexCache();
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

  /**
   * Resolve the effective write key.
   *
   * - If `_secureStoreEncryptOnWrite` is false: returns null (plain write).
   * - If `_secureStoreEncryptOnWrite` is true AND key is set: returns key.
   * - If `_secureStoreEncryptOnWrite` is true AND key is null AND
   *   `_secureStoreRequired` is true: throws SecureStoreLockedError so the
   *   write fails loudly rather than silently writing plaintext (P1 finding
   *   from Cursor review of PR #767).
   * - If `_secureStoreEncryptOnWrite` is true AND key is null AND
   *   `_secureStoreRequired` is false: returns null (unencrypted store).
   */
  private resolveWriteKey(): Buffer | null {
    if (!this._secureStoreEncryptOnWrite) return null;
    if (this._secureStoreKey !== null) return this._secureStoreKey;
    if (this._secureStoreRequired) {
      throw new SecureStoreLockedError(
        "secure-store is locked — cannot write memory file. " +
          "Run `remnic secure-store unlock` to decrypt, or restart the daemon after unlocking.",
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
        this.baseDir,
      );
      const rel = path.relative(this.baseDir, filePath).split(path.sep).join("/");
      return `${rel}:${version.versionId}`;
    } catch (err) {
      log.warn(
        `storage.snapshotForProvenance: failed to snapshot ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  constructor(
    private readonly baseDir: string,
    private readonly entitySchemas?: PluginConfig["entitySchemas"],
  ) {}

  /** The root directory of this storage instance. */
  get dir(): string {
    return this.baseDir;
  }

  private identityFilePath(workspaceDir: string, namespace?: string): string {
    const rawNamespace = typeof namespace === "string" ? namespace.trim() : "";
    if (!rawNamespace) return path.join(workspaceDir, "IDENTITY.md");
    const safeNamespace = rawNamespace.replace(/[^a-zA-Z0-9._-]/g, "-");
    return path.join(workspaceDir, `IDENTITY.${safeNamespace}.md`);
  }

  private versionFilePath(kind: "memory-status" | "artifact-write" | "cold-write"): string {
    const fileName =
      kind === "memory-status"
        ? ".memory-status-version.log"
        : kind === "artifact-write"
          ? ".artifact-write-version.log"
          : ".cold-write-version.log";
    return path.join(this.stateDir, fileName);
  }

  private bumpSharedVersion(
    kind: "memory-status" | "artifact-write" | "cold-write",
    fallbackMap: Map<string, number>,
  ): number {
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

  private readSharedVersion(
    kind: "memory-status" | "artifact-write" | "cold-write",
    fallbackMap: Map<string, number>,
  ): number {
    const filePath = this.versionFilePath(kind);
    try {
      return statSync(filePath).size;
    } catch {
      return fallbackMap.get(this.baseDir) ?? 0;
    }
  }

  private bumpMemoryStatusVersion(): void {
    this.bumpSharedVersion("memory-status", StorageManager.memoryStatusVersionByDir);
  }

  getMemoryStatusVersion(): number {
    return this.readSharedVersion("memory-status", StorageManager.memoryStatusVersionByDir);
  }

  private bumpArtifactWriteVersion(): number {
    return this.bumpSharedVersion("artifact-write", StorageManager.artifactWriteVersionByDir);
  }

  private getArtifactWriteVersion(): number {
    return this.readSharedVersion("artifact-write", StorageManager.artifactWriteVersionByDir);
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
  private readStorageSecureFile(filePath: string): Promise<string> {
    return readMaybeEncryptedFile(filePath, this._secureStoreKey, this.baseDir);
  }
  private writeStorageSecureFile(filePath: string, content: string): Promise<void> {
    return writeMaybeEncryptedFile(filePath, content, this.resolveWriteKey(), {}, this.baseDir);
  }
  createContentHashIndex(): ContentHashIndex {
    return new ContentHashIndex(
      this.stateDir,
      () => this._secureStoreKey,
      () => this.resolveWriteKey(),
      this.baseDir,
    );
  }

  private async appendStorageSecureFile(filePath: string, content: string): Promise<void> {
    const previous = this.secureAppendChains.get(filePath) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.appendStorageSecureFileUnlocked(filePath, content));
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

  private async appendStorageSecureFileUnlocked(filePath: string, content: string): Promise<void> {
    const writeKey = this.resolveWriteKey();
    await mkdir(path.dirname(filePath), { recursive: true });
    if (writeKey === null) {
      try {
        if (isEncryptedFile(await readFile(filePath))) {
          const existing = await this.readStorageSecureFile(filePath);
          await writeMaybeEncryptedFile(filePath, `${existing}${content}`, null, {}, this.baseDir);
          return;
        }
      } catch (err) {
        if (!isErrnoCode(err, "ENOENT")) throw err;
      }
      await appendFile(filePath, content, "utf-8");
      return;
    }

    let existing = "";
    try {
      existing = await this.readStorageSecureFile(filePath);
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
    }
    await writeMaybeEncryptedFile(filePath, `${existing}${content}`, writeKey, {}, this.baseDir);
  }
  private get stateDir(): string {
    return path.join(this.baseDir, "state");
  }
  private get entitySynthesisQueuePath(): string {
    return path.join(this.stateDir, "entity-synthesis-queue.json");
  }
  private get factHashIndexReadyPath(): string {
    return path.join(this.stateDir, "fact-hashes.ready");
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

  private async ensureFactHashIndexAuthoritative(): Promise<void> {
    if (this.factHashIndexAuthoritative === true) {
      return;
    }
    if (this.factHashIndexAuthoritativePromise) {
      await this.factHashIndexAuthoritativePromise;
      return;
    }

    this.factHashIndexAuthoritativePromise = (async () => {
      try {
        await access(this.factHashIndexReadyPath);
        this.factHashIndexAuthoritative = true;
        return;
      } catch {
        // Fall through and backfill from the live fact corpus once.
      }

      const factHashIndex = await this.getFactHashIndex();
      const existing = await this.readAllMemories();
      let legacyRecovered = 0;
      for (const memory of existing) {
        if (memory.frontmatter.category !== "fact") continue;
        if (inferMemoryStatus(memory.frontmatter, memory.path) !== "active") continue;
        // Prefer the pre-computed raw-content hash stored in frontmatter
        // (written since round 8 of issue #369). This hash was derived from
        // the content BEFORE citation annotation, so it matches what
        // hasFactContentHash(rawFact) would compute.
        if (memory.frontmatter.contentHash) {
          factHashIndex.addByHash(memory.frontmatter.contentHash);
          continue;
        }
        // Legacy fact written before contentHash was introduced (Finding 1 —
        // Uhol). Apply nuanced handling based on whether the citation can be
        // reliably stripped:
        //
        //  1. Default citation present → strip it and index the raw body.
        //  2. No citation at all → index the raw body as-is.
        //  3. Unknown/custom citation template → skip with a warning.
        //
        // Rationale for (3): for facts annotated with a custom citation
        // template, stripCitationForTemplate cannot reliably detect the inline
        // marker and would hash the cited body — producing a hash that never
        // matches what hasFactContentHash(rawContent) computes. A
        // false-negative miss (the fact is not in the index) is preferable to
        // a wrong index entry that permanently suppresses legitimate duplicate
        // writes.
        //
        // Limitation (Thread 2 — stale hash): even when contentHash IS present
        // it may be stale if updateMemory() rewrote the body without updating
        // the frontmatter hash. The hash is trusted as-is here; a future
        // migration pass can recompute it from the current content.
        const content = memory.content;
        // Use the configured template (Thread 1 fix): citationTemplate is set
        // by the orchestrator to the active inlineSourceAttributionFormat so
        // the rebuild can strip both the default and any custom template.
        // Falls back to DEFAULT_CITATION_FORMAT when the orchestrator has not
        // configured a custom template (e.g. direct StorageManager construction
        // in tests).
        const stripped = stripCitationForTemplate(content, this.citationTemplate);
        if (stripped !== content) {
          // Citation was stripped — index the bare body.
          factHashIndex.addByHash(
            ContentHashIndex.computeHash(sanitizeMemoryContent(stripped).text),
          );
          continue;
        }
        // No citation was removed. Decide whether to index or skip.
        // Thread 4 fix: use hasCitation() rather than the too-broad endsWith("]")
        // heuristic. Facts that legitimately end with "]" (e.g. "User prefers
        // [dark mode]") have no citation marker and should be indexed as-is.
        // Only skip when hasCitation() confirms a citation is present — that
        // means the citation is from an unknown/custom template we cannot strip.
        if (!hasCitation(content)) {
          // Content has no recognisable citation marker — index raw body.
          factHashIndex.addByHash(
            ContentHashIndex.computeHash(sanitizeMemoryContent(content).text),
          );
          continue;
        }
        // Content carries a citation from an unknown/custom template
        // that we cannot safely strip. Skip rather than index a wrong hash.
        legacyRecovered++;
        continue;
      }
      if (legacyRecovered > 0) {
        log.info(
          `ensureFactHashIndexAuthoritative: skipped ${legacyRecovered} legacy fact(s) with no contentHash in frontmatter`,
        );
      }
      await factHashIndex.save();
      await mkdir(path.dirname(this.factHashIndexReadyPath), { recursive: true });
      await writeFile(this.factHashIndexReadyPath, "v1\n", "utf-8");
      this.factHashIndexAuthoritative = true;
    })().finally(() => {
      this.factHashIndexAuthoritativePromise = null;
    });
    await this.factHashIndexAuthoritativePromise;
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
   * Load user-defined entity aliases from config/aliases.json in the memory store.
   * File format: { "variant": "canonical", "variant2": "canonical", ... }
   * Call this once at startup (e.g. from orchestrator.initialize()).
   */
  async loadAliases(): Promise<void> {
    const aliasPath = path.join(this.baseDir, "config", "aliases.json");
    try {
      const raw = await readFile(aliasPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        userAliases = parsed as Record<string, string>;
        log.debug(`loaded ${Object.keys(userAliases).length} entity aliases from ${aliasPath}`);
      }
    } catch {
      // No aliases file — that's fine, use built-in only
      log.debug("no config/aliases.json found — using built-in aliases only");
    }
  }

  async ensureDirectories(): Promise<void> {
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
  }

  async writeMemory(
    category: MemoryCategory,
    content: string,
    options: {
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
    } = {},
  ): Promise<string> {
    await this.ensureDirectories();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const id = `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const conf = options.confidence ?? 0.8;
    const tier = confidenceTier(conf);
    const validAt = normalizeMemoryWriteTimestamp("validAt", options.validAt);

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

    // Append structured attributes as searchable suffix so QMD indexes them.
    // normalizeAttributePairs sorts and lowercases keys so the enriched content
    // is stable regardless of the insertion order or key casing supplied by the
    // caller — this must stay in sync with the dedupContent built in the
    // orchestrator's hash-dedup path.
    let enrichedContent = content;
    if (options.structuredAttributes && Object.keys(options.structuredAttributes).length > 0) {
      enrichedContent = `${content}\n[Attributes: ${normalizeAttributePairs(options.structuredAttributes)}]`;
    }

    const sanitized = sanitizeMemoryContent(enrichedContent);
    if (!sanitized.clean) {
      log.warn(`memory content sanitized for ${id}; violations=${sanitized.violations.join(", ")}`);
    }

    // Persist the raw-content dedup hash on the frontmatter so archive and
    // consolidation paths can remove the correct hash from ContentHashIndex
    // regardless of what citation format (if any) has been appended to the
    // stored body. Mirrors the logic in the fact-hash-index update below.
    if (category === "fact") {
      const hashSource =
        options.contentHashSource !== undefined && options.contentHashSource.length > 0
          ? sanitizeMemoryContent(options.contentHashSource).text
          : sanitized.text;
      fm.contentHash = ContentHashIndex.computeHash(hashSource);
    }

    const fileContent = `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`;

    let filePath: string;
    if (category === "correction") {
      filePath = path.join(this.correctionsDir, `${id}.md`);
    } else if (category === "procedure") {
      await mkdir(path.join(this.proceduresDir, today), { recursive: true });
      filePath = path.join(this.proceduresDir, today, `${id}.md`);
    } else if (category === "reasoning_trace") {
      // Issue #564 PR 3: reasoning traces live in their own subtree so recall
      // can filter on path cheaply without parsing frontmatter.
      await mkdir(path.join(this.reasoningTracesDir, today), { recursive: true });
      filePath = path.join(this.reasoningTracesDir, today, `${id}.md`);
    } else {
      filePath = path.join(this.factsDir, today, `${id}.md`);
    }

    await this.snapshotBeforeWrite(filePath, "write");
    await writeMaybeEncryptedFile(filePath, fileContent, this.resolveWriteKey(), {}, this.baseDir);
    this.invalidateAllMemoriesCache();
    await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.writeMemory", {
      memoryId: id,
      eventType: "created",
      timestamp: fm.created,
      actor: options.actor ?? "storage.writeMemory",
      after: this.summarizeLifecycleState(fm, filePath),
      relatedMemoryIds: [
        ...(options.supersedes ? [options.supersedes] : []),
        ...((options.lineage ?? []).filter(Boolean)),
      ],
    });
    if (category === "fact") {
      try {
        const factHashIndex = await this.getFactHashIndex();
        // When the caller provides a separate contentHashSource (e.g. the raw
        // fact text before citation annotation), index THAT string so that
        // hasFactContentHash(rawFact) returns true on subsequent extractions.
        // Otherwise fall back to the sanitized persisted body as before.
        if (options.contentHashSource !== undefined && options.contentHashSource.length > 0) {
          const hashSourceSanitized = sanitizeMemoryContent(options.contentHashSource);
          factHashIndex.add(hashSourceSanitized.text);
        } else {
          factHashIndex.add(sanitized.text);
        }
        await factHashIndex.save();
      } catch (err) {
        log.warn(`storage.writeMemory completed but failed to update fact hash index: ${err}`);
      }
    }
    log.debug(`wrote memory ${id} to ${filePath}`);
    return id;
  }

  async hasFactContentHash(content: string): Promise<boolean> {
    await this.ensureFactHashIndexAuthoritative();
    const factHashIndex = await this.getFactHashIndex();
    const sanitized = sanitizeMemoryContent(content);
    return factHashIndex.has(sanitized.text);
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

  async removeFactContentHashesForMemories(memories: MemoryFile[]): Promise<void> {
    await this.ensureFactHashIndexAuthoritative();
    const factHashIndex = await this.getFactHashIndex();
    const removedIds = new Set(
      memories
        .map((memory) => memory.frontmatter.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
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
    const remainingMemories = [
      ...await this.readAllMemories(),
      ...await this.readAllColdMemories(),
    ];
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
      }
    }
    await factHashIndex.save();
  }

  async isFactContentHashAuthoritative(): Promise<boolean> {
    await this.ensureFactHashIndexAuthoritative();
    return true;
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
    } = {},
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
    };

    const sanitized = sanitizeMemoryContent(quote);
    if (!sanitized.clean) {
      log.warn(`artifact content rejected for ${id}; violations=${sanitized.violations.join(", ")}`);
      return "";
    }
    const filePath = path.join(dir, `${id}.md`);
    await writeMaybeEncryptedFile(filePath, `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`, this.resolveWriteKey(), {}, this.baseDir);
    const actor =
      typeof options.actor === "string" && options.actor.length > 0
        ? options.actor
        : "storage.writeArtifact";
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
    if (
      this.artifactIndexCache &&
      Date.now() - this.artifactIndexCache.loadedAtMs <= StorageManager.ARTIFACT_INDEX_CACHE_TTL_MS &&
      this.artifactIndexCache.writeVersion === this.getArtifactWriteVersion()
    ) {
      return this.artifactIndexCache.memories;
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
            const memory = await this.readMemoryByPath(fullPath);
            if (!memory) continue;
            artifacts.push(memory);
          }
        } catch {
          // Directory doesn't exist yet
        }
      };
      await readDir(this.artifactsDir);
      return artifacts;
    };

    const MAX_REBUILD_RETRIES = 2;
    let latestArtifacts: MemoryFile[] = [];
    for (let attempt = 0; attempt <= MAX_REBUILD_RETRIES; attempt += 1) {
      const versionBefore = this.getArtifactWriteVersion();
      const artifacts = await scanArtifacts();
      const versionAfter = this.getArtifactWriteVersion();
      latestArtifacts = artifacts;
      if (versionAfter === versionBefore) {
        this.artifactIndexCache = { memories: artifacts, loadedAtMs: Date.now(), writeVersion: versionAfter };
        return artifacts;
      }
    }

    // Highly concurrent writer churn; keep cache invalid so next read retries a clean rebuild.
    // Return best-effort latest scan instead of an empty set to avoid dropping recall entirely.
    this.artifactIndexCache = null;
    return latestArtifacts;
  }

  async searchArtifacts(query: string, maxResults: number): Promise<MemoryFile[]> {
    const tokens = tokenizeArtifactSearchText(query);
    if (tokens.length === 0) return [];

    const artifacts = await this.readAllArtifactsCached();
    const hits: Array<{ score: number; memory: MemoryFile }> = [];
    for (const memory of artifacts) {
      const indexedTokens = new Set(
        tokenizeArtifactSearchText(`${memory.content} ${(memory.frontmatter.tags ?? []).join(" ")}`),
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
    } = {},
  ): Promise<string> {
    await this.ensureDirectories();
    if (typeof name !== "string" || !name.trim() || typeof type !== "string" || !type.trim()) {
      log.warn("writeEntity: invalid entity payload, skipping", {
        nameType: typeof name,
        typeType: typeof type,
      });
      return "";
    }
    const safeFacts = Array.isArray(facts)
      ? [...new Set(
        facts
          .filter((fact) => typeof fact === "string")
          .map((fact) => fact.trim())
          .filter((fact) => fact.length > 0),
      )]
      : [];
    let normalized = normalizeEntityName(name, type);

    // Check for fuzzy match against existing entities before creating a new file
    const match = await this.findMatchingEntity(name, type);
    if (match && match !== normalized) {
      log.debug(`fuzzy match: "${normalized}" → existing "${match}"`);
      normalized = match;
    }

    const filePath = path.join(this.entitiesDir, `${normalized}.md`);

    // Parse existing file to preserve relationships/activity/aliases/summary
    let entity: EntityFile = {
      name,
      type,
      created: "",
      updated: new Date().toISOString(),
      facts: [],
      summary: undefined,
      synthesis: undefined,
      synthesisUpdatedAt: undefined,
      synthesisVersion: undefined,
      synthesisStructuredFactCount: undefined,
      synthesisStructuredFactDigest: undefined,
      timeline: [],
      relationships: [],
      activity: [],
      aliases: [],
    };
    try {
      const existing = await this.readStorageSecureFile(filePath);
      entity = parseEntityFile(existing, this.entitySchemas);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      // File doesn't exist yet
    }

    const timestamp = options.timestamp?.trim() || new Date().toISOString();
    const source = options.source?.trim() || undefined;
    const sessionKey = options.sessionKey?.trim() || undefined;
    const principal = options.principal?.trim() || undefined;
    const structuredSectionMap = new Map(
      (entity.structuredSections ?? []).map((section) => [section.key, {
        ...section,
        facts: [...section.facts],
      }]),
    );
    for (const section of options.structuredSections ?? []) {
      const normalizedSection = normalizeEntityStructuredSection(type, section, this.entitySchemas);
      const normalizedFacts = normalizeStructuredSectionFacts(section.facts);
      if (normalizedFacts.length === 0) continue;
      const existingSection = structuredSectionMap.get(normalizedSection.key);
      if (!existingSection) {
        structuredSectionMap.set(normalizedSection.key, {
          key: normalizedSection.key,
          title: normalizedSection.title,
          facts: normalizedFacts,
        });
        continue;
      }
      existingSection.facts = normalizeStructuredSectionFacts([...existingSection.facts, ...normalizedFacts]);
      if (!existingSection.title.trim() && normalizedSection.title.trim()) {
        existingSection.title = normalizedSection.title;
      }
    }
    for (const fact of safeFacts) {
      const nextEntry = {
        timestamp,
        text: fact,
        ...(source ? { source } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(principal ? { principal } : {}),
      };
      const alreadyPresent = entity.timeline.some((entry) =>
        entry.timestamp === nextEntry.timestamp
        && entry.text === nextEntry.text
        && entry.source === nextEntry.source
        && entry.sessionKey === nextEntry.sessionKey
        && entry.principal === nextEntry.principal
      );
      if (alreadyPresent) continue;
      entity.timeline.push(nextEntry);
    }
    entity.structuredSections = sortStructuredSectionsBySchema(
      type,
      Array.from(structuredSectionMap.values()).filter((section) => section.facts.length > 0),
      this.entitySchemas,
    );
    entity.facts = compileEntityFacts(entity.timeline, entity.structuredSections);
    entity.summary = entity.synthesis || entity.summary;
    entity.name = name;
    entity.type = type;
    entity.created = entity.created || timestamp;
    entity.updated = new Date().toISOString();

    await this.snapshotBeforeWrite(filePath, "write");
    await this.writeStorageSecureFile(filePath, serializeEntityFile(entity, this.entitySchemas));
    this.invalidateKnowledgeIndexCache();
    this.bumpMemoryStatusVersion(); // invalidate entity cache
    log.debug(`wrote entity ${normalized}`);
    return normalized;
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
    await this.ensureDirectories();
    await this.snapshotBeforeWrite(this.profilePath, "consolidation");
    await writeMaybeEncryptedFile(this.profilePath, content, this.resolveWriteKey(), {}, this.baseDir);
    log.debug("updated profile.md");
  }

  /**
   * Normalize a string for fuzzy profile dedup: lowercase, strip punctuation, collapse whitespace.
   */
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
    const existingBulletRaw = lines
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
    const existingNorms = existingBulletRaw.map(StorageManager.normalizeForDedup);

    const newBullets = updates.filter((u) => {
      const norm = StorageManager.normalizeForDedup(u);
      return !StorageManager.isFuzzyDuplicate(norm, existingNorms);
    });
    if (newBullets.length === 0) return;

    if (!existing) {
      const content = [
        "# Behavioral Profile",
        "",
        `*Last updated: ${new Date().toISOString()}*`,
        "",
        ...newBullets.map((b) => `- ${b}`),
        "",
      ].join("\n");
      await this.writeProfile(content);
    } else {
      const updatedTimestamp = existing.replace(
        /\*Last updated:.*\*/,
        `*Last updated: ${new Date().toISOString()}*`,
      );
      const withBullets = updatedTimestamp.trimEnd() + "\n" + newBullets.map((b) => `- ${b}`).join("\n") + "\n";
      await this.writeProfile(withBullets);
    }
  }

  /** Check if profile.md exceeds the max line cap and needs LLM consolidation */
  async profileNeedsConsolidation(triggerLines?: number): Promise<boolean> {
    const profile = await this.readProfile();
    if (!profile) return false;
    const lineCount = profile.split("\n").length;
    const threshold = typeof triggerLines === "number"
      ? Math.max(0, Math.floor(triggerLines))
      : StorageManager.PROFILE_MAX_LINES;
    return lineCount > threshold;
  }

  async readAllMemories(): Promise<MemoryFile[]> {
    // Deduplicate concurrent reads for the same directory so multiple
    // callers in the same recall share one disk scan.
    const inFlight = StorageManager.allMemoriesInFlight.get(this.baseDir);
    if (inFlight) return inFlight;

    const readPromise = this._readAllMemoriesFromDisk();
    StorageManager.allMemoriesInFlight.set(this.baseDir, readPromise);
    try {
      return await readPromise;
    } finally {
      // Only delete if we still own the slot — invalidateAllMemoriesCache()
      // may have already cleared it and a new read may have claimed it.
      if (StorageManager.allMemoriesInFlight.get(this.baseDir) === readPromise) {
        StorageManager.allMemoriesInFlight.delete(this.baseDir);
      }
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
    StorageManager.allMemoriesInFlight.clear();
    StorageManager.questionsCache.clear();
    StorageManager.coldMemoriesCache.clear(); // also wipe the cold-scan TTL cache
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
  private invalidateAllMemoriesCache(): void {
    StorageManager.allMemoriesInFlight.delete(this.baseDir);
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
  private invalidateColdMemoriesCache(): void {
    const coldRoot = path.join(this.baseDir, "cold");
    StorageManager.coldMemoriesCache.delete(coldRoot);
    this.bumpColdWriteVersion();
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

  private async collectActiveMemoryPaths(): Promise<string[]> {
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
        // Directory does not exist yet.
      }
    };

    await collectPaths(this.factsDir);
    await collectPaths(this.proceduresDir);
    await collectPaths(this.reasoningTracesDir);
    await collectPaths(this.correctionsDir);
    return filePaths;
  }

  private async readParsedMemoriesFromPaths(
    filePaths: string[],
    batchSize?: number,
  ): Promise<MemoryFile[]> {
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
            return {
              path: fullPath,
              frontmatter: normalizeFrontmatterForPath(
                parsed.frontmatter,
                toMemoryPathRel(this.baseDir, fullPath),
                parsed.content,
              ),
              content: parsed.content,
            } satisfies MemoryFile;
          } catch (err) {
            // Re-throw store-locked errors so a locked encrypted store fails
            // loudly rather than appearing as an empty memory corpus (Cursor
            // review finding, PR #767).
            if (err instanceof SecureStoreLockedError) throw err;
            return null;
          }
        }),
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
        frontmatterBlock.match(/^updated:\s*"?([^"\n]*)"?/m)?.[1]
        ?? frontmatterBlock.match(/^created:\s*"?([^"\n]*)"?/m)?.[1]
        ?? null;
      const updatedMs = rawUpdated ? Date.parse(rawUpdated) : Number.NaN;
      return Number.isFinite(updatedMs) ? updatedMs : null;
    } catch {
      return null;
    }
  }

  private async filterWindowPathsByUpdatedAfter(filePaths: string[], updatedAfterMs: number): Promise<string[]> {
    const results = await Promise.all(filePaths.map(async (filePath) => {
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
    }));
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
    readBatchSize: number,
  ): Promise<{ memories: MemoryFile[]; filePaths: string[] }> {
    const memories: MemoryFile[] = [];
    const filePaths: string[] = [];
    const normalizedReadBatchSize = this.normalizeMemoryReadBatchSize(readBatchSize);

    for (let index = 0; index < candidateBatchPaths.length; ) {
      if (memories.length >= remainingSlots || filePaths.length >= remainingInspectionBudget) break;
      const availableSlots = remainingSlots - memories.length;
      const availableInspectionBudget = remainingInspectionBudget - filePaths.length;
      const parallelWindow =
        availableSlots >= 4 && availableInspectionBudget >= 4
          ? Math.min(normalizedReadBatchSize, 4)
          : 1;
      const candidatePaths = candidateBatchPaths.slice(
        index,
        index + Math.min(parallelWindow, availableInspectionBudget),
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

  async readMemoriesWindow(options: {
    maxMemories?: number;
    batchSize?: number;
    updatedAfter?: Date;
  } = {}): Promise<{ memories: MemoryFile[]; filePaths: string[] }> {
    const allPaths = await this.collectActiveMemoryPaths();
    const sortedPaths = this.orderWindowPaths(allPaths);
    const maxMemories =
      typeof options.maxMemories === "number" && Number.isFinite(options.maxMemories)
        ? Math.max(1, Math.floor(options.maxMemories))
        : undefined;
    const maxCandidatePaths = maxMemories === undefined ? undefined : maxMemories * 2;
    const updatedAfterMs = options.updatedAfter?.getTime();
    const normalizedBatchSize = this.normalizeMemoryReadBatchSize(options.batchSize);
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
        : await this.filterWindowPathsByUpdatedAfter(batchPaths, updatedAfterMs);
      const remainingSlots = maxMemories === undefined ? undefined : Math.max(0, maxMemories - memories.length);
      const remainingInspectionBudget = maxCandidatePaths === undefined ? undefined : Math.max(0, maxCandidatePaths - selectedPaths.length);
      const { memories: batchMemories, filePaths: parsedCandidatePaths } = remainingSlots === undefined
        ? {
            memories: await this.readParsedMemoriesFromPaths(candidateBatchPaths, normalizedBatchSize),
            filePaths: candidateBatchPaths,
          }
        : await this.readWindowBoundedBatch(
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

  private async _readAllMemoriesFromDisk(): Promise<MemoryFile[]> {
    const filePaths = await this.collectActiveMemoryPaths();
    return this.readParsedMemoriesFromPaths(filePaths, 50);
  }

  /**
   * Read all memories from the cold tier by scanning the entire cold/ root
   * tree.  Previously this only scanned cold/facts/ and cold/corrections/, but
   * structuredAttributes can appear on any MemoryCategory (preference, decision,
   * entity, etc.).  Although buildTierMemoryPath currently routes all
   * non-correction, non-artifact memories to cold/facts/, scanning the full
   * coldRoot ensures correctness if that routing ever changes and guards against
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
    const coldRoot = this.resolveTierRootDir("cold");

    // Read the on-disk cold-version sentinel BEFORE checking the cache so that
    // writes made by other processes (gateway + CLI) are detected immediately.
    // Finding UvUy (PR #402 round-11): without this check the cache served
    // stale data for up to 30s when another process wrote a new cold memory.
    const currentColdVersion = this.readColdWriteVersion();

    // Return cached result if still valid by both TTL and sentinel version.
    const cached = StorageManager.coldMemoriesCache.get(coldRoot);
    if (
      cached &&
      Date.now() - cached.loadedAt < StorageManager.COLD_SCAN_CACHE_TTL_MS &&
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
    const memories = await this.readParsedMemoriesFromPaths(filePaths, 50);

    // Store in cache with the sentinel version captured above so that any
    // subsequent cold-version bump (by this or another process) invalidates it.
    StorageManager.coldMemoriesCache.set(coldRoot, { memories, loadedAt: Date.now(), coldVersion: currentColdVersion });
    return memories;
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
                memories.push({
                  path: fullPath,
                  frontmatter: normalizeFrontmatterForPath(
                    parsed.frontmatter,
                    toMemoryPathRel(this.baseDir, fullPath),
                    parsed.content,
                  ),
                  content: parsed.content,
                });
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
    return memories;
  }

  /** Read a single memory file by its absolute path. Returns null if unreadable. */
  async readMemoryByPath(filePath: string): Promise<MemoryFile | null> {
    try {
      const raw = await readMaybeEncryptedFile(filePath, this._secureStoreKey, this.baseDir);
      // Note: the outer catch intentionally swallows most errors (ENOENT etc.)
      // but SecureStoreLockedError must propagate — see re-throw below.
      const parsed = parseFrontmatter(raw);
      if (parsed) {
        return {
          path: filePath,
          frontmatter: normalizeFrontmatterForPath(
            parsed.frontmatter,
            toMemoryPathRel(this.baseDir, filePath),
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
        const entity = parseEntityFile(raw, this.entitySchemas);
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

  private resolveTierRootDir(tier: "hot" | "cold"): string {
    return tier === "cold" ? path.join(this.baseDir, "cold") : this.baseDir;
  }

  private resolveMemoryDateDir(memory: MemoryFile): string {
    const preferred = memory.frontmatter.created || memory.frontmatter.updated;
    const dateToken = (preferred ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(dateToken)
      ? dateToken
      : new Date().toISOString().slice(0, 10);
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
      return path.join(root, "corrections", `${memory.frontmatter.id}.md`);
    }
    if (memory.frontmatter.category === "procedure") {
      return path.join(root, "procedures", this.resolveMemoryDateDir(memory), `${memory.frontmatter.id}.md`);
    }
    if (memory.frontmatter.category === "reasoning_trace") {
      // Issue #564 PR 3: preserve the dedicated reasoning-traces/ subtree
      // across tier moves. Without this branch, hot→cold migration would
      // funnel the memory into facts/, breaking isReasoningTracePath() and
      // silently disabling the recall boost for migrated traces.
      return path.join(root, "reasoning-traces", this.resolveMemoryDateDir(memory), `${memory.frontmatter.id}.md`);
    }
    return path.join(root, "facts", this.resolveMemoryDateDir(memory), `${memory.frontmatter.id}.md`);
  }

  private async writeMemoryFileAtomic(targetPath: string, memory: MemoryFile): Promise<void> {
    const fileContent = `${serializeFrontmatter(memory.frontmatter)}\n\n${memory.content}\n`;
    // writeMaybeEncryptedFile handles atomic temp→rename internally and
    // calls mkdir on the parent directory — no need to duplicate here.
    await writeMaybeEncryptedFile(targetPath, fileContent, this.resolveWriteKey(), {}, this.baseDir);
    this.invalidateAllMemoriesCache();
  }

  async moveMemoryToPath(memory: MemoryFile, targetPath: string): Promise<void> {
    await this.writeMemoryFileAtomic(targetPath, memory);
    const sourcePath = path.resolve(memory.path);
    const destPath = path.resolve(targetPath);
    if (sourcePath !== destPath) {
      try {
        await unlink(memory.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("ENOENT")) {
          throw err;
        }
      }
      // Re-invalidate after the unlink — writeMemoryFileAtomic already
      // invalidated, but a concurrent readAllMemories() may have re-populated
      // the cache between the write and the unlink.
      this.invalidateAllMemoriesCache();
    }
  }

  async migrateMemoryToTier(
    memory: MemoryFile,
    targetTier: "hot" | "cold",
  ): Promise<{ changed: boolean; targetPath: string }> {
    const targetPath = this.buildTierMemoryPath(memory, targetTier);
    const sourcePath = path.resolve(memory.path);
    const destPath = path.resolve(targetPath);
    if (sourcePath === destPath) {
      return { changed: false, targetPath };
    }

    const existing = await this.readMemoryByPath(targetPath);
    if (existing?.frontmatter.id === memory.frontmatter.id) {
      try {
        await unlink(memory.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("ENOENT")) {
          throw err;
        }
      }
      this.bumpMemoryStatusVersion();
      return { changed: false, targetPath };
    }

    await this.moveMemoryToPath(memory, targetPath);
    this.invalidateAllMemoriesCache();
    // If moving to cold, also invalidate the cold-scan cache so the next
    // readAllColdMemories() call sees the newly-demoted file (Finding UOGi fix).
    if (targetTier === "cold") {
      this.invalidateColdMemoriesCache();
    }
    this.bumpMemoryStatusVersion();
    return { changed: true, targetPath };
  }

  private get archiveDir(): string {
    return path.join(this.baseDir, "archive");
  }

  /**
   * Archive a memory by moving it from facts/ to archive/YYYY-MM-DD/.
   * Updates frontmatter with archived status before moving.
   * Returns the new file path on success, null on failure.
   */
  async archiveMemory(
    memory: MemoryFile,
    lifecycle?: MemoryLifecycleEventWriteOptions,
  ): Promise<string | null> {
    try {
      const now = lifecycle?.at ?? new Date();
      const today = now.toISOString().slice(0, 10);
      const destDir = path.join(this.archiveDir, today);
      await mkdir(destDir, { recursive: true });

      // Update frontmatter to reflect archived status
      const updatedFm: MemoryFrontmatter = {
        ...memory.frontmatter,
        status: "archived",
        archivedAt: now.toISOString(),
        updated: now.toISOString(),
      };

      const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${memory.content}\n`;
      const destPath = path.join(destDir, path.basename(memory.path));

      // Write to archive location first (encrypted if applicable), then remove original.
      await writeMaybeEncryptedFile(destPath, fileContent, this.resolveWriteKey(), {}, this.baseDir);
      await unlink(memory.path);
      this.invalidateAllMemoriesCache();
      await this.appendGeneratedMemoryLifecycleEventFailOpen(
        "storage.archiveMemory",
        {
          memoryId: memory.frontmatter.id,
          eventType: "archived",
          timestamp: updatedFm.archivedAt ?? updatedFm.updated,
          actor: lifecycle?.actor ?? "storage.archiveMemory",
          reasonCode: lifecycle?.reasonCode,
          before: this.summarizeLifecycleState(memory.frontmatter, memory.path),
          after: this.summarizeLifecycleState(updatedFm, destPath),
          relatedMemoryIds: lifecycle?.relatedMemoryIds,
          correlationId: lifecycle?.correlationId,
        },
        lifecycle?.ruleVersion,
      );
      this.bumpMemoryStatusVersion();

      log.debug(`archived memory ${memory.frontmatter.id} → ${destPath}`);
      return destPath;
    } catch (err) {
      log.warn(`failed to archive memory ${memory.frontmatter.id}: ${err}`);
      return null;
    }
  }

  async readEntities(): Promise<string[]> {
    try {
      const entries = await readdir(this.entitiesDir);
      return entries.filter((e) => e.endsWith(".md")).map((e) => e.replace(".md", ""));
    } catch {
      return [];
    }
  }

  async readEntity(name: string): Promise<string> {
    try {
      return await this.readStorageSecureFile(path.join(this.entitiesDir, `${name}.md`));
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return "";
    }
  }

  /** Return sorted list of entity filenames (without .md extension) */
  async listEntityNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.entitiesDir);
      return entries
        .filter((e) => e.endsWith(".md"))
        .map((e) => e.replace(".md", ""))
        .sort();
    } catch {
      return [];
    }
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
    const proposedFull = normalizeEntityName(proposedName, type);
    const proposedNamePart = proposedFull.startsWith(typePrefix)
      ? proposedFull.slice(typePrefix.length)
      : proposedFull;
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
    const memory = memories.find((m) => m.frontmatter.id === id);
    if (!memory) return false;

    try {
      await unlink(memory.path);
      this.invalidateAllMemoriesCache();
      this.bumpMemoryStatusVersion();
      log.debug(`invalidated memory ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  async updateMemory(
    id: string,
    newContent: string,
    options?: { supersedes?: string; lineage?: string[]; actor?: string },
  ): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    if (!memory) return false;

    const mergedLineage = [
      ...(memory.frontmatter.lineage ?? []),
      ...(options?.lineage ?? []),
    ].filter((v, i, a) => a.indexOf(v) === i); // dedupe

    const updated: MemoryFrontmatter = {
      ...memory.frontmatter,
      updated: new Date().toISOString(),
      supersedes: options?.supersedes ?? memory.frontmatter.supersedes,
      lineage: mergedLineage.length > 0 ? mergedLineage : undefined,
    };
    const sanitized = sanitizeMemoryContent(newContent);
    if (!sanitized.clean) {
      log.warn(`updated memory content sanitized for ${id}; violations=${sanitized.violations.join(", ")}`);
    }
    const fileContent = `${serializeFrontmatter(updated)}\n\n${sanitized.text}\n`;
    await writeMaybeEncryptedFile(memory.path, fileContent, this.resolveWriteKey(), {}, this.baseDir);
    this.invalidateAllMemoriesCache();
    await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.updateMemory", {
      memoryId: id,
      eventType: "updated",
      timestamp: updated.updated,
      actor: options?.actor ?? "storage.updateMemory",
      before: this.summarizeLifecycleState(memory.frontmatter, memory.path),
      after: this.summarizeLifecycleState(updated, memory.path),
      relatedMemoryIds: [
        ...(updated.supersedes ? [updated.supersedes] : []),
        ...((updated.lineage ?? []).filter(Boolean)),
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
    lifecycle?: MemoryLifecycleEventWriteOptions,
  ): Promise<boolean> {
    const beforeStatus = memory.frontmatter.status ?? "active";
    const updated: MemoryFrontmatter = {
      ...memory.frontmatter,
      ...patch,
    };
    const afterStatus = updated.status ?? "active";

    const fileContent = `${serializeFrontmatter(updated)}\n\n${memory.content}\n`;
    await writeMaybeEncryptedFile(memory.path, fileContent, this.resolveWriteKey(), {}, this.baseDir);
    this.invalidateAllMemoriesCache();
    // If the target file lives in cold/, bump the cold-version sentinel so
    // other processes detect the change on their next readAllColdMemories()
    // call (Finding UvUy fix).
    if (memory.path.includes(`${path.sep}cold${path.sep}`)) {
      this.invalidateColdMemoriesCache();
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
      lifecycle?.ruleVersion,
    );
    if (beforeStatus !== afterStatus) {
      this.bumpMemoryStatusVersion();
    }
    return true;
  }

  /**
   * Update frontmatter by memory ID.
   * Prefer writeMemoryFrontmatter(memory, patch) in batch loops to avoid full-corpus rescans.
   */
  async updateMemoryFrontmatter(
    id: string,
    patch: Partial<MemoryFrontmatter>,
  ): Promise<boolean> {
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
      if (expiresAt < now) {
        try {
          await unlink(m.path);
          deleted.push(m);
          log.debug(`cleaned expired memory ${m.frontmatter.id} (TTL expired)`);
        } catch {
          // Ignore
        }
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
        extractionCount:
          typeof parsed.extractionCount === "number" ? parsed.extractionCount : 0,
        lastExtractionAt: parsed.lastExtractionAt ?? null,
        lastConsolidationAt: parsed.lastConsolidationAt ?? null,
        totalMemories:
          typeof parsed.totalMemories === "number" ? parsed.totalMemories : 0,
        totalEntities:
          typeof parsed.totalEntities === "number" ? parsed.totalEntities : 0,
        processedExtractionFingerprints: Array.isArray(
          parsed.processedExtractionFingerprints,
        )
          ? parsed.processedExtractionFingerprints
              .filter(
                (entry) =>
                  entry &&
                  typeof entry === "object" &&
                  typeof (entry as { fingerprint?: unknown }).fingerprint ===
                    "string" &&
                  typeof (entry as { observedAt?: unknown }).observedAt ===
                    "string",
              )
              .map((entry) => ({
                fingerprint: (entry as { fingerprint: string }).fingerprint,
                observedAt: (entry as { observedAt: string }).observedAt,
              }))
          : [],
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
    const payload = events.map((event) => {
      const normalized: MemoryActionEvent = {
        ...event,
        timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
      };
      return `${JSON.stringify(normalized)}\n`;
    }).join("");

    await this.appendStorageSecureFile(this.memoryActionsPath, payload);
    return events.length;
  }

  async appendMemoryLifecycleEvents(events: MemoryLifecycleEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();

    const nowIso = new Date().toISOString();
    const payload = events.map((event) => {
      const normalized: MemoryLifecycleEvent = {
        ...event,
        timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
      };
      return `${JSON.stringify(normalized)}\n`;
    }).join("");

    await this.appendStorageSecureFile(this.memoryLifecycleLedgerPath, payload);
    return events.length;
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
    await this.ensureDirectories();

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

    await this.appendStorageSecureFile(this.bufferSurpriseLedgerPath, payload);
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
      raw = await this.readStorageSecureFile(this.bufferSurpriseLedgerPath);
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

  async appendBehaviorSignals(events: BehaviorSignalEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();

    let existingKeys = new Set<string>();
    try {
      const raw = await this.readStorageSecureFile(this.behaviorSignalsPath);
      const lines = raw.split("\n");
      for (const line of lines) {
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
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      existingKeys = new Set<string>();
    }

    const nowIso = new Date().toISOString();
    const deduped: BehaviorSignalEvent[] = [];
    for (const event of events) {
      const key = `${event.memoryId}:${event.signalHash}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      deduped.push({
        ...event,
        timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
      });
    }

    if (deduped.length === 0) return 0;
    const payload = deduped.map((event) => `${JSON.stringify(event)}\n`).join("");
    await this.appendStorageSecureFile(this.behaviorSignalsPath, payload);
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
    if (cappedLimit === 0) return [];

    try {
      const raw = await this.readStorageSecureFile(this.memoryActionsPath);
      const out: Array<{ line: number; event: MemoryActionEvent }> = [];
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < cappedLimit; i -= 1) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Partial<MemoryActionEvent>;
          const outcome = parsed.outcome === "applied" || parsed.outcome === "skipped" || parsed.outcome === "failed"
            ? parsed.outcome
            : null;
          if (
            typeof parsed.timestamp === "string" &&
            typeof parsed.action === "string" &&
            outcome !== null
          ) {
            out.push({
              line: i + 1,
              event: {
                ...parsed,
                outcome,
              } as MemoryActionEvent,
            });
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

  async readAllMemoryLifecycleEvents(): Promise<MemoryLifecycleEvent[]> {
    try {
      const raw = await this.readStorageSecureFile(this.memoryLifecycleLedgerPath);
      const out: MemoryLifecycleEvent[] = [];
      const lines = raw.split("\n");
      for (const line of lines) {
        const row = line.trim();
        if (!row) continue;
        try {
          const parsed = JSON.parse(row) as Partial<MemoryLifecycleEvent>;
          if (
            typeof parsed.eventId === "string" &&
            typeof parsed.memoryId === "string" &&
            typeof parsed.eventType === "string" &&
            typeof parsed.timestamp === "string" &&
            typeof parsed.actor === "string" &&
            typeof parsed.ruleVersion === "string"
          ) {
            out.push(parsed as MemoryLifecycleEvent);
          }
        } catch {
          // Ignore malformed rows (fail-open).
        }
      }
      return sortMemoryLifecycleEvents(out);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return [];
    }
  }

  async readMemoryLifecycleEvents(limit: number = 200): Promise<MemoryLifecycleEvent[]> {
    const cappedLimit = Math.max(0, Math.floor(limit));
    if (cappedLimit === 0) return [];
    const events = await this.readAllMemoryLifecycleEvents();
    return events.slice(-cappedLimit);
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

  async writeCompressionGuidelineOptimizerState(
    state: CompressionGuidelineOptimizerState,
  ): Promise<void> {
    await this.ensureDirectories();
    await this.writeStorageSecureFile(this.compressionGuidelineStatePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async writeCompressionGuidelineDraftState(
    state: CompressionGuidelineOptimizerState,
  ): Promise<void> {
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
      const raw = await this.readStorageSecureFile(filePath);
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

  async writeIdentityAnchor(content: string): Promise<void> {
    await this.ensureDirectories();
    await this.writeStorageSecureFile(this.identityAnchorPath, content);
  }

  async readIdentityAnchor(): Promise<string | null> {
    try {
      return await this.readStorageSecureFile(this.identityAnchorPath);
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async appendContinuityIncident(input: ContinuityIncidentOpenInput): Promise<ContinuityIncidentRecord> {
    await this.ensureDirectories();
    const now = new Date();
    const nowIso = now.toISOString();
    const date = nowIso.slice(0, 10);
    const id = this.generateId("incident");
    const incident = createContinuityIncidentRecord(id, input, nowIso);
    const filePath = path.join(this.identityIncidentsDir, `${date}-${id}.md`);
    await this.writeStorageSecureFile(filePath, serializeContinuityIncident(incident));
    return { ...incident, filePath };
  }

  async readContinuityIncidents(
    limit: number = 200,
    state: "open" | "closed" | "all" = "all",
  ): Promise<ContinuityIncidentRecord[]> {
    const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
    const cappedLimit = Math.max(0, normalizedLimit);
    if (cappedLimit === 0) return [];

    try {
      const candidates = await this.readContinuityIncidentFileNames();
      const incidents: ContinuityIncidentRecord[] = [];

      for (const file of candidates) {
        if (incidents.length >= cappedLimit) break;
        const filePath = path.join(this.identityIncidentsDir, file);
        try {
          const raw = await this.readStorageSecureFile(filePath);
          const parsed = parseContinuityIncident(raw);
          if (!parsed) continue;
          if (state !== "all" && parsed.state !== state) continue;
          incidents.push({ ...parsed, filePath });
        } catch (err) {
          if (err instanceof SecureStoreLockedError) throw err;
          // Fail-open on malformed/missing files.
        }
      }
      return incidents;
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return [];
    }
  }

  async closeContinuityIncident(
    id: string,
    closure: ContinuityIncidentCloseInput,
  ): Promise<ContinuityIncidentRecord | null> {
    const directFilePath = await this.findContinuityIncidentFilePathById(id);
    const target = directFilePath ? await this.readContinuityIncidentFile(directFilePath) : null;
    if (!target || !directFilePath) return null;
    if (target.state === "closed") return target;

    const closed = closeContinuityIncidentRecord(target, closure, new Date().toISOString());
    await this.writeStorageSecureFile(directFilePath, serializeContinuityIncident(closed));
    return { ...closed, filePath: directFilePath };
  }

  async writeIdentityAudit(period: "weekly" | "monthly", key: string, content: string): Promise<string> {
    await this.ensureDirectories();
    const safeKey = this.sanitizeIdentityAuditKey(key);
    const dir = period === "weekly" ? this.identityAuditsWeeklyDir : this.identityAuditsMonthlyDir;
    const filePath = path.join(dir, `${safeKey}.md`);
    await this.writeStorageSecureFile(filePath, content);
    return filePath;
  }

  async readIdentityAudit(period: "weekly" | "monthly", key: string): Promise<string | null> {
    try {
      const safeKey = this.sanitizeIdentityAuditKey(key);
      const dir = period === "weekly" ? this.identityAuditsWeeklyDir : this.identityAuditsMonthlyDir;
      return await this.readStorageSecureFile(path.join(dir, `${safeKey}.md`));
    } catch (err) {
      if (err instanceof Error && err.message === "Invalid identity audit key") return null;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async writeIdentityImprovementLoops(content: string): Promise<void> {
    await this.ensureDirectories();
    await this.writeStorageSecureFile(this.identityImprovementLoopsPath, content);
  }

  async readIdentityImprovementLoops(): Promise<string | null> {
    try {
      return await this.readStorageSecureFile(this.identityImprovementLoopsPath);
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async readIdentityImprovementLoopRegister(): Promise<ContinuityImprovementLoop[]> {
    const raw = await this.readIdentityImprovementLoops();
    if (!raw) return [];
    return parseContinuityImprovementLoops(raw);
  }

  async upsertIdentityImprovementLoop(input: ContinuityLoopUpsertInput): Promise<ContinuityImprovementLoop> {
    const nowIso = new Date().toISOString();
    const raw = await this.readIdentityImprovementLoops();
    const { markdown, loop } = upsertContinuityLoopInMarkdown(raw, input, nowIso);
    await this.writeIdentityImprovementLoops(markdown);
    return loop;
  }

  async reviewIdentityImprovementLoop(
    id: string,
    input: ContinuityLoopReviewInput,
  ): Promise<ContinuityImprovementLoop | null> {
    const raw = await this.readIdentityImprovementLoops();
    const { markdown, loop } = reviewContinuityLoopInMarkdown(raw, id, input, new Date().toISOString());
    if (!loop) return null;
    await this.writeIdentityImprovementLoops(markdown);
    return loop;
  }

  // ---------------------------------------------------------------------------
  // Question storage
  // ---------------------------------------------------------------------------

  private generateId(prefix: string = "m"): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 4);
    return `${prefix}-${ts}-${rand}`;
  }

  private async readContinuityIncidentFileNames(): Promise<string[]> {
    const files = await readdir(this.identityIncidentsDir);
    return files
      .filter((file) => file.endsWith(".md"))
      .sort()
      .reverse();
  }

  private async readContinuityIncidentFile(filePath: string): Promise<ContinuityIncidentRecord | null> {
    try {
      const raw = await this.readStorageSecureFile(filePath);
      const parsed = parseContinuityIncident(raw);
      return parsed ? { ...parsed, filePath } : null;
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      return null;
    }
  }

  private async findContinuityIncidentFilePathById(id: string): Promise<string | null> {
    const fileNames = await this.readContinuityIncidentFileNames();
    const directMatch = fileNames.find((name) => name.endsWith(`-${id}.md`));
    if (directMatch) {
      const directPath = path.join(this.identityIncidentsDir, directMatch);
      const parsed = await this.readContinuityIncidentFile(directPath);
      if (parsed?.id === id) return directPath;
    }

    for (const fileName of fileNames) {
      const filePath = path.join(this.identityIncidentsDir, fileName);
      const parsed = await this.readContinuityIncidentFile(filePath);
      if (parsed?.id === id) return filePath;
    }
    return null;
  }

  private sanitizeIdentityAuditKey(key: string): string {
    const trimmed = key.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) || trimmed.includes("..")) {
      throw new Error("Invalid identity audit key");
    }
    return trimmed;
  }

  async writeQuestion(
    question: string,
    context: string,
    priority: number,
  ): Promise<string> {
    await mkdir(this.questionsDir, { recursive: true });

    const id = this.generateId("q");
    const frontmatter = {
      id,
      created: new Date().toISOString(),
      priority,
      resolved: false,
    };

    const content = `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n${question}\n\n**Context:** ${context}\n`;

    const filePath = path.join(this.questionsDir, `${id}.md`);
    await writeFile(filePath, content, "utf-8");

    log.debug(`wrote question ${id} to ${filePath}`);
    this.invalidateQuestionsCache();
    return id;
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
    const cacheKey = this.questionsDir;
    const cached = StorageManager.questionsCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < StorageManager.QUESTIONS_CACHE_TTL_MS) {
      // Check dir mtime for cross-process invalidation — if another process
      // wrote/resolved a question, the directory mtime will be newer than loadedAt.
      try {
        const dirStat = await stat(this.questionsDir);
        if (dirStat.mtimeMs <= cached.loadedAt) {
          const all = cached.questions;
          return opts?.unresolvedOnly ? all.filter((q) => !q.resolved) : all;
        }
      } catch {
        // Dir doesn't exist — fall through to re-read
      }
    }

    try {
      const files = await readdir(this.questionsDir);
      const questions = [];
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(this.questionsDir, file);
        const raw = await readMaybeEncryptedFile(filePath, this._secureStoreKey, this.baseDir);
        const parsed = this.parseQuestionFile(raw, filePath);
        if (parsed) {
          questions.push(parsed);
        }
      }
      const sorted = questions.sort((a, b) => b.priority - a.priority);
      StorageManager.questionsCache.set(cacheKey, { questions: sorted, loadedAt: Date.now() });
      return opts?.unresolvedOnly ? sorted.filter((q) => !q.resolved) : sorted;
    } catch {
      return [];
    }
  }

  /** Invalidate the questions cache (call after writing a question). */
  invalidateQuestionsCache(): void {
    StorageManager.questionsCache.delete(this.questionsDir);
  }

  private parseQuestionFile(
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
  } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatterStr = match[1];
    const body = match[2].trim();

    // Parse frontmatter
    const id =
      this.extractFrontmatterValue(frontmatterStr, "id") ??
      path.basename(filePath, ".md");
    const created =
      this.extractFrontmatterValue(frontmatterStr, "created") ?? "";
    const priority = parseFloat(
      this.extractFrontmatterValue(frontmatterStr, "priority") ?? "0.5",
    );
    const resolved =
      this.extractFrontmatterValue(frontmatterStr, "resolved") === "true";

    // Extract question and context from body
    const contextMatch = body.match(/\*\*Context:\*\*\s*(.*)/);
    const question = contextMatch
      ? body.slice(0, contextMatch.index).trim()
      : body;
    const context = contextMatch ? contextMatch[1].trim() : "";

    return { id, question, context, priority, resolved, created, filePath };
  }

  private extractFrontmatterValue(
    frontmatter: string,
    key: string,
  ): string | null {
    const match = frontmatter.match(
      new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, "m"),
    );
    return match ? match[1] : null;
  }

  async resolveQuestion(id: string): Promise<boolean> {
    const questions = await this.readQuestions();
    const q = questions.find((q) => q.id === id);
    if (!q) return false;

    let raw = await readFile(q.filePath, "utf-8");
    raw = raw.replace(/resolved: false/, "resolved: true");
    raw = raw.replace(
      /---\n\n/,
      `resolvedAt: "${new Date().toISOString()}"\n---\n\n`,
    );
    await writeFile(q.filePath, raw, "utf-8");
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
    opts?: { hygiene?: FileHygieneConfig; namespace?: string },
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
        log.info(
          `rotated IDENTITY.md to archive (size=${existing.length} chars, maxBytes=${maxBytes})`,
        );
      }
    } else {
      // Legacy behavior: skip if file is too large
      if (existing.length > StorageManager.IDENTITY_MAX_BYTES) {
        log.debug(`IDENTITY.md is ${existing.length} chars (limit ${StorageManager.IDENTITY_MAX_BYTES}); skipping reflection`);
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
          log.debug(`reflection cooldown: ${Math.round(elapsed / 1000)}s since last (need ${StorageManager.REFLECTION_COOLDOWN_MS / 1000}s)`);
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
        `identity/reflections.md is ${existing.length} chars (limit ${StorageManager.IDENTITY_MAX_BYTES}); skipping reflection`,
      );
      return;
    }

    const allMatches = [...existing.matchAll(/## Reflection — (\S+)/g)];
    if (allMatches.length > 0) {
      const lastTimestamp = allMatches[allMatches.length - 1][1];
      const elapsed = Date.now() - new Date(lastTimestamp).getTime();
      if (elapsed < StorageManager.REFLECTION_COOLDOWN_MS) {
        log.debug(
          `reflection cooldown: ${Math.round(elapsed / 1000)}s since last (need ${StorageManager.REFLECTION_COOLDOWN_MS / 1000}s)`,
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

  // ---------------------------------------------------------------------------
  // Entity mutation helpers (Knowledge Graph v7.0)
  // ---------------------------------------------------------------------------

  /**
   * Add a relationship to an entity file.
   * Deduplicates by target+label.
   */
  async addEntityRelationship(name: string, rel: EntityRelationship): Promise<void> {
    const filePath = path.join(this.entitiesDir, `${name}.md`);
    let entity: EntityFile;
    try {
      const content = await this.readStorageSecureFile(filePath);
      entity = parseEntityFile(content, this.entitySchemas);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      log.debug(`addEntityRelationship: entity file ${name}.md not found`);
      return;
    }

    // Dedupe by target+label
    const exists = entity.relationships.some(
      (r) => r.target === rel.target && r.label === rel.label,
    );
    if (exists) return;

    entity.relationships.push(rel);
    entity.updated = new Date().toISOString();
    await this.writeStorageSecureFile(filePath, serializeEntityFile(entity, this.entitySchemas));
    this.invalidateKnowledgeIndexCache();
  }

  /**
   * Add an activity entry to an entity file.
   * Prepends to the beginning, prunes oldest entries beyond maxEntries.
   */
  async addEntityActivity(
    name: string,
    entry: EntityActivityEntry,
    maxEntries: number,
  ): Promise<void> {
    const filePath = path.join(this.entitiesDir, `${name}.md`);
    let entity: EntityFile;
    try {
      const content = await this.readStorageSecureFile(filePath);
      entity = parseEntityFile(content, this.entitySchemas);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      log.debug(`addEntityActivity: entity file ${name}.md not found`);
      return;
    }

    entity.activity.unshift(entry);
    if (entity.activity.length > maxEntries) {
      entity.activity = entity.activity.slice(0, maxEntries);
    }
    entity.updated = new Date().toISOString();
    await this.writeStorageSecureFile(filePath, serializeEntityFile(entity, this.entitySchemas));
    this.invalidateKnowledgeIndexCache();
  }

  /**
   * Add an alias to an entity file. Deduplicates.
   */
  async addEntityAlias(name: string, alias: string): Promise<void> {
    const filePath = path.join(this.entitiesDir, `${name}.md`);
    let entity: EntityFile;
    try {
      const content = await this.readStorageSecureFile(filePath);
      entity = parseEntityFile(content, this.entitySchemas);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      log.debug(`addEntityAlias: entity file ${name}.md not found`);
      return;
    }

    if (entity.aliases.includes(alias)) return;
    entity.aliases.push(alias);
    entity.updated = new Date().toISOString();
    await this.writeStorageSecureFile(filePath, serializeEntityFile(entity, this.entitySchemas));
    this.invalidateKnowledgeIndexCache();
  }

  /**
   * Set or rewrite the synthesis layer of an entity file.
   */
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
    } = {},
  ): Promise<void> {
    const filePath = path.join(this.entitiesDir, `${name}.md`);
    let entity: EntityFile;
    try {
      const content = await this.readStorageSecureFile(filePath);
      entity = parseEntityFile(content, this.entitySchemas);
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      log.debug(`updateEntitySynthesis: entity file ${name}.md not found`);
      return;
    }

    const updatedAt = options.updatedAt?.trim() || entity.synthesisUpdatedAt?.trim() || undefined;
    const entityUpdatedAt = options.entityUpdatedAt?.trim() || updatedAt || entity.updated || new Date().toISOString();
    const synthesisTimelineCount = Number.isInteger(options.synthesisTimelineCount)
      && (options.synthesisTimelineCount ?? 0) >= 0
      ? options.synthesisTimelineCount
      : undefined;
    const synthesisStructuredFactCount = Number.isInteger(options.synthesisStructuredFactCount)
      && (options.synthesisStructuredFactCount ?? 0) >= 0
      ? options.synthesisStructuredFactCount
      : countEntityStructuredFacts(entity);
    const synthesisStructuredFactDigest = options.synthesisStructuredFactDigest?.trim()
      || fingerprintEntityStructuredFacts(entity);
    entity.synthesis = synthesis.trim();
    entity.summary = entity.synthesis;
    entity.synthesisUpdatedAt = updatedAt;
    entity.synthesisTimelineCount = synthesisTimelineCount;
    entity.synthesisStructuredFactCount = synthesisStructuredFactCount;
    entity.synthesisStructuredFactDigest = synthesisStructuredFactDigest;
    entity.synthesisVersion = Math.max(0, entity.synthesisVersion ?? 0)
      + (options.incrementVersion === false ? 0 : 1);
    entity.updated = entityUpdatedAt;
    await this.writeStorageSecureFile(filePath, serializeEntityFile(entity, this.entitySchemas));
    await this.removeEntitySynthesisQueueEntries([
      ...new Set([name, normalizeEntityName(entity.name, entity.type)]),
    ]);
    this.invalidateKnowledgeIndexCache();
    this.bumpMemoryStatusVersion(); // invalidate entity cache
  }

  /**
   * Backward-compatible alias for legacy callers/tests.
   */
  async updateEntitySummary(name: string, summary: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    let synthesisTimelineCount: number | undefined;
    try {
      const filePath = path.join(this.entitiesDir, `${name}.md`);
      const content = await this.readStorageSecureFile(filePath);
      synthesisTimelineCount = parseEntityFile(content, this.entitySchemas).timeline.length;
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      synthesisTimelineCount = undefined;
    }
    await this.updateEntitySynthesis(name, summary, {
      entityUpdatedAt: updatedAt,
      synthesisTimelineCount,
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
      }),
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
        2,
      ) + "\n",
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
        2,
      ) + "\n",
    );
  }

  async migrateEntityFilesToCompiledTruthTimeline(): Promise<{
    total: number;
    migrated: number;
  }> {
    const entityNames = await this.listEntityNames();
    let migrated = 0;
    for (const entityName of entityNames) {
      const raw = await this.readEntity(entityName);
      if (!raw) continue;
      const serialized = serializeEntityFile(parseEntityFile(raw, this.entitySchemas), this.entitySchemas);
      if (raw.trimEnd() === serialized.trimEnd()) continue;
      await this.writeStorageSecureFile(path.join(this.entitiesDir, `${entityName}.md`), serialized);
      migrated += 1;
    }
    if (migrated > 0) {
      this.invalidateKnowledgeIndexCache();
      this.bumpMemoryStatusVersion();
    }
    return {
      total: entityNames.length,
      migrated,
    };
  }

  // ---------------------------------------------------------------------------
  // Scoring + Knowledge Index (Knowledge Graph v7.0)
  // ---------------------------------------------------------------------------

  /**
   * Read all entity files and return lightweight EntityFile objects.
   * Parsing is fast (~50-100ms for ~1,800 files) since entity files are small.
   */
  async readAllEntityFiles(): Promise<EntityFile[]> {
    const currentVersion = this.getMemoryStatusVersion();
    const schemaCacheKey = buildEntitySchemaCacheKey(this.entitySchemas);
    const cacheKey = `${this.getEntityCacheSecureStoreKey()}\u0000${schemaCacheKey}`;
    const cached = getCachedEntities(this.baseDir, currentVersion, cacheKey);
    if (cached) return cached;

    try {
      const entries = await readdir(this.entitiesDir);
      const mdFiles = entries.filter((e) => e.endsWith(".md"));
      if (mdFiles.length === 0) return [];

      // Read all entity files in parallel batches to avoid O(N) sequential I/O.
      // With 3000+ entity files, sequential reads can take 15-20s under load.
      // Batching at 100 keeps file-descriptor pressure manageable while staying fast.
      const BATCH_SIZE = 100;
      const entities: EntityFile[] = [];
      for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
        const batch = mdFiles.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (entry) => {
            try {
              return await this.readStorageSecureFile(path.join(this.entitiesDir, entry));
            } catch (err) {
              if (err instanceof SecureStoreLockedError) throw err;
              if (!isErrnoCode(err, "ENOENT")) throw err;
              return null;
            }
          }),
        );
        for (const content of results) {
          if (content !== null) entities.push(parseEntityFile(content, this.entitySchemas));
        }
      }

      setCachedEntities(this.baseDir, entities, currentVersion, cacheKey);
      return entities;
    } catch (err) {
      if (err instanceof SecureStoreLockedError || !isErrnoCode(err, "ENOENT")) throw err;
      // Directory doesn't exist yet
      return [];
    }
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

    return (
      recency * 0.40 +
      frequency * 0.25 +
      activityScore * 0.15 +
      typePriority * 0.10 +
      relDensity * 0.10
    );
  }

  /**
   * Build the Knowledge Index: a compact markdown table of top-scored entities.
   * Respects maxEntities and maxChars limits from config.
   */
  async buildKnowledgeIndex(
    config: PluginConfig,
    overrides?: { maxEntities?: number; maxChars?: number },
  ): Promise<{ result: string; cached: boolean }> {
    const useDefaultLimits =
      overrides?.maxEntities === undefined &&
      overrides?.maxChars === undefined;
    // Return cached index if still fresh
    if (
      useDefaultLimits &&
      this.knowledgeIndexCache &&
      Date.now() - this.knowledgeIndexCache.builtAt < StorageManager.KNOWLEDGE_INDEX_CACHE_TTL_MS
    ) {
      return { result: this.knowledgeIndexCache.result, cached: true };
    }

    const entities = await this.readAllEntityFiles();
    if (entities.length === 0) {
      if (useDefaultLimits) this.knowledgeIndexCache = { result: "", builtAt: Date.now() };
      return { result: "", cached: false };
    }

    const now = new Date();
    const scored: ScoredEntity[] = entities.map((e) => ({
      name: e.name,
      type: e.type,
      score: StorageManager.scoreEntity(e, now),
      factCount: e.facts.length,
      summary: e.synthesis ?? e.summary,
      topRelationships: e.relationships.slice(0, 3).map((r) => r.target),
    }));

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    const maxEntities = typeof overrides?.maxEntities === "number"
      ? Math.max(0, Math.floor(overrides.maxEntities))
      : config.knowledgeIndexMaxEntities;
    const topN = scored.slice(0, maxEntities);

    if (topN.length === 0) {
      if (useDefaultLimits) this.knowledgeIndexCache = { result: "", builtAt: Date.now() };
      return { result: "", cached: false };
    }

    // Build markdown table
    const header = "## Knowledge Index\n\n| Entity | Type | Summary | Connected to |\n|--------|------|---------|-------------|";
    const rows: string[] = [];
    let totalChars = header.length;
    const maxChars = typeof overrides?.maxChars === "number"
      ? Math.max(0, Math.floor(overrides.maxChars))
      : config.knowledgeIndexMaxChars;

    for (const entity of topN) {
      const summary = entity.summary || `${entity.factCount} facts`;
      const connected = entity.topRelationships.length > 0
        ? entity.topRelationships.join(", ")
        : "—";
      const row = `| ${entity.name} | ${entity.type} | ${summary} | ${connected} |`;

      if (totalChars + row.length + 1 > maxChars) break;
      rows.push(row);
      totalChars += row.length + 1;
    }

    const result = rows.length === 0 ? "" : `${header}\n${rows.join("\n")}\n`;
    if (useDefaultLimits) this.knowledgeIndexCache = { result, builtAt: Date.now() };
    return { result, cached: false };
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

  /**
   * Merge fragmented entity files that resolve to the same canonical name.
   * Preserves relationships, activity, aliases, and summary from all fragments.
   * Returns count of files merged.
   */
  async mergeFragmentedEntities(): Promise<number> {
    let merged = 0;
    try {
      const entries = await readdir(this.entitiesDir);
      const mdFiles = entries.filter((e) => e.endsWith(".md"));

      // Group files by their canonical name
      const groups = new Map<string, string[]>();
      for (const file of mdFiles) {
        const baseName = file.replace(".md", "");
        // Extract type and name from filename (type-rest-of-name)
        const dashIdx = baseName.indexOf("-");
        if (dashIdx === -1) continue;
        const type = baseName.slice(0, dashIdx);
        const restOfName = baseName.slice(dashIdx + 1);
        const canonical = normalizeEntityName(restOfName, type);

        if (!groups.has(canonical)) groups.set(canonical, []);
        groups.get(canonical)!.push(file);
      }

      // Merge groups with more than one file
      for (const [canonical, files] of groups) {
        if (files.length <= 1) continue;

        // Parse all files and merge into a single EntityFile
        const mergedEntity: EntityFile = {
          name: "",
          type: "other",
          created: "",
          updated: "",
          extraFrontmatterLines: [],
          preSectionLines: [],
          facts: [],
          summary: undefined,
          synthesis: undefined,
          synthesisUpdatedAt: undefined,
          synthesisTimelineCount: undefined,
          synthesisStructuredFactCount: undefined,
          synthesisStructuredFactDigest: undefined,
          synthesisVersion: undefined,
          timeline: [],
          relationships: [],
          activity: [],
          aliases: [],
          structuredSections: [],
          extraSections: [],
        };

        for (const file of files) {
          const filePath = path.join(this.entitiesDir, file);
          try {
            const content = await this.readStorageSecureFile(filePath);
            const parsed = parseEntityFile(content, this.entitySchemas);

            // Prefer specific types over "other"
            if (!mergedEntity.type || mergedEntity.type === "other") {
              mergedEntity.type = parsed.type;
            }

            // Keep latest update time
            if (!mergedEntity.updated || compareEntityTimestamps(parsed.updated, mergedEntity.updated) > 0) {
              mergedEntity.updated = parsed.updated;
            }

            const parsedCreated = parsed.created || parsed.updated;
            const mergedCreated = mergedEntity.created?.trim() || "";
            const parsedCreatedMs = parsedCreated ? Date.parse(parsedCreated) : Number.NaN;
            const mergedCreatedMs = mergedCreated ? Date.parse(mergedCreated) : Number.NaN;
            const parsedCreatedIsValid = Number.isFinite(parsedCreatedMs);
            const mergedCreatedIsValid = Number.isFinite(mergedCreatedMs);
            if (
              parsedCreated &&
              (
                !mergedCreated
                || (parsedCreatedIsValid && !mergedCreatedIsValid)
                || (
                  parsedCreatedIsValid
                  && mergedCreatedIsValid
                  && parsedCreatedMs < mergedCreatedMs
                )
                || (
                  !parsedCreatedIsValid
                  && !mergedCreatedIsValid
                  && compareEntityTimestamps(parsedCreated, mergedCreated) < 0
                )
              )
            ) {
              mergedEntity.created = parsedCreated;
            }

            // Keep longest/best name
            if (parsed.name.length > mergedEntity.name.length) {
              mergedEntity.name = parsed.name;
            }

            const parsedSynthesisUpdatedAt = parsed.synthesisUpdatedAt?.trim() || undefined;
            const mergedSynthesisUpdatedAt = mergedEntity.synthesisUpdatedAt?.trim() || undefined;

            // Prefer the freshest synthesis/summary available.
            if (
              parsed.synthesis &&
              (!mergedEntity.synthesis
                || (!mergedSynthesisUpdatedAt && Boolean(parsedSynthesisUpdatedAt))
                || (Boolean(mergedSynthesisUpdatedAt)
                  && Boolean(parsedSynthesisUpdatedAt)
                  && compareEntityTimestamps(parsedSynthesisUpdatedAt, mergedSynthesisUpdatedAt) > 0))
            ) {
              mergedEntity.synthesis = parsed.synthesis;
              mergedEntity.summary = parsed.synthesis;
              mergedEntity.synthesisUpdatedAt = parsedSynthesisUpdatedAt;
              mergedEntity.synthesisTimelineCount = parsed.synthesisTimelineCount;
              mergedEntity.synthesisStructuredFactCount = parsed.synthesisStructuredFactCount;
              mergedEntity.synthesisStructuredFactDigest = parsed.synthesisStructuredFactDigest;
              mergedEntity.synthesisVersion = parsed.synthesisVersion;
            } else if (!mergedEntity.summary && parsed.summary) {
              mergedEntity.summary = parsed.summary;
              mergedEntity.synthesis = parsed.summary;
              mergedEntity.synthesisUpdatedAt = parsedSynthesisUpdatedAt;
              mergedEntity.synthesisTimelineCount = parsed.synthesisTimelineCount;
              mergedEntity.synthesisStructuredFactCount = parsed.synthesisStructuredFactCount;
              mergedEntity.synthesisStructuredFactDigest = parsed.synthesisStructuredFactDigest;
              mergedEntity.synthesisVersion = parsed.synthesisVersion;
            }

            // Collect all timeline evidence; facts are derived below.
            mergedEntity.timeline.push(...parsed.timeline);

            // Collect relationships (dedup later)
            mergedEntity.relationships.push(...parsed.relationships);

            // Collect activity entries
            mergedEntity.activity.push(...parsed.activity);

            // Collect aliases
            mergedEntity.aliases.push(...parsed.aliases);

            const mergedStructuredSectionMap = new Map(
              (mergedEntity.structuredSections ?? []).map((section) => [section.key, {
                ...section,
                facts: [...section.facts],
              }]),
            );
            for (const section of parsed.structuredSections ?? []) {
              const existingSection = mergedStructuredSectionMap.get(section.key);
              if (!existingSection) {
                mergedStructuredSectionMap.set(section.key, {
                  key: section.key,
                  title: section.title,
                  facts: [...new Set(section.facts.map((fact) => fact.trim()).filter((fact) => fact.length > 0))],
                });
                continue;
              }

              const mergedFacts = new Set(existingSection.facts.map((fact) => fact.trim()));
              for (const fact of section.facts) {
                const trimmed = fact.trim();
                if (!trimmed) continue;
                mergedFacts.add(trimmed);
              }
              existingSection.facts = Array.from(mergedFacts);
              if (!existingSection.title.trim() && section.title.trim()) {
                existingSection.title = section.title;
              }
            }
            mergedEntity.structuredSections = Array.from(mergedStructuredSectionMap.values());

            // Preserve custom metadata and user-authored freeform content from fragments.
            mergedEntity.extraFrontmatterLines!.push(...(parsed.extraFrontmatterLines ?? []));
            mergedEntity.preSectionLines!.push(...(parsed.preSectionLines ?? []));
            mergedEntity.extraSections!.push(...(parsed.extraSections ?? []).map((section) => ({
              title: section.title,
              lines: [...section.lines],
            })));
          } catch (err) {
            if (err instanceof SecureStoreLockedError) throw err;
            if (!isErrnoCode(err, "ENOENT")) throw err;
            // Skip unreadable
          }
        }

        // Deduplicate timeline entries and derive facts from the timeline.
        const timelineKeys = new Set<string>();
        mergedEntity.timeline = mergedEntity.timeline.filter((entry) => {
          const key = JSON.stringify([
            entry.timestamp,
            entry.source ?? "",
            entry.sessionKey ?? "",
            entry.principal ?? "",
            entry.text,
          ]);
          if (timelineKeys.has(key)) return false;
          timelineKeys.add(key);
          return true;
        });
        // Deduplicate relationships by target+label
        const relKeys = new Set<string>();
        mergedEntity.relationships = mergedEntity.relationships.filter((r) => {
          const key = `${r.target}::${r.label}`;
          if (relKeys.has(key)) return false;
          relKeys.add(key);
          return true;
        });

        // Sort activity by date descending, deduplicate by date+note
        const actKeys = new Set<string>();
        mergedEntity.activity = mergedEntity.activity
          .filter((a) => {
            const key = `${a.date}::${a.note}`;
            if (actKeys.has(key)) return false;
            actKeys.add(key);
            return true;
          })
          .sort((a, b) => b.date.localeCompare(a.date));

        // Deduplicate aliases
        mergedEntity.aliases = [...new Set(mergedEntity.aliases)];
        mergedEntity.structuredSections = sortStructuredSectionsBySchema(
          mergedEntity.type,
          mergedEntity.structuredSections ?? [],
          this.entitySchemas,
        );
        mergedEntity.facts = compileEntityFacts(mergedEntity.timeline, mergedEntity.structuredSections);

        const extraSectionKeys = new Set<string>();
        mergedEntity.extraSections = (mergedEntity.extraSections ?? []).filter((section) => {
          const key = `${section.title}::${section.lines.join("\n")}`;
          if (extraSectionKeys.has(key)) return false;
          extraSectionKeys.add(key);
          return true;
        });

        // Fallback name from canonical
        if (!mergedEntity.name) {
          const dashIdx = canonical.indexOf("-");
          mergedEntity.name = dashIdx !== -1 ? canonical.slice(dashIdx + 1) : canonical;
        }

        mergedEntity.created = mergedEntity.created || mergedEntity.updated || new Date().toISOString();
        mergedEntity.updated = mergedEntity.updated || new Date().toISOString();

        const canonicalPath = path.join(this.entitiesDir, `${canonical}.md`);
        await this.writeStorageSecureFile(canonicalPath, serializeEntityFile(mergedEntity, this.entitySchemas));

        // Remove non-canonical files
        for (const file of files) {
          const filePath = path.join(this.entitiesDir, file);
          if (filePath !== canonicalPath) {
            try {
              await unlink(filePath);
              merged++;
              log.debug(`merged entity ${file} → ${canonical}.md`);
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof SecureStoreLockedError || !isErrnoCode(err, "ENOENT")) throw err;
      // Directory doesn't exist yet
    }

    return merged;
  }

  async cleanExpiredCommitments(decayDays: number): Promise<MemoryFile[]> {
    const memories = await this.readAllMemories();
    const cutoff = Date.now() - decayDays * 24 * 60 * 60 * 1000;
    const deleted: MemoryFile[] = [];

    for (const m of memories) {
      if (m.frontmatter.category !== "commitment") continue;
      // Only decay commitments that have been marked as resolved/expired
      // (indicated by tags containing "fulfilled" or "expired")
      const isResolved = m.frontmatter.tags.some(
        (t) => t === "fulfilled" || t === "expired",
      );
      if (!isResolved) continue;

      const updatedAt = new Date(m.frontmatter.updated).getTime();
      if (updatedAt < cutoff) {
        // Remove the file
        try {
          await unlink(m.path);
          deleted.push(m);
          log.debug(`cleaned expired commitment ${m.frontmatter.id}`);
        } catch {
          // Ignore
        }
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
    let updated = 0;

    for (const entry of entries) {
      const memory = memoryMap.get(entry.memoryId);
      if (!memory) continue;

      const newFm: MemoryFrontmatter = {
        ...memory.frontmatter,
        accessCount: entry.newCount,
        lastAccessed: entry.lastAccessed,
      };

      const fileContent = `${serializeFrontmatter(newFm)}\n\n${memory.content}\n`;
      try {
        await this.writeStorageSecureFile(memory.path, fileContent);
        updated++;
      } catch (err) {
        log.debug(`failed to update access tracking for ${entry.memoryId}: ${err}`);
      }
    }

    if (updated > 0) {
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
   * Check which of the given memory IDs actually exist on disk.
   *
   * Uses a lightweight directory scan (collectActiveMemoryPaths) that reads
   * file names without parsing frontmatter — much cheaper than readAllMemories()
   * for simple existence checks like citation usage tracking.
   *
   * Returns the subset of `ids` that correspond to real memory files.
   */
  async filterExistingMemoryIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const wantedIds = new Set(ids);
    const filePaths = await this.collectActiveMemoryPaths();
    const foundIds = new Set<string>();
    for (const filePath of filePaths) {
      const basename = path.basename(filePath, ".md");
      if (wantedIds.has(basename)) {
        foundIds.add(basename);
        // Short-circuit once all requested IDs are found.
        if (foundIds.size === wantedIds.size) break;
      }
    }
    return foundIds;
  }

  async getProjectedMemoryState(id: string): Promise<MemoryProjectionCurrentState | null> {
    const projected = readProjectedMemoryState(this.baseDir, id);
    if (projected) return projected;

    const active = await this.getMemoryById(id);
    if (active) return this.toProjectedCurrentState(active, "active");

    const archived = (await this.readArchivedMemories()).find((memory) => memory.frontmatter.id === id);
    if (!archived) return null;

    return this.toProjectedCurrentState(archived, "archived");
  }

  async browseProjectedMemories(
    options: ProjectedMemoryBrowseOptions,
  ): Promise<ProjectedMemoryBrowsePage | null> {
    return readProjectedMemoryBrowse(this.baseDir, options);
  }

  async getProjectedGovernanceRecord(): Promise<ReturnType<typeof readProjectedGovernanceRecord>> {
    return readProjectedGovernanceRecord(this.baseDir);
  }

  private toProjectedCurrentState(
    memory: MemoryFile,
    fallbackStatus: MemoryStatus,
  ): MemoryProjectionCurrentState {
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

    const events = await this.readAllMemoryLifecycleEvents();
    return events.filter((event) => event.memoryId === memoryId).slice(-cappedLimit);
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
    } = {},
  ): Promise<string> {
    await this.ensureDirectories();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const id = `${parentId}-chunk-${chunkIndex}`;
    const conf = options.confidence ?? 0.8;
    const tier = confidenceTier(conf);
    const validAt = normalizeMemoryWriteTimestamp("validAt", options.validAt);

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
    };

    const sanitized = sanitizeMemoryContent(content);
    if (!sanitized.clean) {
      log.warn(`chunk content sanitized for ${id}; violations=${sanitized.violations.join(", ")}`);
    }
    const fileContent = `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`;

    let filePath: string;
    if (category === "correction") {
      filePath = path.join(this.correctionsDir, `${id}.md`);
    } else if (category === "procedure") {
      await mkdir(path.join(this.proceduresDir, today), { recursive: true });
      filePath = path.join(this.proceduresDir, today, `${id}.md`);
    } else if (category === "reasoning_trace") {
      // Issue #564 PR 3: chunks of a reasoning_trace memory live alongside the
      // parent in reasoning-traces/<date>/.
      await mkdir(path.join(this.reasoningTracesDir, today), { recursive: true });
      filePath = path.join(this.reasoningTracesDir, today, `${id}.md`);
    } else {
      filePath = path.join(this.factsDir, today, `${id}.md`);
    }

    await this.writeStorageSecureFile(filePath, fileContent);
    log.debug(`wrote chunk ${id} (${chunkIndex + 1}/${chunkTotal}) to ${filePath}`);
    return id;
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
  async supersedeMemory(
    oldMemoryId: string,
    newMemoryId: string,
    reason: string,
  ): Promise<boolean> {
    const memories = await this.readAllMemories();
    const oldMemory = memories.find((m) => m.frontmatter.id === oldMemoryId);
    if (!oldMemory) return false;

    const now = new Date().toISOString();
    const updatedFm: MemoryFrontmatter = {
      ...oldMemory.frontmatter,
      status: "superseded",
      supersededBy: newMemoryId,
      supersededAt: now,
      updated: now,
    };

    const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${oldMemory.content}\n`;

    try {
      await writeMaybeEncryptedFile(oldMemory.path, fileContent, this.resolveWriteKey(), {}, this.baseDir);
      await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.supersedeMemory", {
        memoryId: oldMemoryId,
        eventType: "superseded",
        timestamp: now,
        actor: "storage.supersedeMemory",
        reasonCode: reason,
        before: this.summarizeLifecycleState(oldMemory.frontmatter, oldMemory.path),
        after: this.summarizeLifecycleState(updatedFm, oldMemory.path),
        relatedMemoryIds: [newMemoryId],
      });
      this.bumpMemoryStatusVersion();
      log.debug(`superseded memory ${oldMemoryId} by ${newMemoryId}: ${reason}`);

      // Also write a correction entry for the audit trail
      await this.writeMemory("correction", `Superseded: ${oldMemory.content}\n\nReason: ${reason}`, {
        confidence: 1.0,
        tags: ["supersession", "auto-resolved"],
        source: "contradiction-detection",
        lineage: [oldMemoryId, newMemoryId],
      });

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
      const updatedFm: MemoryFrontmatter = {
        ...memory.frontmatter,
        status: "archived",
        archivedAt: now,
        updated: now,
      };

      const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${memory.content}\n`;

      try {
        await this.writeStorageSecureFile(memory.path, fileContent);
        await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.archiveMemories", {
          memoryId: id,
          eventType: "archived",
          timestamp: updatedFm.archivedAt ?? updatedFm.updated,
          actor: "storage.archiveMemories",
          reasonCode: `summary:${summaryId}`,
          before: this.summarizeLifecycleState(memory.frontmatter, memory.path),
          after: this.summarizeLifecycleState(updatedFm, memory.path),
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
    await this.writeStorageSecureFile(metaPath, JSON.stringify({ topics, updatedAt: new Date().toISOString() }, null, 2));
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
    lifecycle?: MemoryLifecycleEventWriteOptions,
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
        lifecycle,
      );
      log.debug(`added ${links.length} links to memory ${memoryId}`);
      return true;
    } catch (err) {
      log.error(`failed to add links to memory ${memoryId}:`, err);
      return false;
    }
  }

  private summarizeLifecycleState(
    frontmatter: MemoryFrontmatter,
    filePath: string,
  ): MemoryLifecycleStateSummary {
    return {
      category: frontmatter.category,
      path: filePath,
      status: frontmatter.status ?? "active",
      lifecycleState: frontmatter.lifecycleState,
    };
  }

  private frontmatterPatchEventType(
    before: MemoryFrontmatter,
    after: MemoryFrontmatter,
  ): MemoryLifecycleEventType {
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
    ruleVersion = "memory-lifecycle-ledger.v1",
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
    ruleVersion?: string,
  ): Promise<void> {
    try {
      await this.appendGeneratedMemoryLifecycleEvent(input, ruleVersion);
    } catch (appendErr) {
      log.warn(`${operation} completed but failed to append lifecycle event: ${appendErr}`);
    }
  }
}
