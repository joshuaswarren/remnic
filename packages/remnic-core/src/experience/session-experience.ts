/**
 * Session-end agent-experience extraction (issue #2979).
 *
 * At `session_end` the completed session's buffered turns are distilled —
 * deterministically, no LLM — into at most ONE Situation/Approach/Reflect
 * "experience episode" memory (agent-subject, category `procedure`,
 * `pending_review`), mirroring OpenViking's experience-memory schema at the
 * granularity Remnic's trust model allows: a machine-derived write that
 * stays behind the existing sealed-envelope write path and never activates
 * itself.
 *
 * Determinism: the episode is a pure function of the turn list — same
 * transcript, same episode. Refusal/failure is signal, not a skip: a
 * session whose terminal assistant turn records a failure gets a failure
 * reflection.
 *
 * v1 heuristics (same tier as procedure-miner's `pseudoStepsFromCluster`):
 * situation = first substantive user turn (task shape); approach = first
 * sentences of the assistant turns; reflection = terminal outcome evidence.
 */

import { createHash } from "node:crypto";

import { log } from "../logger.js";
import type { BufferTurn, MemoryFile, MemoryStatus, PluginConfig } from "../types.js";
import { composeSalvagedEnvelope } from "../salvage-envelope.js";
import type { SealedMemoryEnvelope } from "../write-envelope.js";

export type SessionExperienceOutcomeKind = "success" | "failure" | "inconclusive";

/** The OpenViking Situation/Approach/Reflect classes, Remnic spelling. */
export interface ExperienceEpisode {
  /** Task shape: what the session was asked to do. */
  situation: string;
  /** What the agent tried, in order. */
  approach: string;
  /** Outcome and what to do differently. */
  reflection: string;
  outcomeKind: SessionExperienceOutcomeKind;
}

export type SessionExperienceSkippedReason =
  | "session_experience_disabled"
  | "aborted"
  | "deadline_elapsed"
  | "duplicate_session"
  | "insufficient_signal";

export type SessionExperienceRunResult =
  | { written: true; episode: ExperienceEpisode; memoryId: string }
  | { written: false; skippedReason: SessionExperienceSkippedReason };

/** The subset of StorageManager the experience write needs (test-friendly). */
export interface SessionExperienceStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  writeSealedMemory(
    envelope: SealedMemoryEnvelope,
    extras?: { status?: MemoryStatus },
  ): Promise<{ id?: string }>;
}

export interface SessionExperienceRunOptions {
  turns: readonly BufferTurn[];
  sessionKey: string;
  config: PluginConfig;
  storage: SessionExperienceStorage;
  abortSignal?: AbortSignal;
  /** Shared flush deadline (epoch ms); skipped when already elapsed. */
  deadlineMs?: number;
}

// ---------------------------------------------------------------------------
// Deterministic derivation
// ---------------------------------------------------------------------------

const SITUATION_MAX_CHARS = 280;
const SNIPPET_MAX_CHARS = 160;
const APPROACH_MAX_SNIPPETS = 3;
const MIN_SITUATION_CHARS = 16;

/** Terminal-outcome markers, scanned over ASSISTANT turns only (last first). */
const FAILURE_MARKER =
  /\b(?:failed|failing|failure|cannot|can't|unable to|blocked|refused|refusal)\b/i;
const SUCCESS_MARKER =
  /\b(?:succeeded|verified|tests? pass(?:ed|ing)?|fixed|resolved|completed successfully|shipped)\b/i;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function capAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trim()}…`;
}

function firstSentence(text: string): string {
  const match = collapse(text).match(/^[^.!?]*[.!?]/);
  return collapse(match ? match[0] : text);
}

function sentenceContaining(text: string, marker: RegExp): string {
  const flat = collapse(text);
  for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
    if (marker.test(sentence)) return sentence;
  }
  return flat;
}

function classifyOutcome(assistantTurns: string[]): { outcomeKind: SessionExperienceOutcomeKind; evidence: string } {
  for (let i = assistantTurns.length - 1; i >= 0; i -= 1) {
    const turn = assistantTurns[i];
    if (FAILURE_MARKER.test(turn)) {
      return { outcomeKind: "failure", evidence: sentenceContaining(turn, FAILURE_MARKER) };
    }
    if (SUCCESS_MARKER.test(turn)) {
      return { outcomeKind: "success", evidence: sentenceContaining(turn, SUCCESS_MARKER) };
    }
  }
  return { outcomeKind: "inconclusive", evidence: "" };
}

function reflectionFor(outcomeKind: SessionExperienceOutcomeKind, evidence: string): string {
  if (outcomeKind === "failure") {
    return `The session failed: "${capAtWordBoundary(evidence, SNIPPET_MAX_CHARS)}". Change that step before retrying the same approach.`;
  }
  if (outcomeKind === "success") {
    return `The session succeeded: "${capAtWordBoundary(evidence, SNIPPET_MAX_CHARS)}". The approach above worked for this situation.`;
  }
  return "No terminal outcome signal appears in the transcript; treat the approach above as unverified.";
}

/**
 * Derive the single experience episode a completed session yields, or `null`
 * when the transcript carries no learnable signal (no task, or no agent work).
 */
export function extractExperienceEpisode(turns: readonly BufferTurn[]): ExperienceEpisode | null {
  const userTurns = turns.filter((turn) => turn.role === "user").map((turn) => collapse(turn.content)).filter(Boolean);
  const situationSource = userTurns.find((content) => content.length >= MIN_SITUATION_CHARS);
  if (situationSource === undefined) return null;

  const assistantTurns = turns
    .filter((turn) => turn.role === "assistant")
    .map((turn) => collapse(turn.content))
    .filter(Boolean);
  if (assistantTurns.length === 0) return null;

  const snippets: string[] = [];
  for (const turn of assistantTurns) {
    const sentence = firstSentence(turn);
    if (sentence.length === 0 || snippets.includes(sentence)) continue;
    snippets.push(capAtWordBoundary(sentence, SNIPPET_MAX_CHARS));
    if (snippets.length >= APPROACH_MAX_SNIPPETS) break;
  }
  if (snippets.length === 0) return null;

  const { outcomeKind, evidence } = classifyOutcome(assistantTurns);
  return {
    situation: capAtWordBoundary(situationSource, SITUATION_MAX_CHARS),
    approach: snippets.join("; "),
    reflection: reflectionFor(outcomeKind, evidence),
    outcomeKind,
  };
}

// ---------------------------------------------------------------------------
// Gated write
// ---------------------------------------------------------------------------

const EXPERIENCE_SOURCE = "session-experience";

function sessionKeyHash(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex");
}

async function hasExistingExperience(
  storage: SessionExperienceStorage,
  hash: string,
): Promise<boolean> {
  const memories = await storage.readAllMemories();
  return memories.some((m) => m.frontmatter.structuredAttributes?.experience_session_hash === hash);
}

/**
 * Run session-end experience extraction for one session. With the gate off
 * this touches NOTHING — no reads, no envelope, no write. On write the
 * episode lands as one `pending_review` agent-subject `procedure` memory
 * (trust-mode review; promotion is the operator's call), deduped per
 * session key so a replayed session_end cannot double-write.
 */
export async function runSessionExperienceExtraction(
  options: SessionExperienceRunOptions,
): Promise<SessionExperienceRunResult> {
  if (options.config.sessionExperience?.enabled !== true) {
    return { written: false, skippedReason: "session_experience_disabled" };
  }
  if (options.abortSignal?.aborted === true) {
    return { written: false, skippedReason: "aborted" };
  }
  if (typeof options.deadlineMs === "number" && Date.now() >= options.deadlineMs) {
    return { written: false, skippedReason: "deadline_elapsed" };
  }

  const hash = sessionKeyHash(options.sessionKey);
  if (await hasExistingExperience(options.storage, hash)) {
    return { written: false, skippedReason: "duplicate_session" };
  }

  const episode = extractExperienceEpisode(options.turns);
  if (episode === null) {
    return { written: false, skippedReason: "insufficient_signal" };
  }

  // Machine-derived from buffered turns — salvage-mode envelope, warn-logged
  // drops (issue #1989 PR4 convention for machine-generated writes).
  const envelope = composeSalvagedEnvelope(
    EXPERIENCE_SOURCE,
    {
      content: `Situation: ${episode.situation}\nApproach: ${episode.approach}\nReflection: ${episode.reflection}`,
      category: "procedure",
      subject: "agent",
      confidence: 0.6,
      tags: ["session-experience", `experience-${episode.outcomeKind}`],
      structuredAttributes: {
        experience_situation: episode.situation,
        experience_approach: episode.approach,
        experience_reflection: episode.reflection,
        experience_outcome: episode.outcomeKind,
        experience_session_hash: hash,
      },
    },
    { source: EXPERIENCE_SOURCE },
  );
  const written = await options.storage.writeSealedMemory(envelope, { status: "pending_review" });
  log.debug(
    `${EXPERIENCE_SOURCE}: wrote episode for session hash ${hash.slice(0, 12)}… (outcome ${episode.outcomeKind})`,
  );
  return { written: true, episode, memoryId: typeof written.id === "string" ? written.id : "" };
}
