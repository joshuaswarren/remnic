// ---------------------------------------------------------------------------
// Participant mapper — extracts entity-like records from import turns
// ---------------------------------------------------------------------------

import type { ImportTurn } from "@remnic/core";
import { parseIsoTimestamp } from "@remnic/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParticipantEntity {
  id: string;
  name: string;
  messageCount: number;
  firstSeen: string;
  lastSeen: string;
  /** Inferred relationship: "self", "frequent", or "occasional". */
  relationship?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Participants with more than this fraction of total messages are "frequent". */
const FREQUENT_THRESHOLD = 0.1;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build participant entity records from an array of import turns.
 *
 * - The parser-inferred user participant is tagged "self" when role data exists.
 * - The participant with the most messages is tagged "self" as a fallback.
 * - Participants with >10% of total messages are "frequent".
 * - Everyone else is "occasional".
 * - Turns without `participantId` are silently skipped.
 */
export function mapParticipants(turns: ImportTurn[]): ParticipantEntity[] {
  if (!turns || turns.length === 0) return [];

  const stats = new Map<
    string,
    {
      name: string;
      count: number;
      userRoleCount: number;
      firstTs: number;
      lastTs: number;
      firstRaw: string;
      lastRaw: string;
    }
  >();

  for (const turn of turns) {
    const id = turn.participantId;
    if (!id) continue;

    const ts = parseIsoTimestamp(turn.timestamp) ?? 0;
    const existing = stats.get(id);

    if (existing) {
      existing.count += 1;
      if (turn.role === "user") existing.userRoleCount += 1;
      if (ts < existing.firstTs) {
        existing.firstTs = ts;
        existing.firstRaw = turn.timestamp;
      }
      if (ts > existing.lastTs) {
        existing.lastTs = ts;
        existing.lastRaw = turn.timestamp;
      }
    } else {
      stats.set(id, {
        name: turn.participantName ?? id,
        count: 1,
        userRoleCount: turn.role === "user" ? 1 : 0,
        firstTs: ts,
        lastTs: ts,
        firstRaw: turn.timestamp,
        lastRaw: turn.timestamp,
      });
    }
  }

  if (stats.size === 0) return [];

  // Prefer the participant the parser already classified as the user.
  let roleSelfId = "";
  let topUserRoleCount = 0;
  for (const [id, s] of stats.entries()) {
    if (s.userRoleCount > topUserRoleCount) {
      topUserRoleCount = s.userRoleCount;
      roleSelfId = id;
    }
  }

  // Fall back to the top sender for legacy turns without role data.
  let topId = "";
  let topCount = 0;
  for (const [id, s] of stats.entries()) {
    if (s.count > topCount) {
      topCount = s.count;
      topId = id;
    }
  }

  // Match the stats-loop filter above (`if (!id) continue;`) so the
  // denominator only counts turns that actually contributed to a
  // participant's stats.  Turns with empty-string `participantId`
  // are excluded from both sides, keeping frequency ratios accurate.
  const totalMessages = turns.filter((t) => !!t.participantId).length;

  const result: ParticipantEntity[] = [];
  const selfId = roleSelfId || topId;
  for (const [id, s] of stats.entries()) {
    let relationship: string;
    if (id === selfId) {
      relationship = "self";
    } else if (s.count / totalMessages > FREQUENT_THRESHOLD) {
      relationship = "frequent";
    } else {
      relationship = "occasional";
    }

    result.push({
      id,
      name: s.name,
      messageCount: s.count,
      firstSeen: s.firstRaw,
      lastSeen: s.lastRaw,
      relationship,
    });
  }

  // Sort by message count descending, then by id for stability
  result.sort((a, b) => {
    if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
    return a.id.localeCompare(b.id);
  });

  return result;
}
