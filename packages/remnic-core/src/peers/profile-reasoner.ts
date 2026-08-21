/**
 * Peer profile reasoner — issue #679 PR 2/5.
 *
 * Pure async function that, for each peer:
 *
 *   1. Reads recent interaction-log entries via `readPeerInteractionLog`.
 *   2. Calls an injected LLM client (same chat shape as
 *      `FallbackLlmClient.chatCompletion`) to derive 0..N profile-field
 *      proposals with provenance `{observedAt, signal, sourceSessionId,
 *      note}`.
 *   3. Merges the proposals into the peer's existing `PeerProfile`,
 *      appending provenance entries (never replacing existing
 *      provenance — the reasoner is additive by design so the operator
 *      retains the full audit trail).
 *   4. Writes via `writePeerProfile`.
 *
 * Gating is handled in two layers:
 *
 *   - The orchestrator wires the call behind the
 *     `peerProfileReasonerEnabled` config flag (default `false` —
 *     opt-in per Gotcha #30/#48). The reasoner ALSO short-circuits
 *     when `options.enabled !== true`, so direct callers can't
 *     accidentally bypass the flag.
 *   - Per-peer, the `peerProfileReasonerMinInteractions` threshold
 *     skips peers whose log has fewer entries since the last reasoner
 *     run than required.
 *
 * The reasoner is intentionally storage-agnostic — it accepts an LLM
 * client by interface (`PeerProfileReasonerLlm`) so tests can mock the
 * call and the orchestrator can inject either the gateway client or
 * a fast local model. No direct OpenAI imports here.
 */

import {
  appendInteractionLog,
  listPeers,
  readPeerInteractionLog,
  readPeerProfile,
  writePeerProfile,
} from "./storage.js";
import type {
  Peer,
  PeerInteractionLogEntry,
  PeerProfile,
  PeerProfileFieldProvenance,
} from "./types.js";
import { PEER_ID_PATTERN } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal chat-completion contract the reasoner depends on. Matches
 * `FallbackLlmClient.chatCompletion` so the orchestrator can pass it
 * through directly. Tests inject a mock that returns canned strings.
 *
 * Returning `null` means the LLM is unavailable / failed — the
 * reasoner treats that as "no proposals for this peer" rather than an
 * error so a flaky LLM never aborts the whole pass.
 */
export interface PeerProfileReasonerLlm {
  chatCompletion(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: { temperature?: number; maxTokens?: number; timeoutMs?: number },
  ): Promise<{ content: string } | null>;
}

/**
 * One LLM-proposed profile-field update.
 *
 * `value` is the new markdown string to set under `field`. The
 * provenance entry the LLM emits travels alongside it; the reasoner
 * does NOT trust the LLM's `observedAt` — it always overwrites with
 * the run's `now` timestamp so provenance can never claim future or
 * past observation timestamps the operator didn't witness.
 */
export interface PeerProfileReasonerProposal {
  /** Stable section key, e.g. "communication_style". */
  readonly field: string;
  /** Markdown value to set under that key. */
  readonly value: string;
  /**
   * Short label for the signal that justified the inference,
   * e.g. "explicit_preference", "tool_pattern", "topic_recurrence".
   */
  readonly signal: string;
  /** Optional free-form note explaining the inference. */
  readonly note?: string;
  /**
   * Originating session id, when the LLM can attribute the inference
   * to a specific log line. Reasoner clamps this to a value that
   * actually appeared in the log window so the LLM can't hallucinate.
   */
  readonly sourceSessionId?: string;
}

export interface PeerProfileReasonerOptions {
  /** Memory directory containing the peers/ subtree. */
  readonly memoryDir: string;
  /**
   * Master gate. When `false` (the default the orchestrator passes
   * when the config flag is off), the reasoner is a no-op and
   * returns an empty result. Direct callers must explicitly pass
   * `true` so the gate can never be defaulted ON by accident
   * (Gotcha #48 — least-privileged default).
   */
  readonly enabled: boolean;
  /** Injected LLM client. Required when `enabled === true`. */
  readonly llm?: PeerProfileReasonerLlm;
  /** Model name to log for telemetry; not used to dispatch. */
  readonly model?: string;
  /**
   * Minimum new interaction-log entries since last reasoner run
   * before this peer is processed. Peers below the threshold are
   * skipped with `reason: "below_min_interactions"`.
   */
  readonly minInteractions: number;
  /**
   * Hard cap on profile fields the reasoner will accept across all
   * peers in a single run. Tracked in insertion order: once the cap
   * is reached, subsequent proposals are dropped with
   * `dropped_due_to_cap` in the per-peer result. Use to bound LLM
   * cost and reviewer load per pass.
   */
  readonly maxFieldsPerRun: number;
  /**
   * Optional restriction to specific peer ids. When omitted, the
   * reasoner enumerates the entire peer registry via `listPeers`.
   */
  readonly peerIds?: ReadonlyArray<string>;
  /**
   * Maximum number of recent log entries to feed the LLM per peer.
   * Defaults to 50. Bounded so a runaway log can't blow the prompt.
   */
  readonly maxLogEntriesPerPeer?: number;
  /**
   * Reasoner run timestamp. Defaults to `new Date()` at call time.
   * Tests inject a deterministic clock; the orchestrator passes
   * `new Date()` so provenance entries reflect actual wall time.
   */
  readonly now?: Date;
  /**
   * Optional logger; defaults to a no-op so the reasoner stays
   * silent in unit tests. The orchestrator wires its `log` here so
   * runs surface in the gateway log under the
   * `[peer-profile-reasoner]` prefix.
   */
  readonly log?: {
    debug?: (msg: string) => void;
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
  /**
   * Whether to append a `peer_profile_reasoner_run` entry to the
   * peer's interaction log when the reasoner emits at least one
   * field for that peer. Defaults to `true`. Disable in tests that
   * want to assert the log was untouched.
   */
  readonly appendRunMarkerToLog?: boolean;
  /**
   * Optional abort signal. The reasoner checks between peers and
   * returns the partial result if cancelled mid-run.
   */
  readonly signal?: AbortSignal;
}

export interface PeerProfileReasonerPeerResult {
  readonly peerId: string;
  readonly status:
    | "processed"
    | "skipped_below_min_interactions"
    | "skipped_no_log"
    | "skipped_disabled"
    | "skipped_no_llm"
    | "skipped_llm_unavailable"
    | "skipped_invalid_proposal"
    | "skipped_cap_reached"
    | "skipped_aborted"
    | "error";
  /** Number of fields actually applied to the peer's profile. */
  readonly fieldsApplied: number;
  /** Number of proposals dropped because the per-run cap was hit. */
  readonly droppedDueToCap: number;
  /** Set of field keys applied; useful for tests and telemetry. */
  readonly fields: ReadonlyArray<string>;
  /** Error message, when `status === "error"`. */
  readonly error?: string;
}

export interface PeerProfileReasonerResult {
  readonly peersConsidered: number;
  readonly peersProcessed: number;
  readonly fieldsApplied: number;
  readonly perPeer: ReadonlyArray<PeerProfileReasonerPeerResult>;
}

// ──────────────────────────────────────────────────────────────────────
// Prompt + parser (pure, exported for tests)
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the user-facing reasoner prompt. The system message carries
 * the strict-JSON instruction; this function emits the user message
 * with the peer context and the recent log slice.
 *
 * The prompt is intentionally schema-prescriptive — sibling modules
 * (`semantic-consolidation.ts`, `extraction-judge.ts`) demonstrated
 * that letting the LLM improvise field names produces unstable
 * profiles across runs.
 */
export function buildPeerProfileReasonerPrompt(input: {
  peer: Peer;
  existingProfile: PeerProfile | null;
  log: ReadonlyArray<PeerInteractionLogEntry>;
  maxFields: number;
}): string {
  const existingFields = input.existingProfile
    ? Object.keys(input.existingProfile.fields)
    : [];
  const logBlock = input.log
    .map((e) => {
      const session = e.sessionId ? ` session=${e.sessionId}` : "";
      return `- [${e.timestamp}] (${e.kind})${session} ${e.summary}`;
    })
    .join("\n");
  return [
    `You are an async peer-profile reasoner. Your job is to read recent interaction-log entries for one peer and propose 0..${input.maxFields} profile-field updates.`,
    "",
    `Peer:`,
    `  id: ${input.peer.id}`,
    `  kind: ${input.peer.kind}`,
    `  displayName: ${input.peer.displayName}`,
    "",
    `Existing profile field keys (preserve names when proposing updates that refine an existing field): ${existingFields.length > 0 ? existingFields.join(", ") : "(none yet)"}`,
    "",
    `Recent interaction log (oldest first):`,
    logBlock.length > 0 ? logBlock : "(no entries)",
    "",
    `Output a single JSON object: {"proposals": [{"field": "<stable_key>", "value": "<markdown>", "signal": "<short_label>", "note": "<optional>", "sourceSessionId": "<optional>"}]}.`,
    "",
    `Rules:`,
    `1. Only propose fields supported by evidence in the log. Do not invent.`,
    `2. Keys are short snake_case (e.g. "communication_style", "tool_patterns").`,
    `3. value is markdown. signal is a short label like "explicit_preference" or "topic_recurrence".`,
    `4. Omit fields you can't justify. Empty proposals array is valid.`,
    `5. Output JSON ONLY — no prose before or after.`,
  ].join("\n");
}

/**
 * Parse the LLM response. Tolerates a fenced code block wrapper.
 * Returns an empty array on any malformed payload — the contract is
 * that flaky LLM output silently produces zero proposals rather than
 * surfacing an error to the caller.
 *
 * Exported so unit tests can verify parser behavior without spinning
 * up the full reasoner.
 */
export function parsePeerProfileReasonerResponse(
  raw: string,
): PeerProfileReasonerProposal[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const trimmed = raw.trim();
  // Dropped the \s* groups around the lazy body (they overlapped it and
  // backtracked polynomially — CodeQL js/polynomial-redos). Input is already
  // trimmed and fenced[1] is trimmed below, so matches are identical.
  const fenced = /^```(?:json)?([\s\S]*?)```$/u.exec(trimmed);
  const payload = fenced ? fenced[1].trim() : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  // Gotcha #18: JSON.parse('null') succeeds. Reject non-objects.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const obj = parsed as { proposals?: unknown };
  if (!Array.isArray(obj.proposals)) return [];
  const out: PeerProfileReasonerProposal[] = [];
  // Gotcha — drop prototype-pollution keys at the field-name layer.
  const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  for (const item of obj.proposals) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.field !== "string" || r.field.trim() === "") continue;
    if (RESERVED_KEYS.has(r.field)) continue;
    if (typeof r.value !== "string" || r.value.trim() === "") continue;
    if (typeof r.signal !== "string" || r.signal.trim() === "") continue;
    const proposal: PeerProfileReasonerProposal = {
      field: r.field,
      value: r.value,
      signal: r.signal,
      ...(typeof r.note === "string" && r.note.length > 0 ? { note: r.note } : {}),
      ...(typeof r.sourceSessionId === "string" && r.sourceSessionId.length > 0
        ? { sourceSessionId: r.sourceSessionId }
        : {}),
    };
    out.push(proposal);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Reasoner core
// ──────────────────────────────────────────────────────────────────────

const SYSTEM_MESSAGE =
  'You are a peer-profile reasoner. Output ONLY a JSON object of the form {"proposals":[{"field":"...","value":"...","signal":"...","note":"...","sourceSessionId":"..."}]}. No prose, no fenced code block, no commentary.';

const RUN_MARKER_KIND = "peer_profile_reasoner_run";

/**
 * Find the most recent reasoner-run marker timestamp in the log.
 * Used to count "interactions since last run" so the threshold
 * gate doesn't keep firing on the same dormant log forever.
 */
function lastRunTimestamp(
  log: ReadonlyArray<PeerInteractionLogEntry>,
): string | undefined {
  let latest: string | undefined;
  for (const entry of log) {
    if (entry.kind !== RUN_MARKER_KIND) continue;
    if (latest === undefined || entry.timestamp > latest) {
      latest = entry.timestamp;
    }
  }
  return latest;
}

function noopLogger(): NonNullable<PeerProfileReasonerOptions["log"]> {
  return { debug: () => {}, info: () => {}, warn: () => {} };
}

/**
 * Run the reasoner across all (or the requested subset of) peers.
 *
 * Always returns a `PeerProfileReasonerResult` — never throws to the
 * caller — so the orchestrator can wire it as a best-effort
 * post-consolidation hook (Gotcha #13).
 */
export async function runPeerProfileReasoner(
  options: PeerProfileReasonerOptions,
): Promise<PeerProfileReasonerResult> {
  const log = {
    debug: options.log?.debug ?? noopLogger().debug!,
    info: options.log?.info ?? noopLogger().info!,
    warn: options.log?.warn ?? noopLogger().warn!,
  };
  const result: {
    peersConsidered: number;
    peersProcessed: number;
    fieldsApplied: number;
    perPeer: PeerProfileReasonerPeerResult[];
  } = {
    peersConsidered: 0,
    peersProcessed: 0,
    fieldsApplied: 0,
    perPeer: [],
  };
  // Disabled flag is the master gate. Defaults to false in callers'
  // config; we additionally require strict `=== true` here so a
  // stray "true" string doesn't silently flip the flag (Gotcha #36).
  if (options.enabled !== true) {
    log.debug("[peer-profile-reasoner] disabled — no-op");
    return result;
  }
  if (!options.llm) {
    log.warn("[peer-profile-reasoner] no LLM client supplied — skipping run");
    return result;
  }
  const minInteractions = Number.isFinite(options.minInteractions)
    ? Math.max(0, Math.floor(options.minInteractions))
    : 0;
  const maxFields = Number.isFinite(options.maxFieldsPerRun)
    ? Math.max(0, Math.floor(options.maxFieldsPerRun))
    : 0;
  if (maxFields === 0) {
    log.debug("[peer-profile-reasoner] maxFieldsPerRun=0 — no-op");
    return result;
  }
  const maxLogPerPeer = Number.isFinite(options.maxLogEntriesPerPeer ?? NaN)
    ? Math.max(1, Math.floor(options.maxLogEntriesPerPeer as number))
    : 50;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  let peers: Peer[];
  try {
    if (options.peerIds && options.peerIds.length > 0) {
      // Filter the explicit list against on-disk peers so we never
      // act on an id the operator typed but didn't register.
      const all = await listPeers(options.memoryDir);
      const wanted = new Set(
        options.peerIds.filter(
          (id) => typeof id === "string" && PEER_ID_PATTERN.test(id),
        ),
      );
      peers = all.filter((p) => wanted.has(p.id));
    } else {
      peers = await listPeers(options.memoryDir);
    }
  } catch (err) {
    log.warn(
      `[peer-profile-reasoner] listPeers failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
  result.peersConsidered = peers.length;
  let fieldsAppliedTotal = 0;

  for (const peer of peers) {
    if (options.signal?.aborted) {
      result.perPeer.push({
        peerId: peer.id,
        status: "skipped_aborted",
        fieldsApplied: 0,
        droppedDueToCap: 0,
        fields: [],
      });
      continue;
    }
    try {
      // Codex P2 review on PR #736: the min-interactions threshold
      // must reflect the FULL log of new activity, not the
      // `maxLogPerPeer`-truncated slice. Otherwise a peer with a
      // genuinely active conversation history can be permanently
      // marked `skipped_below_min_interactions` whenever
      // `peerProfileReasonerMinInteractions > maxLogEntriesPerPeer`,
      // because the slice will never include enough new entries.
      // Read the full log first to compute the gate, then truncate
      // for prompt construction below.
      const fullLog = await readPeerInteractionLog(
        options.memoryDir,
        peer.id,
      );
      if (fullLog.length === 0) {
        result.perPeer.push({
          peerId: peer.id,
          status: "skipped_no_log",
          fieldsApplied: 0,
          droppedDueToCap: 0,
          fields: [],
        });
        continue;
      }
      // Count interactions since the last reasoner-run marker, so
      // dormant peers don't trigger another LLM call until enough
      // new signal accumulates. Run markers themselves don't count.
      const lastRun = lastRunTimestamp(fullLog);
      const sinceLastRunFull = lastRun
        ? fullLog.filter(
            (e) => e.timestamp > lastRun && e.kind !== RUN_MARKER_KIND,
          )
        : fullLog.filter((e) => e.kind !== RUN_MARKER_KIND);
      if (sinceLastRunFull.length < minInteractions) {
        result.perPeer.push({
          peerId: peer.id,
          status: "skipped_below_min_interactions",
          fieldsApplied: 0,
          droppedDueToCap: 0,
          fields: [],
        });
        continue;
      }
      // Truncate ONLY for prompt construction so the LLM context
      // stays bounded. Use the most recent `maxLogPerPeer` entries
      // from the full since-last-run set so the prompt prefers fresh
      // signal over older entries.
      const sinceLastRun =
        sinceLastRunFull.length > maxLogPerPeer
          ? sinceLastRunFull.slice(sinceLastRunFull.length - maxLogPerPeer)
          : sinceLastRunFull;

      const existingProfile = await readPeerProfile(options.memoryDir, peer.id);

      const remainingBudget = maxFields - fieldsAppliedTotal;
      if (remainingBudget <= 0) {
        result.perPeer.push({
          peerId: peer.id,
          status: "skipped_cap_reached",
          fieldsApplied: 0,
          droppedDueToCap: 0,
          fields: [],
        });
        continue;
      }

      const prompt = buildPeerProfileReasonerPrompt({
        peer,
        existingProfile,
        log: sinceLastRun,
        maxFields: remainingBudget,
      });
      const messages = [
        { role: "system" as const, content: SYSTEM_MESSAGE },
        { role: "user" as const, content: prompt },
      ];
      let response: { content: string } | null;
      try {
        response = await options.llm.chatCompletion(messages, {
          temperature: 0.2,
          maxTokens: 1500,
        });
      } catch (err) {
        log.warn(
          `[peer-profile-reasoner] LLM call failed for "${peer.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
        result.perPeer.push({
          peerId: peer.id,
          status: "skipped_llm_unavailable",
          fieldsApplied: 0,
          droppedDueToCap: 0,
          fields: [],
        });
        continue;
      }
      if (!response || typeof response.content !== "string") {
        result.perPeer.push({
          peerId: peer.id,
          status: "skipped_llm_unavailable",
          fieldsApplied: 0,
          droppedDueToCap: 0,
          fields: [],
        });
        continue;
      }

      const proposals = parsePeerProfileReasonerResponse(response.content);
      if (proposals.length === 0) {
        result.perPeer.push({
          peerId: peer.id,
          status: "processed",
          fieldsApplied: 0,
          droppedDueToCap: 0,
          fields: [],
        });
        continue;
      }

      // Build the merged profile. We never replace existing
      // provenance entries — provenance is append-only so the
      // operator retains a full audit trail.
      const sessionIdsInWindow = new Set(
        sinceLastRun
          .map((e) => e.sessionId)
          .filter((s): s is string => typeof s === "string" && s.length > 0),
      );
      const baseFields: Record<string, string> = existingProfile
        ? { ...existingProfile.fields }
        : {};
      const baseProvenance: Record<string, PeerProfileFieldProvenance[]> = {};
      if (existingProfile) {
        for (const [k, list] of Object.entries(existingProfile.provenance)) {
          baseProvenance[k] = [...list];
        }
      }

      // Codex P1 review on PR #736: the global `fieldsAppliedTotal`
      // counter must NOT be incremented until the profile write
      // actually succeeds. Otherwise a transient I/O error here
      // poisons the per-run cap for every subsequent peer — they get
      // marked `skipped_cap_reached` for fields that were never
      // persisted. Track the candidate count locally and only
      // commit it to the run-wide budget after `writePeerProfile`
      // returns successfully (Gotcha #25 — don't destroy old state
      // before confirming new state succeeds).
      const appliedFieldsForPeer: string[] = [];
      let droppedDueToCap = 0;
      let invalidProposalSeen = false;
      for (const proposal of proposals) {
        // Use a candidate-budget projection so we never propose more
        // than the run-wide cap allows even before we know the write
        // will succeed.
        const candidateBudget =
          maxFields - fieldsAppliedTotal - appliedFieldsForPeer.length;
        if (candidateBudget <= 0) {
          droppedDueToCap += 1;
          continue;
        }
        // Final defensive guard against prototype keys (parser
        // already drops them, but be redundant for safety).
        if (
          proposal.field === "__proto__" ||
          proposal.field === "constructor" ||
          proposal.field === "prototype"
        ) {
          invalidProposalSeen = true;
          continue;
        }
        // Sanity-check field key matches a conservative pattern so a
        // hostile LLM can't sneak path-traversal-shaped keys through
        // for downstream consumers.
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(proposal.field)) {
          invalidProposalSeen = true;
          continue;
        }
        baseFields[proposal.field] = proposal.value;
        const sourceSessionId =
          proposal.sourceSessionId &&
          sessionIdsInWindow.has(proposal.sourceSessionId)
            ? proposal.sourceSessionId
            : undefined;
        const provEntry: PeerProfileFieldProvenance = {
          observedAt: nowIso,
          signal: proposal.signal,
          ...(sourceSessionId ? { sourceSessionId } : {}),
          ...(proposal.note && proposal.note.length > 0
            ? { note: proposal.note }
            : {}),
        };
        const list = baseProvenance[proposal.field] ?? [];
        list.push(provEntry);
        baseProvenance[proposal.field] = list;
        appliedFieldsForPeer.push(proposal.field);
        // NOTE: fieldsAppliedTotal is NOT incremented here — see the
        // P1 comment above. We commit the budget after the write
        // succeeds.
      }

      if (appliedFieldsForPeer.length === 0) {
        result.perPeer.push({
          peerId: peer.id,
          status: invalidProposalSeen
            ? "skipped_invalid_proposal"
            : droppedDueToCap > 0
              ? "skipped_cap_reached"
              : "processed",
          fieldsApplied: 0,
          droppedDueToCap,
          fields: [],
        });
        continue;
      }

      const merged: PeerProfile = {
        peerId: peer.id,
        updatedAt: nowIso,
        fields: baseFields,
        provenance: baseProvenance,
      };
      await writePeerProfile(options.memoryDir, merged);
      // Write succeeded — NOW commit the budget. A throw above
      // bubbles to the outer catch, where the peer is recorded as
      // `error` and the global cap remains intact for subsequent
      // peers (Codex P1 fix on PR #736).
      fieldsAppliedTotal += appliedFieldsForPeer.length;

      // Append a run marker so the next reasoner pass can compute
      // "interactions since last run" without a dedicated state
      // file. The marker is best-effort — a write failure here
      // logs but does not roll back the profile (the operator
      // would prefer a slightly noisy threshold over a lost
      // profile update).
      const wantsMarker = options.appendRunMarkerToLog ?? true;
      if (wantsMarker) {
        try {
          await appendInteractionLog(options.memoryDir, peer.id, {
            timestamp: nowIso,
            kind: RUN_MARKER_KIND,
            summary: `applied ${appliedFieldsForPeer.length} field(s) via ${options.model ?? "unknown-model"}`,
          });
        } catch (err) {
          log.warn(
            `[peer-profile-reasoner] run-marker append failed for "${peer.id}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      result.perPeer.push({
        peerId: peer.id,
        status: "processed",
        fieldsApplied: appliedFieldsForPeer.length,
        droppedDueToCap,
        fields: appliedFieldsForPeer,
      });
      result.peersProcessed += 1;
      result.fieldsApplied = fieldsAppliedTotal;
    } catch (err) {
      log.warn(
        `[peer-profile-reasoner] error processing peer "${peer.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
      result.perPeer.push({
        peerId: peer.id,
        status: "error",
        fieldsApplied: 0,
        droppedDueToCap: 0,
        fields: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
