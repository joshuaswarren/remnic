/**
 * Recall state-view evidence packets (issue #1952).
 *
 * Groups labeled state-view entries into per-head evidence packets so
 * superseded records stay visible as ordered history instead of being
 * hidden or interleaved with another packet's entries. Pure. Surfaces wait.
 */
import type { StateLabel } from "./recall-state-view.js";

export type { StateLabel };

export interface StateViewEntry {
  memoryId: string;
  stateLabel: StateLabel;
  /** Id of the entry that superseded this one, when any. */
  supersededById?: string;
}

export interface StateEvidencePacket {
  /** The current (or transition) entry this packet is about. */
  headId: string;
  /** Predecessors, nearest to head first. Never interleaved with other packets. */
  historyIds: string[];
}

export interface StateEvidencePackets {
  packets: StateEvidencePacket[];
  /** Historical entries whose successor is absent from the input. */
  orphanHistoryIds: string[];
}

const STATE_LABELS: readonly StateLabel[] = ["current", "historical", "transition"];

interface HeadResolution {
  headId: string;
  depth: number;
}

interface Attachment {
  headId: string;
  historyId: string;
  depth: number;
}

/**
 * Walk supersededById forward through intermediate historical entries and
 * stop at the first current/transition successor. Returns undefined when the
 * walk dead-ends (no or blank successor, successor id absent from the input)
 * or revisits an id (cycle), so callers treat the entry as an orphan.
 */
function resolveHead(
  entry: StateViewEntry,
  byId: ReadonlyMap<string, StateViewEntry>,
): HeadResolution | undefined {
  const visited = new Set<string>();
  let current = entry;
  let depth = 0;
  for (;;) {
    const successorId = current.supersededById;
    if (successorId === undefined || successorId.trim() === "") return undefined;
    const successor = byId.get(successorId);
    if (successor === undefined) return undefined;
    depth += 1;
    if (successor.stateLabel !== "historical") return { headId: successorId, depth };
    if (visited.has(successorId)) return undefined;
    visited.add(successorId);
    current = successor;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareAttachments(a: Attachment, b: Attachment): number {
  if (a.headId !== b.headId) return compareStrings(a.headId, b.headId);
  if (a.depth !== b.depth) return a.depth < b.depth ? -1 : 1;
  return compareStrings(a.historyId, b.historyId);
}

export function buildStateEvidencePackets(
  entries: readonly StateViewEntry[],
): StateEvidencePackets {
  // Validate every label before any skip, dedup, or walk.
  for (const entry of entries) {
    if (!(STATE_LABELS as readonly string[]).includes(entry.stateLabel)) {
      throw new TypeError(
        `unknown state label ${JSON.stringify(entry.stateLabel)}; expected one of "current", "historical", "transition"`,
      );
    }
  }

  // Blank ids are ignored; on duplicate ids the first entry wins.
  const byId = new Map<string, StateViewEntry>();
  for (const entry of entries) {
    if (typeof entry.memoryId !== "string" || entry.memoryId.trim() === "") continue;
    if (!byId.has(entry.memoryId)) byId.set(entry.memoryId, entry);
  }

  // ponytail: per-entry chain walks are O(n^2) on one long chain; recall-sized
  // result sets stay tiny, memoize if packet building ever moves offline.
  const packets: StateEvidencePacket[] = [];
  const packetByHead = new Map<string, StateEvidencePacket>();
  const attachments: Attachment[] = [];
  const orphanHistoryIds: string[] = [];

  for (const [id, entry] of byId) {
    if (entry.stateLabel !== "historical") {
      const packet: StateEvidencePacket = { headId: id, historyIds: [] };
      packetByHead.set(id, packet);
      packets.push(packet);
      continue;
    }
    const head = resolveHead(entry, byId);
    if (head === undefined) orphanHistoryIds.push(id);
    else attachments.push({ headId: head.headId, historyId: id, depth: head.depth });
  }

  attachments.sort(compareAttachments);
  for (const attachment of attachments) {
    const packet = packetByHead.get(attachment.headId);
    if (packet) packet.historyIds.push(attachment.historyId);
  }

  packets.sort((a, b) => compareStrings(a.headId, b.headId));
  orphanHistoryIds.sort(compareStrings);
  return { packets, orphanHistoryIds };
}
