// ---------------------------------------------------------------------------
// Pure mapping functions: lossless-claw rows → Remnic LCM rows.
//
// Kept side-effect-free so they can be unit-tested without SQLite in the
// loop. The orchestration in importer.ts handles I/O.
// ---------------------------------------------------------------------------

import type {
  LosslessClawConversation,
  LosslessClawMessage,
  LosslessClawSummary,
  LosslessClawSummaryParent,
  LosslessClawSummaryMessage,
} from "./source.js";

export const LOSSLESS_CLAW_SOURCE_LABEL = "lossless-claw";

export interface MappedMessage {
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
  token_count: number;
  created_at: string;
  metadata: string;
}

export interface MappedSummaryNode {
  id: string;
  session_id: string;
  depth: number;
  parent_id: string | null;
  summary_text: string;
  token_count: number;
  msg_start: number;
  msg_end: number;
  escalation: number;
  created_at: string;
}

/**
 * Resolve a conversation row to a Remnic session_id. Prefer the explicit
 * session_id field; fall back to conversation_id when null/empty so every
 * imported row has a stable session anchor.
 */
export function resolveSessionId(
  conversation: LosslessClawConversation,
): string {
  const candidate = conversation.session_id?.trim();
  if (candidate && candidate.length > 0) return candidate;
  return conversation.conversation_id;
}

/**
 * Build a JSON metadata blob attached to each imported message. Sorted keys
 * (gotcha #38) so dedup or hashing downstream stays stable across runs.
 *
 * `source_seq` is the original `messages.seq` value from lossless-claw —
 * preserved alongside `conversation_id` so dedup can use a stable source
 * identity. The Remnic LCM `turn_index` is now a session-global running
 * counter (Codex P1: previously equal to `seq`, which collided when
 * multiple source conversations resolved to the same session).
 */
export function buildMessageMetadata(
  conversation: LosslessClawConversation,
  message: LosslessClawMessage,
): string {
  const meta: Record<string, string | number | null> = {
    conversation_id: conversation.conversation_id,
    identity_hash: message.identity_hash ?? null,
    source: LOSSLESS_CLAW_SOURCE_LABEL,
    source_seq: message.seq,
    title: conversation.title ?? null,
  };
  const sorted = Object.keys(meta)
    .sort()
    .reduce<Record<string, string | number | null>>((acc, key) => {
      acc[key] = meta[key] ?? null;
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

/**
 * Map a source message to a Remnic LCM row. `turnIndex` is supplied by the
 * caller (importer.ts) which assigns a session-global running counter so
 * multiple conversations sharing one session id do not collide on
 * (session_id, turn_index).
 */
export function mapMessage(
  conversation: LosslessClawConversation,
  message: LosslessClawMessage,
  turnIndex: number,
): MappedMessage {
  return {
    session_id: resolveSessionId(conversation),
    turn_index: turnIndex,
    role: message.role,
    content: message.content,
    token_count: message.token_count,
    created_at: message.created_at,
    metadata: buildMessageMetadata(conversation, message),
  };
}

export interface SummaryDerivation {
  parents: LosslessClawSummaryParent[];
  messageIds: string[];
}

/**
 * Pick the canonical parent id from a multi-parent DAG row. lossless-claw
 * supports many-to-many parent edges; Remnic's `lcm_summary_nodes.parent_id`
 * is a single FK. Lowest ordinal wins (tie-break: lexicographic id) so the
 * choice is deterministic. Multi-parent rows are reported by the importer so
 * users have visibility into the lossy edge.
 */
export function pickCanonicalParent(
  parents: LosslessClawSummaryParent[],
): string | null {
  if (parents.length === 0) return null;
  const sorted = [...parents].sort((a, b) => {
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    return a.parent_summary_id.localeCompare(b.parent_summary_id);
  });
  return sorted[0]!.parent_summary_id;
}

export interface MapSummaryInput {
  summary: LosslessClawSummary;
  parents: LosslessClawSummaryParent[];
  /** Sequence numbers of messages this summary covers. */
  messageSeqs: number[];
  /** Resolved session id (single value — multi-session summaries error). */
  sessionId: string;
}

export function mapSummary(input: MapSummaryInput): MappedSummaryNode {
  if (input.messageSeqs.length === 0) {
    throw new Error(
      `Summary ${input.summary.summary_id} has no message references; ` +
        "cannot derive msg_start/msg_end. Skip this summary at the caller.",
    );
  }
  // Iterative min/max — `Math.min(...arr)` / `Math.max(...arr)` push every
  // element onto the call stack via spread and throw `RangeError: Maximum
  // call stack size exceeded` on summaries that cover tens of thousands of
  // messages (Cursor Bugbot review on PR #797).
  let msg_start = input.messageSeqs[0]!;
  let msg_end = msg_start;
  for (let i = 1; i < input.messageSeqs.length; i++) {
    const seq = input.messageSeqs[i]!;
    if (seq < msg_start) msg_start = seq;
    if (seq > msg_end) msg_end = seq;
  }
  return {
    id: input.summary.summary_id,
    session_id: input.sessionId,
    depth: input.summary.depth,
    parent_id: pickCanonicalParent(input.parents),
    summary_text: input.summary.content,
    token_count: input.summary.token_count,
    msg_start,
    msg_end,
    escalation: 0,
    created_at:
      input.summary.latest_at ?? input.summary.earliest_at ?? new Date().toISOString(),
  };
}

/**
 * Determine if a summary has multiple parents (lossy-collapse signal).
 */
export function isMultiParent(parents: LosslessClawSummaryParent[]): boolean {
  return parents.length > 1;
}

/**
 * Resolve the (probable) single session for a summary by looking at the
 * messages it covers. lossless-claw summaries technically span multiple
 * conversations only via DAG construction, which Remnic's per-session
 * structure cannot represent — return null in that case so the caller can
 * skip the summary with a warning rather than picking a wrong session.
 *
 * Strict on dangling references: if ANY referenced message_id fails to
 * resolve to a session, return null. Silently dropping unresolved IDs
 * would let a summary with mixed valid + dangling refs pass through
 * with msg_start/msg_end computed from only the resolved subset, mis-
 * representing the summary's true coverage (Codex P2 review on PR #797).
 */
export function resolveSummarySession(
  messageIds: string[],
  sessionByMessageId: ReadonlyMap<string, string>,
): string | null {
  if (messageIds.length === 0) return null;
  const sessions = new Set<string>();
  for (const messageId of messageIds) {
    const session = sessionByMessageId.get(messageId);
    if (!session) return null; // dangling reference — refuse to import
    sessions.add(session);
  }
  if (sessions.size !== 1) return null;
  return [...sessions][0]!;
}

/**
 * Index summary_messages and messages so we can emit per-summary message-id
 * lists and seq lists without N+1 queries. Pure helper.
 */
export function indexSummaryDerivations(
  summaryMessages: LosslessClawSummaryMessage[],
  parents: LosslessClawSummaryParent[],
): Map<string, SummaryDerivation> {
  const out = new Map<string, SummaryDerivation>();
  for (const sm of summaryMessages) {
    const entry = out.get(sm.summary_id) ?? { parents: [], messageIds: [] };
    entry.messageIds.push(sm.message_id);
    out.set(sm.summary_id, entry);
  }
  for (const p of parents) {
    const entry = out.get(p.summary_id) ?? { parents: [], messageIds: [] };
    entry.parents.push(p);
    out.set(p.summary_id, entry);
  }
  return out;
}
