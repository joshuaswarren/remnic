
/**
 * Kind of peer.
 *
 * - `self`     — the current Remnic operator (replaces singular identity-anchor).
 * - `human`    — another human collaborator distinct from self.
 * - `agent`    — another AI agent (Claude Code, Codex, Hermes, etc.).
 * - `integration` — non-conversational integration (cron, webhook, importer).
 */
export type PeerKind = "self" | "human" | "agent" | "integration";

/**
 * Stable, slow-changing facts about a peer.
 *
 * `id` matches `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`, 1-64 chars,
 * with no leading/trailing/consecutive dots or dashes. Stored on disk under
 * `peers/{id}/identity.md` as YAML frontmatter + markdown body.
 */
export interface Peer {
  /** Stable, opaque identifier. See PEER_ID_PATTERN. */
  readonly id: string;
  /** Kind of peer. Drives default profile schema and recall posture. */
  readonly kind: PeerKind;
  /** Human-readable display name. Distinct from `id`; mutable. */
  readonly displayName: string;
  /** ISO-8601 timestamp of first registration. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of most recent update to identity. */
  readonly updatedAt: string;
  /** Optional free-form markdown body for the identity kernel. */
  readonly notes?: string;
}

export interface PeerProfile {
  readonly peerId: string;
  /** ISO-8601 timestamp of most recent profile mutation. */
  readonly updatedAt: string;
  /**
   * Arbitrary key/value profile fields. Values are markdown strings.
   * Keys are stable section identifiers (e.g. `communication_style`,
   * `recurring_concerns`). The reasoner is responsible for choosing
   * keys; this PR does not constrain them beyond requiring strings.
   */
  readonly fields: Record<string, string>;
  /**
   * Per-field provenance. Maps field key → list of provenance entries.
   * A field may have multiple sources (the reasoner accumulates evidence
   * across sessions before promoting a field).
   */
  readonly provenance: Record<string, ReadonlyArray<PeerProfileFieldProvenance>>;
}

/**
 * Provenance for a single profile-field mutation.
 *
 * Reasoner output (PR 2/5) attaches one of these every time it touches a
 * field, so the user can audit exactly why a profile claim exists.
 */
export interface PeerProfileFieldProvenance {
  /** ISO-8601 timestamp the field was set/updated by this signal. */
  readonly observedAt: string;
  /** Originating session id (or other source identifier). */
  readonly sourceSessionId?: string;
  /** Short label for the signal type (e.g. "explicit_preference"). */
  readonly signal: string;
  /** Optional free-form note explaining the inference. */
  readonly note?: string;
}

export interface PeerInteractionLogEntry {
  /** ISO-8601 timestamp the interaction occurred. */
  readonly timestamp: string;
  /** Originating session id, if any. */
  readonly sessionId?: string;
  /** Short kind label (e.g. "message", "tool_call", "preference_set"). */
  readonly kind: string;
  /** Free-form markdown summary of the interaction. */
  readonly summary: string;
}

/**
 * Regex enforced on `Peer.id`. Exported so callers can mirror validation
 * before constructing a `Peer`.
 *
 * Rules:
 *   - 1-64 characters total
 *   - First and last character must be `[A-Za-z0-9]`
 *   - Interior may contain `.`, `_`, `-` in addition to alphanumerics
 *   - No leading or trailing dot/dash/underscore
 *   - No consecutive separators (`..`, `--`, `__`, `.-`, etc.)
 *
 * Cursor Medium: previously the regex allowed `a..b` even though the
 * docs claimed otherwise — a separate JS-side check enforced the rule
 * but the standalone PATTERN was wrong for any external consumer
 * relying on it. Tighten the regex itself so PEER_ID_PATTERN is the
 * single source of truth: an alphanumeric, optionally followed by
 * groups of (one separator + one-or-more alphanumerics), with the
 * final group ending on an alphanumeric. Negative lookahead-free so
 * it works in any JS engine.
 */
export const PEER_ID_PATTERN = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;

/** Maximum length for `Peer.id`. */
export const PEER_ID_MAX_LENGTH = 64;
