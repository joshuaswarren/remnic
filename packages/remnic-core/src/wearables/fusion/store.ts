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

/**
 * Parse a persisted fused-day file. Returns null when the content does
 * not look like a fusion artifact (wrong kind / missing frontmatter) so
 * callers can distinguish "not fused" from a malformed file.
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
  const bodyTrimmed = body.trim();
  if (bodyTrimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(bodyTrimmed);
      if (Array.isArray(parsed)) {
        conversations = parsed as FusedWearableConversation[];
      }
    } catch {
      // A truncated/corrupt body parses to no conversations rather than
      // throwing — callers recompute fusion rather than crashing reads.
      conversations = [];
    }
  }

  const meta: FusedDayMeta = {
    kind: FUSION_KIND,
    date,
    sourceCount: parseNonNegativeInt(scalars.get("sourceCount")),
    conversationCount: parseNonNegativeInt(scalars.get("conversationCount")),
    contentHash: scalars.get("contentHash") ?? "",
    fusedAt: scalars.get("fusedAt") ?? "",
  };
  return { meta, conversations };
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
    await this.io.writeFile(this.fusedDayPath(date), serialized);
  }

  /** Read a stored fused-day artifact; null when absent. */
  async readFusedDay(date: string): Promise<string | null> {
    try {
      return await this.io.readFile(this.fusedDayPath(date));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** List dates with stored fused artifacts, newest first. */
  async listFusedDays(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await this.io.readDir(
        path.join(this.wearablesDir, FUSION_DIR_NAME),
      );
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
}
