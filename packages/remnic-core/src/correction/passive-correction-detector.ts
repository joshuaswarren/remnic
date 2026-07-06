/**
 * correction/passive-correction-detector.ts — morphology-aware heuristic detector
 * for corrections expressed passively in conversation turns (issue #1581).
 *
 * Users correct their agents constantly in conversation: "no, we renamed that
 * service", "I don't use Vim anymore", "the deadline moved to Friday". This
 * module detects those corrections from turn text — NO extra LLM call — so the
 * passive-capture module can route them to the Correction Contract (#1580).
 *
 * Design:
 *   - Pure function: `detectPassiveCorrections(turns)` → `PassiveCorrection[]`.
 *   - Only USER turns are scanned (assistants don't correct their own memory).
 *   - Morphology-aware: matches conjugations/variants per AGENTS.md intent
 *     guardrail ("heuristics must be morphology-aware and precedence-tested").
 *   - Anti-fixture guards reject: hypotheticals, third-party corrections,
 *     quoted-speech corrections, and self-resolving corrections.
 *
 * The detector is deliberately CONSERVATIVE — it prefers false negatives
 * (missing a correction) over false positives (flooding the review queue).
 * The nightly contradiction scan and the interactive correction chat (#1583)
 * catch what passive detection misses.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PassiveCorrectionPolarity = "update" | "retract" | "stop_storing";

export interface PassiveCorrection {
  /** What the user says is wrong ("Redis", "the deadline", "my editor preference"). */
  targetHint: string;
  /** The new truth, or "" for pure retractions. */
  correctedAssertion: string;
  polarity: PassiveCorrectionPolarity;
  /** `[m:xxxx]` handle references found verbatim in the turn (#1582). */
  handles: string[];
  /** Heuristic confidence in [0, 1] — influences auto-apply gating. */
  confidence: number;
  /** The verbatim source text that triggered the detection. */
  sourceExcerpt: string;
  /** Index of the turn in the input array that produced this correction. */
  turnIndex: number;
}

export interface DetectorTurn {
  role: "user" | "assistant" | "other";
  content: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface CorrectionPattern {
  polarity: PassiveCorrectionPolarity;
  /** Regex MUST be case-insensitive and use word boundaries where appropriate. */
  regex: RegExp;
  /** Confidence assigned when this pattern is the sole signal. */
  confidence: number;
}

/**
 * Strong correction signals — these phrases reliably indicate the user is
 * correcting a stored memory about their own world. Each is morphology-aware
 * (covers present/progressive/past tenses and common variants).
 */
const PATTERNS: readonly CorrectionPattern[] = [
  // ── update: new fact replaces / corrects an old one ──────────────────────
  {
    polarity: "update",
    // "actually, it's X not Y" / "actually we use X now"
    regex: /\bactually[,\s]+(?:it'?s|we|the|i|our|my|\[m:)/i,
    confidence: 0.85,
  },
  {
    polarity: "update",
    // "we switched/switching/switched to X"
    regex: /\bwe\b\s*(?:(?:'re|'ve|are|have)\s+)?(?:switch(?:ed|ing)?|migrat(?:ed|ing)?|mov(?:ed|ing)?|chang(?:ed|ing)?)\s+(?:to|over to|from)\b/i,
    confidence: 0.9,
  },
  {
    polarity: "update",
    // "we renamed X to Y" / "i renamed"
    regex: /\b(?:we|i)\s+renam(?:ed|ing)\b/i,
    confidence: 0.9,
  },
  {
    polarity: "update",
    // "it's now X" / "the deadline moved to X" / "the date changed to X"
    regex: /\b(?:it'?s now|the\s+(?:deadline|date|meeting|standup|review)\s+(?:moved|chang(?:ed|ing))?\s*to)\b/i,
    confidence: 0.85,
  },
  {
    polarity: "update",
    // "no, " at the start of a turn or clause — strong correction signal
    regex: /(?:^|\.\s+|\n)\s*no[,\s]+(?:we|i|it|the|our|my|that)\b/i,
    confidence: 0.8,
  },
  {
    polarity: "update",
    // "no longer" / "not anymore" + an activity
    regex: /\b(?:no longer|not anymore)\b/i,
    confidence: 0.8,
  },
  {
    polarity: "update",
    // Standalone "outdated" — catches "are both outdated", "is outdated", etc.
    regex: /\boutdated\b/i,
    confidence: 0.75,
  },
  {
    polarity: "update",
    // "that's outdated" / "that's old"
    regex: /\bthat'?s\s+(?:outdated|old|no longer (?:true|correct|accurate))\b/i,
    confidence: 0.85,
  },
  // ── retract: user says a fact is simply wrong ────────────────────────────
  {
    polarity: "retract",
    regex: /\bthat'?s\s+(?:wrong|not right|incorrect|not true|false)\b/i,
    confidence: 0.85,
  },
  {
    polarity: "retract",
    // "we don't use X anymore" / "I don't use X anymore"
    regex: /\b(?:we|i)\s+don'?t\s+use\s+\S+\s+anymore\b/i,
    confidence: 0.9,
  },
  {
    polarity: "retract",
    regex: /\bforget about\b/i,
    confidence: 0.8,
  },
  // ── stop_storing: user wants the agent to stop a behavior ────────────────
  {
    polarity: "stop_storing",
    regex: /\bstop\s+(?:suggesting|bringing\s+up|recommending|reminding\s+me\s+(?:about)?)\b/i,
    confidence: 0.9,
  },
  {
    polarity: "stop_storing",
    regex: /\b(?:don'?t|never)\s+(?:mention|suggest|recommend|store|bring\s+up)\b/i,
    confidence: 0.85,
  },
];

// ---------------------------------------------------------------------------
// Anti-fixture guards
// ---------------------------------------------------------------------------

/**
 * Hypothetical markers — if present near the correction signal, the turn is
 * discussing a hypothetical scenario, not correcting a stored fact.
 */
const HYPOTHETICAL_REGEX =
  /\b(?:if\s+(?:we|you|i|they)\s+(?:ever|were|could|might|should|decide)|what\s+if|suppose|hypothetically|in\s+(?:theory|principle)|let'?s\s+say|imagine\s+if)\b/i;

/**
 * Third-party correction markers — the user is correcting someone else, not
 * their agent's memory of their own world.
 */
const THIRD_PARTY_REGEX =
  /\b(?:tell\s+\w+\s+(?:he|she|they|you)'?re?\s+wrong|he'?s\s+wrong\s+about|she'?s\s+wrong\s+about|they'?re\s+wrong\s+about|correct\s+\w+\s+on)\b/i;

/**
 * Tool-output correction — the user is saying a tool's output is wrong, not
 * that their stored memory is wrong.
 */
const TOOL_OUTPUT_REGEX =
  /\b(?:the\s+(?:output|result|response|error|log)|your\s+(?:output|result|response|code|answer))\s+(?:is\s+)?(?:wrong|incorrect|bad|off)\b/i;

/**
 * Self-resolving correction — the user corrects themselves within the same
 * turn ("actually wait, no, the original was right"). These turn back and
 * cancel out.
 */
const SELF_RESOLVE_REGEX =
  /(?:actually|wait|no)[,\s]+(?:never\s*mind|forget\s*(?:that|it)|the\s+(?:original|first)\s+(?:was|is)\s+(?:right|correct)|scratch\s+that|disregard)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract `[m:xxxx]` handle references from text (#1582). */
export function extractHandles(text: string): string[] {
  const matches = text.match(/\[m:[0-9a-fA-F]{4,}\]/g);
  return matches ?? [];
}

/**
 * Extract a target hint from the matched correction text. Returns a short
 * phrase (≤80 chars) the planner can use to locate the affected memory.
 */
function extractTargetHint(text: string, match: RegExpMatchArray): string {
  const matchStart = match.index ?? 0;
  // Take a window around the match: 20 chars before to 60 chars after.
  const start = Math.max(0, matchStart - 20);
  const end = Math.min(text.length, matchStart + match[0].length + 60);
  const window = text.slice(start, end).replace(/\s+/g, " ").trim();
  return window.length > 80 ? window.slice(0, 77) + "..." : window;
}

/**
 * Extract the corrected assertion — the new truth the user is expressing.
 * For "update" polarity, this is the full turn text (the planner searches for
 * the old fact and drafts a replacement). For "retract", it's "" (no
 * replacement). For "stop_storing", it's the behavior to suppress.
 */
function extractCorrectedAssertion(
  text: string,
  polarity: PassiveCorrectionPolarity,
): string {
  if (polarity === "retract") return "";
  // For update/stop_storing, the full turn IS the assertion (truncated).
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 200 ? trimmed.slice(0, 197) + "..." : trimmed;
}

/**
 * Check whether a regex match at the given index is within quotation marks.
 * Used to reject corrections that are actually quoted speech (someone else's
 * words the user is relaying, not the user correcting their own memory).
 */
function isWithinQuotes(text: string, matchIndex: number): boolean {
  // Only DOUBLE quotes delimit quoted speech. Single quotes (ASCII apostrophe
  // and smart single quotes) are deliberately NOT treated as delimiters: in
  // English they are overwhelmingly contractions/possessives
  // ("I don't think we switched"), which would falsely mark a
  // correction as quoted speech and suppress a valid detection (false
  // negative). A contraction before the correction phrase must not flip the
  // detector into quoted mode.
  let inQuote = false;
  for (let i = 0; i < matchIndex && i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === '\u201c' || c === '\u201d') {
      inQuote = !inQuote;
    }
  }
  return inQuote;
}

/**
 * Check whether any anti-fixture guard fires on the turn text.
 * Returns the guard name that blocked detection, or null if clean.
 */
function detectAntiFixture(text: string): string | null {
  if (SELF_RESOLVE_REGEX.test(text)) return "self_resolving";
  if (HYPOTHETICAL_REGEX.test(text)) return "hypothetical";
  if (THIRD_PARTY_REGEX.test(text)) return "third_party";
  if (TOOL_OUTPUT_REGEX.test(text)) return "tool_output";
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Detect passive corrections in a sequence of conversation turns.
 *
 * Only USER turns are scanned — assistant turns don't express corrections to
 * the agent's stored memory. Each user turn is checked against the correction
 * patterns; anti-fixture guards reject turns that look like hypotheticals,
 * third-party corrections, tool-output complaints, or self-resolving double-
 * corrections.
 *
 * A single turn may produce multiple corrections if different patterns match
 * different parts of the text. Dedup by (turnIndex, polarity, targetHint) so
 * overlapping patterns on the same phrase produce one correction.
 */
export function detectPassiveCorrections(
  turns: readonly DetectorTurn[],
): PassiveCorrection[] {
  const results: PassiveCorrection[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== "user") continue;
    const content = turn.content?.trim();
    if (!content) continue;

    // Anti-fixture guards take precedence — one guard kills ALL corrections
    // from this turn (a hypothetical turn can't contain a real correction).
    const guard = detectAntiFixture(content);
    if (guard) continue;

    const handles = extractHandles(content);

    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(content);
      if (!match) continue;

      // Reject corrections that appear within quotation marks — the user is
      // relaying someone else's words, not correcting their own stored memory.
      if (match.index !== undefined && isWithinQuotes(content, match.index)) {
        continue;
      }

      const targetHint = extractTargetHint(content, match);
      const correctedAssertion = extractCorrectedAssertion(content, pattern.polarity);
      const dedupKey = `${i}:${pattern.polarity}:${targetHint}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      results.push({
        targetHint,
        correctedAssertion,
        polarity: pattern.polarity,
        handles,
        confidence: pattern.confidence,
        sourceExcerpt: content.slice(0, 200),
        turnIndex: i,
      });
    }
  }

  return results;
}
