//
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

export function isMultiParent(parents: LosslessClawSummaryParent[]): boolean {
  return parents.length > 1;
}

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
