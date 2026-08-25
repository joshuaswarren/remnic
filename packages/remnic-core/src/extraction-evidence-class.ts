/**
 * Deterministic evidence provenance classes (issue #2973).
 *
 * Every extracted candidate is backed by spans located in buffered turns.
 * The CLASS of a span — whose words it records — decides what the span can
 * license (learned from distill-kura's measured self-reinforcing assertion
 * loop: an agent asserts, the extractor records, the next agent reads it back
 * as ground truth and repeats it with more confidence):
 *
 *   - `user`:   the human's own words. Licenses user attributions.
 *   - `tool`:   machine output. The ONLY licit source for numbers.
 *   - `action`: a tool was invoked. Weaker than reading its output.
 *   - `agent`:  agent prose. Licenses a first-person judgement, never a
 *               bare fact.
 *
 * Derivation is pure and total: turn role plus tool-part flags in, one class
 * out, no clock, no randomness, no I/O. The same input always yields the
 * same class. Span matching reuses `locateQuoteOffsets` /
 * `stripLeadingRolePrefix` from `provenance.ts` so class location and
 * provenance building can never disagree (issue #1575 pitfall: one matcher,
 * not two).
 *
 * The post-extraction rules (`applyEvidenceClassRules`) are deterministic
 * string/flag checks — no LLM — designed to run before the judge. Each
 * returns a stable rule id for shadow-mode telemetry. Not yet wired into the
 * extraction pipeline; see the issue's rollout plan.
 */

import { locateQuoteOffsets, stripLeadingRolePrefix } from "./provenance.js";
import type { MemorySubject } from "./types.js";
import { collapseWhitespace } from "./whitespace.js";

export type EvidenceClass = "user" | "tool" | "action" | "agent";

/** Canonical class order: strongest license first. Fixed; never reorder. */
export const EVIDENCE_CLASSES: readonly EvidenceClass[] = ["user", "tool", "action", "agent"];

/**
 * A buffered turn reduced to what class derivation needs. Callers map
 * `BufferTurn`s via {@link evidenceTurnInput}; `role` and the tool flags are
 * the only fields that influence the class.
 */
export interface EvidenceClassTurnInput {
  content: string;
  role: "user" | "assistant";
  /** Turn carries machine output (a tool_result part). */
  toolResult?: boolean;
  /** Turn records a tool invocation (a tool_call part). */
  toolCall?: boolean;
}

/**
 * Derive a turn's evidence class. Total and deterministic:
 *   - `role: "user"` → `"user"` (the human's words, regardless of stray
 *     part flags a connector may attach).
 *   - `role: "assistant"` with `toolResult` → `"tool"`; machine output
 *     outranks the invocation that produced it.
 *   - else with `toolCall` → `"action"`.
 *   - else → `"agent"` (agent prose — the weakest license).
 */
export function deriveTurnEvidenceClass(turnInput: EvidenceClassTurnInput): EvidenceClass {
  if (turnInput.role === "user") return "user";
  if (turnInput.toolResult === true) return "tool";
  if (turnInput.toolCall === true) return "action";
  return "agent";
}

/**
 * Map a buffered turn (structural subset of `BufferTurn`) to
 * {@link EvidenceClassTurnInput}. Tool flags derive mechanically from part
 * kinds — no content inspection, no heuristics.
 */
export function evidenceTurnInput(bufferTurn: {
  role: "user" | "assistant";
  content: string;
  parts?: ReadonlyArray<{ kind: string }>;
}): EvidenceClassTurnInput {
  let toolResult = false;
  let toolCall = false;
  if (bufferTurn.parts) {
    for (const part of bufferTurn.parts) {
      if (part.kind === "tool_result") toolResult = true;
      else if (part.kind === "tool_call") toolCall = true;
    }
  }
  return {
    role: bufferTurn.role,
    content: bufferTurn.content,
    ...(toolResult ? { toolResult: true } : {}),
    ...(toolCall ? { toolCall: true } : {}),
  };
}

/**
 * Resolve which quote `buildFactProvenance` would search for: the raw quote
 * when it matches at least one turn, else the leading prompt role label
 * stripped (mirrors the raw-preferred contract in `provenance.ts`).
 */
function resolveSearchableQuote(
  quote: string | null | undefined,
  turns: ReadonlyArray<EvidenceClassTurnInput>,
): string {
  const rawQuote = typeof quote === "string" ? quote.trim() : "";
  if (rawQuote.length === 0) return "";
  const stripped = stripLeadingRolePrefix(rawQuote);
  if (rawQuote === stripped) return rawQuote;
  const rawMatches = turns.some(
    (t) => typeof t?.content === "string" && t.content.length > 0 && locateQuoteOffsets(rawQuote, t.content).matched,
  );
  return rawMatches ? rawQuote : stripped;
}

/**
 * Classify the evidence backing a fact: the classes of every turn in which
 * its quote was located, in canonical `EVIDENCE_CLASSES` order regardless of
 * turn order. Deterministic — the same `(quote, turns)` pair always yields
 * the same array. An absent or unlocatable quote yields `[]` (no evidence
 * class; the extractor's own assertion is all that backs the fact).
 */
export function classifyEvidenceClasses(input: {
  quote: string | null | undefined;
  turns: ReadonlyArray<EvidenceClassTurnInput>;
}): EvidenceClass[] {
  const quote = resolveSearchableQuote(input.quote, input.turns);
  if (quote.length === 0) return [];
  const present = new Set<EvidenceClass>();
  for (const turn of input.turns) {
    if (!turn || typeof turn.content !== "string" || turn.content.length === 0) continue;
    if (locateQuoteOffsets(quote, turn.content).matched) {
      present.add(deriveTurnEvidenceClass(turn));
    }
  }
  return EVIDENCE_CLASSES.filter((cls) => present.has(cls));
}

/**
 * Collapse a fact's evidence classes to the single strongest license present.
 * No located span (`[]`) collapses to `"agent"`: the fact is agent-asserted.
 */
export function deriveFactEvidenceClass(classes: readonly EvidenceClass[]): EvidenceClass {
  for (const cls of EVIDENCE_CLASSES) {
    if (classes.includes(cls)) return cls;
  }
  return "agent";
}

// ---------------------------------------------------------------------------
// Deterministic post-extraction rules (no LLM; run before the judge)
// ---------------------------------------------------------------------------

export type EvidenceRuleId =
  | "numeric_without_tool_evidence"
  | "user_attribution_without_user_span"
  | "echo_of_existing_content";

export interface EvidenceRuleFinding {
  rule: EvidenceRuleId;
  /** `demote` routes the fact to `pending_review`; `refuse` drops it. */
  action: "demote" | "refuse";
  reason: string;
}

/** Categories that attribute a choice or commitment to the modeled subject. */
const DECISION_LIKE_CATEGORIES: Record<string, true> = {
  decision: true,
  preference: true,
  commitment: true,
};

/**
 * Normalize a quote for echo comparison. Casefold plus whitespace collapse —
 * the same normalization `locateQuoteOffsets` matches with, via the single
 * shared normalizer in `whitespace.ts`.
 */
export function echoQuoteKey(quote: string): string {
  return collapseWhitespace(quote.toLowerCase());
}

/**
 * Apply the three deterministic evidence rules to one extracted fact.
 * Pure; findings come back in canonical rule-id order. A fact triggers:
 *
 *   1. `numeric_without_tool_evidence` — content carries a digit but no
 *      `tool`/`action` span backs it. The human and the agent are both
 *      illicit sources for numbers; demote to review rather than refuse
 *      (the number may be real — it is just unproven).
 *   2. `user_attribution_without_user_span` — a decision-like fact about the
 *      user (absent `subject` reads as `"user"`, mirroring the promotion
 *      guard's fail-closed default) with no `user` span. This is the
 *      assertion-loop gate: an agent-asserted "the user decided X" is
 *      refused, never promoted to active.
 *   3. `echo_of_existing_content` — every quote backing the fact already
 *      exists in the store index, so the "evidence" is the store reading
 *      itself back through a tool result. Refused: not new material.
 */
export function applyEvidenceClassRules(input: {
  content: string;
  category?: string;
  subject?: MemorySubject;
  evidenceClasses?: readonly EvidenceClass[];
  /** Normalized keys (`echoQuoteKey`) of the fact's surviving quotes. */
  quoteKeys?: readonly string[];
  /** Normalized keys of quotes already present in the content-hash index. */
  existingQuoteKeys?: ReadonlySet<string>;
}): EvidenceRuleFinding[] {
  const classes = input.evidenceClasses ?? [];
  const findings: EvidenceRuleFinding[] = [];

  if (/\d/.test(input.content) && !classes.some((c) => c === "tool" || c === "action")) {
    findings.push({
      rule: "numeric_without_tool_evidence",
      action: "demote",
      reason: "content carries a number but no tool or action evidence span backs it",
    });
  }

  const decisionLike = input.category !== undefined && DECISION_LIKE_CATEGORIES[input.category] === true;
  const subject = input.subject ?? "user";
  if (decisionLike && subject === "user" && !classes.includes("user")) {
    findings.push({
      rule: "user_attribution_without_user_span",
      action: "refuse",
      reason: "decision-like fact about the user with no user-role evidence span",
    });
  }

  const quoteKeys = input.quoteKeys ?? [];
  if (
    quoteKeys.length > 0
    && input.existingQuoteKeys !== undefined
    && quoteKeys.every((key) => input.existingQuoteKeys!.has(key))
  ) {
    findings.push({
      rule: "echo_of_existing_content",
      action: "refuse",
      reason: "every evidence quote already exists in the store (echo, not new material)",
    });
  }

  return findings;
}
