/**
 * Normalize Limitless lifelogs into Remnic's provider-agnostic
 * `WearableConversation` shape.
 *
 * Spoken dialogue lives in `blockquote` content nodes (possibly nested
 * under headings via `children`); heading nodes structure the lifelog
 * and are not utterances. The wearer is marked by
 * `speakerIdentifier === "user"`; everyone else carries a
 * `speakerName` ("Speaker 2" or a saved name).
 */

import type {
  WearableConversation,
  WearableTranscriptSegment,
} from "@remnic/core";

import type { LimitlessContentNode, LimitlessLifelog } from "./client.js";

export const LIMITLESS_SOURCE_ID = "limitless";

/** Guard against pathological nesting in provider payloads. */
const MAX_NODE_DEPTH = 16;

export function lifelogToConversation(
  lifelog: LimitlessLifelog,
): WearableConversation {
  const segments: WearableTranscriptSegment[] = [];
  collectSegments(lifelog.contents ?? [], segments, 0);
  return {
    id: lifelog.id,
    source: LIMITLESS_SOURCE_ID,
    title: typeof lifelog.title === "string" ? lifelog.title : undefined,
    startIso: lifelog.startTime ?? "",
    endIso: lifelog.endTime,
    segments,
  };
}

function collectSegments(
  nodes: LimitlessContentNode[],
  out: WearableTranscriptSegment[],
  depth: number,
): void {
  if (depth > MAX_NODE_DEPTH) return;
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    if (node.type === "blockquote" && typeof node.content === "string") {
      const text = node.content.trim();
      if (text.length > 0) {
        const isWearer = node.speakerIdentifier === "user";
        const speakerName =
          typeof node.speakerName === "string" && node.speakerName.trim().length > 0
            ? node.speakerName.trim()
            : undefined;
        out.push({
          text,
          // The wearer's stable key is "user"; other speakers key by the
          // provider name so saved names survive across lifelogs and the
          // registry can re-label "Speaker 2" everywhere at once.
          speakerKey: isWearer ? "user" : (speakerName ?? "unknown"),
          ...(speakerName !== undefined ? { speakerName } : {}),
          ...(isWearer ? { isWearer: true } : {}),
          ...(typeof node.startTime === "string" ? { startIso: node.startTime } : {}),
          ...(typeof node.endTime === "string" ? { endIso: node.endTime } : {}),
        });
      }
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      collectSegments(node.children, out, depth + 1);
    }
  }
}
