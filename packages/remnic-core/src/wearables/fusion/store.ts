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
