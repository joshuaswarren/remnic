/**
 * Wearable cross-source fusion — derived-day file serialization.
 *
 * One derived file per fused day, stored ALONGSIDE raw source transcripts
 * (under the wearables tree) but never overwriting them. Format mirrors
 * the day-transcript convention: YAML frontmatter (`kind:
 * wearable-fusion`) + a JSON body carrying the structured
 * `FusedWearableConversation[]`. The frontmatter `contentHash` is the
 * idempotency key derived from inputs plus the effective fusion config,
 * so an unchanged re-run (same inputs AND config) produces a
 * byte-identical file.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathIsInside } from "../../utils/path-containment.js";
import { isValidTranscriptDate } from "../day-store.js";
import type {
  FusedDayFile,
  FusedDayMeta,
  FusedWearableConversation,
} from "./types.js";

export const FUSION_KIND = "wearable-fusion" as const;

/** Hash the canonical JSON body for idempotent skip-unchanged checks. */
export function hashFusionBody(
  conversations: readonly FusedWearableConversation[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(conversations), "utf-8")
    .digest("hex");
}

export function composeFusionDayMeta(
  date: string,
  conversations: readonly FusedWearableConversation[],
  sources: readonly string[],
  contentHash: string,
  fusedAt: string,
): FusedDayMeta {
  return {
    kind: FUSION_KIND,
    date,
    sourceCount: sources.length,
    conversationCount: conversations.length,
    contentHash,
    bodyHash: hashFusionBody(conversations),
    fusedAt,
  };
}

/** Serialize meta + conversations into the persisted file format. */
export function serializeFusionDay(
  meta: FusedDayMeta,
  conversations: readonly FusedWearableConversation[],
): string {
  const lines: string[] = ["---"];
  lines.push(`kind: ${meta.kind}`);
  lines.push(`date: ${JSON.stringify(meta.date)}`);
  lines.push(`sourceCount: ${meta.sourceCount}`);
  lines.push(`conversationCount: ${meta.conversationCount}`);
  lines.push(`contentHash: ${JSON.stringify(meta.contentHash)}`);
  lines.push(`bodyHash: ${JSON.stringify(meta.bodyHash)}`);
  lines.push(`fusedAt: ${JSON.stringify(meta.fusedAt)}`);
  lines.push("---");
  lines.push("");
  return `${lines.join("\n")}\n${JSON.stringify(conversations, null, 2)}\n`;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to the raw value below.
    }
  }
  return trimmed;
}

function parseNonNegativeInt(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

const FUSED_SEGMENT_PICK_REASONS: Record<string, true> = {
  "only-source": true,
  "higher-trust": true,
  "more-complete": true,
  "tie-break": true,
};

const FUSED_DISAGREEMENT_KINDS: Record<string, true> = {
  "asr-text": true,
  speaker: true,
  timestamp: true,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Structural guard for a parsed segment-provenance record. */
function isFusedSegmentProvenance(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.source !== "string") return false;
  if (typeof value.conversationId !== "string") return false;
  if (typeof value.sourceTrust !== "number") return false;
  if (typeof value.reason !== "string") return false;
  if (!(value.reason in FUSED_SEGMENT_PICK_REASONS)) return false;
  return (
    Array.isArray(value.alternatives) &&
    value.alternatives.every(
      (alt) =>
        isPlainObject(alt) && typeof alt.source === "string" && typeof alt.text === "string",
    )
  );
}

/** Structural guard for a parsed fused segment. */
function isFusedSegment(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.speaker !== "string") return false;
  if (typeof value.isSelf !== "boolean") return false;
  if (typeof value.text !== "string") return false;
  if (typeof value.confidence !== "number") return false;
  return isFusedSegmentProvenance(value.provenance);
}

/** Structural guard for a parsed fused speaker. */
function isFusedSpeaker(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.label !== "string") return false;
  if (typeof value.isSelf !== "boolean") return false;
  if (typeof value.confidence !== "number") return false;
  return isStringArray(value.sources);
}

/** Structural guard for a parsed fused disagreement. */
function isFusedDisagreement(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.kind !== "string") return false;
  if (!(value.kind in FUSED_DISAGREEMENT_KINDS)) return false;
  if (typeof value.subject !== "string") return false;
  return (
    Array.isArray(value.candidates) &&
    value.candidates.every(
      (cand) =>
        isPlainObject(cand) && typeof cand.source === "string" && typeof cand.value === "string",
    )
  );
}

/** Structural guard for a parsed fused-conversation contribution record. */
function isFusedContribution(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.source !== "string") return false;
  if (typeof value.conversationId !== "string") return false;
  if (typeof value.startIso !== "string") return false;
  return typeof value.segmentCount === "number";
}

/** Structural guard for a parsed fused-conversation provenance record. */
function isFusedConversationProvenance(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!Array.isArray(value.contributions) || !value.contributions.every(isFusedContribution)) {
    return false;
  }
  if (typeof value.proximityGapMs !== "number") return false;
  if (typeof value.windowToleranceMs !== "number") return false;
  return value.method === "time-proximity";
}

/**
 * Structural guard for a parsed fused conversation. Every required field of
 * `FusedWearableConversation` (and its nested segments / speakers /
 * disagreements / provenance) must be present with the right shape, so a
 * null, wrong-typed, or partial element (`[{}]`, `[null]`, `[{id:1}]`) is
 * rejected and the caller treats the body as corrupt (parseOk:false →
 * self-repair rewrite) rather than trusting it.
 */
function isFusedWearableConversation(value: unknown): value is FusedWearableConversation {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.date !== "string") return false;
  if (typeof value.startIso !== "string") return false;
  if (!isStringArray(value.sources)) return false;
  if (!Array.isArray(value.speakers) || !value.speakers.every(isFusedSpeaker)) return false;
  if (!Array.isArray(value.segments) || !value.segments.every(isFusedSegment)) return false;
  if (!Array.isArray(value.disagreements) || !value.disagreements.every(isFusedDisagreement)) {
    return false;
  }
  return isFusedConversationProvenance(value.provenance);
}

/**
 * Parse a persisted fused-day file. Returns null when the content does
 * not look like a fusion artifact (wrong kind / missing frontmatter) so
 * callers can distinguish "not fused" from a malformed file. A non-null
 * result carries `parseOk`: false when the JSON body failed to parse, was
 * not an array, or held a malformed element (conversations is empty in
 * that case), true for a well-formed (incl. legitimately-empty `[]`)
 * body — so the skip-unchanged path can force a self-repair rewrite
 * regardless of the recomputed conversation count or body hash.
 */
export function parseFusionDay(raw: string): FusedDayFile | null {
  if (!raw.startsWith("---\n")) return null;
  const closeIndex = raw.indexOf("\n---\n", 4);
  if (closeIndex === -1) return null;
  const header = raw.slice(4, closeIndex);
  const body = raw.slice(closeIndex + 5).replace(/^\n/, "");

  const scalars = new Map<string, string>();
  for (const line of header.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*): (.*)$/);
    if (match) scalars.set(match[1], parseScalar(match[2]));
  }

  if (scalars.get("kind") !== FUSION_KIND) return null;
  const date = scalars.get("date");
  if (date === undefined) return null;

  let conversations: FusedWearableConversation[] = [];
  let parseOk = true;
  const bodyTrimmed = body.trim();
  if (bodyTrimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(bodyTrimmed);
      if (Array.isArray(parsed) && parsed.every(isFusedWearableConversation)) {
        conversations = parsed;
      } else {
        // Valid JSON but not a well-formed FusedWearableConversation[]
        // (non-array, or an array carrying a null / wrong-typed /
        // missing-required-field element) — flag corrupt so callers
        // recompute fusion rather than trusting a partial read. A
        // legitimately-empty [] is accepted with parseOk left true.
        parseOk = false;
      }
    } catch {
      // A truncated/corrupt body fails to parse; flag parseOk:false so the
      // skip-unchanged path forces a self-repair rewrite (even when the
      // frontmatter hash matches and the recomputed count is also zero).
      parseOk = false;
    }
  }

  const meta: FusedDayMeta = {
    kind: FUSION_KIND,
    date,
    sourceCount: parseNonNegativeInt(scalars.get("sourceCount")),
    conversationCount: parseNonNegativeInt(scalars.get("conversationCount")),
    contentHash: scalars.get("contentHash") ?? "",
    bodyHash: scalars.get("bodyHash") ?? "",
    fusedAt: scalars.get("fusedAt") ?? "",
  };
  return { meta, conversations, parseOk };
}

/** Reserved underscore-prefixed subdir for derived fusion artifacts. */
export const FUSION_DIR_NAME = "_fusion";

/**
 * Encrypted-at-rest + atomic file IO the fusion artifact store needs.
 * Satisfied by StorageManager (which owns the secure-store key + atomic
 * write path) and injected so this module performs NO direct fs — the
 * derived files inherit the same encrypted-at-rest + atomic-write
 * semantics as raw day transcripts without this module knowing the key.
 */
export interface FusionFileIo {
  writeFile(filePath: string, content: string): Promise<void>;
  /** Read a file; rejects with ENOENT when it is absent. */
  readFile(filePath: string): Promise<string>;
  /** Directory entries; rejects with ENOENT when the directory is absent. */
  readDir(dirPath: string): Promise<string[]>;
  /**
   * Resolve a path through symlinks (node:fs/promises realpath); rejects
   * with ENOENT when the path is absent. Used by the symlink-containment
   * guard so a symlinked `_fusion` dir (or parent) that resolves outside
   * the wearables root is rejected before any read/write (AGENTS.md #3).
   */
  realpath(filePath: string): Promise<string>;
}

/**
 * Owns the derived fused-day artifact files under
 * `<wearablesDir>/_fusion/<YYYY-MM-DD>.md`. Path construction, date
 * validation, and newest-first listing live here (relocated out of the
 * root storage module — issue #1810 ratchet); the bytes flow through the
 * injected secure IO.
 */
export class FusionArtifactStore {
  constructor(
    private readonly wearablesDir: string,
    private readonly io: FusionFileIo,
  ) {}

  fusedDayPath(date: string): string {
    if (!isValidTranscriptDate(date)) {
      throw new Error(
        `invalid wearable fusion date '${String(date)}' — expected YYYY-MM-DD`,
      );
    }
    return path.join(this.wearablesDir, FUSION_DIR_NAME, `${date}.md`);
  }

  async writeFusedDay(date: string, serialized: string): Promise<void> {
    const filePath = this.fusedDayPath(date);
    await this.assertPathContained(filePath);
    await this.io.writeFile(filePath, serialized);
  }

  /** Read a stored fused-day artifact; null when absent. */
  async readFusedDay(date: string): Promise<string | null> {
    const filePath = this.fusedDayPath(date);
    await this.assertPathContained(filePath);
    try {
      return await this.io.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** List dates with stored fused artifacts, newest first. */
  async listFusedDays(): Promise<string[]> {
    const fusionDir = path.join(this.wearablesDir, FUSION_DIR_NAME);
    await this.assertPathContained(fusionDir);
    let entries: string[];
    try {
      entries = await this.io.readDir(fusionDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const days: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const date = entry.slice(0, -3);
      if (!isValidTranscriptDate(date)) continue;
      days.push(date);
    }
    days.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    return days;
  }

  /**
   * Reject a symlinked/traversing fusion artifact path before any IO. The
   * fusion dir (`<wearablesDir>/_fusion`) and its parents are followed
   * directly by the secure IO; a symlink placed there (attacker-writable
   * or a malformed memory dir) would otherwise be followed and read/write
   * outside the allowed root (AGENTS.md pattern #3). Resolve the candidate
   * and the wearables root through realpath and refuse anything that
   * escapes — mirroring `assertPathInsideRoot` in the storage walkers.
   * Absent paths are allowed (the secure write creates them lexically
   * under the root; a missing path cannot yet be a followable symlink).
   */
  private async assertPathContained(targetPath: string): Promise<void> {
    let rootReal: string;
    try {
      rootReal = await this.io.realpath(this.wearablesDir);
    } catch {
      // Fresh dir not yet on disk — no symlink can resolve through a
      // missing root, so fall back to a lexical resolve.
      rootReal = path.resolve(this.wearablesDir);
    }
    // Guard both the fusion directory (the entry a writer controls) and,
    // when present, the target file itself.
    for (const candidate of [path.dirname(targetPath), targetPath]) {
      let candidateReal: string;
      try {
        candidateReal = await this.io.realpath(candidate);
      } catch {
        continue; // absent — nothing to follow
      }
      if (!pathIsInside(rootReal, candidateReal)) {
        throw new Error(
          "wearable fusion artifact path resolves outside the wearables root — refusing to follow a symlink/traversal (AGENTS.md pattern #3)",
        );
      }
    }
  }
}
