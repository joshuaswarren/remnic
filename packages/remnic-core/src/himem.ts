/**
 * HiMem — Episode/Note dual store (v8.0 Phase 2B)
 *
 * Classifies extracted memories as:
 *   episode — time-specific events, actions, observations (event fidelity)
 *   note    — stable beliefs, preferences, decisions, constraints
 *
 * Based on the HiMem paper: episodes are ephemeral, notes are reconsolidated
 * into a stable belief layer. This classification gates reconsolidation.
 */

export type MemoryKind = "episode" | "note";

/**
 * Keywords that signal a stable belief/preference/constraint.
 * Includes present and past tense to catch extraction phrasing like
 * "user preferred X" or "team needed Y".
 */
const NOTE_SIGNALS = [
  /\bprefer(?:red|s|ring)?\b/i,
  /\bwant(?:ed|s|ing)?\b/i,
  /\bneed(?:ed|s|ing)?\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bmust\b/i,
  /\bshould\b/i,
  /\bgoals?\b/i,
  /\bdecid(?:ed|es|e|ing)\b/i,
  /\bpolic(?:y|ies)\b/i,
  /\brequir(?:ed|es?|ements?|ing)\b/i,
  /\bconstraints?\b/i,
  /\bstandards?\b/i,
  /\bconventions?\b/i,
];

/**
 * Unambiguous date/time markers — checked at step 1 (highest priority) before
 * category overrides.  Only include signals that cannot appear in stable-belief
 * sentences (e.g. "today I prefer…" is contrived; "yesterday" in a preference
 * is almost always a past event).
 *
 * Note: "just" excluded — it too often means "merely/only".
 */
const TEMPORAL_SIGNALS = [
  /\byesterday\b/i,
  /\btoday\b/i,
  /\blast\s+(?:week|month|year|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\bon\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\b(?:recently|earlier|this morning|this afternoon)\b/i,
];

/**
 * Past-tense action verbs that suggest an episodic memory.
 * Checked AFTER category overrides (step 3.5) to avoid misclassifying
 * stable-knowledge sentences like "User mentioned they always prefer X"
 * where category="preference" should win over the verb "mentioned".
 */
const VERB_EPISODE_SIGNALS = [
  /\bdeployed\b/i,
  /\bpushed\b/i,
  /\bfixed\b/i,
  /\bmerged\b/i,
  /\breported\b/i,
  /\bmentioned\b/i,
  /\bsaid\b/i,
  /\bhappened\b/i,
  /\bfailed\b/i,
  /\bcompleted\b/i,
  /\bshipped\b/i,
];

/** Category names that strongly suggest a note (stable belief) */
const NOTE_CATEGORIES = new Set([
  "preference",
  "constraint",
  "goal",
  "habit",
  "policy",
  "standard",
  "belief",
  "decision",
  "principle",     // durable operating rules emitted by extraction
  "commitment",    // deadlines/promises — stable obligations
  "relationship",  // durable facts about people/entities
  "skill",         // capabilities — stable knowledge
  "correction",    // user corrections — durable override of prior belief
  "entity",        // stable facts about people, projects, tools, etc.
]);

/** Category names that strongly suggest an episode */
const EPISODE_CATEGORIES = new Set(["event", "action", "observation", "issue", "bug", "incident", "moment"]);

/** Tag values that signal a stable belief */
const NOTE_TAGS = new Set(["preference", "constraint", "goal", "habit", "policy", "belief"]);

/** Tag values that signal a time-specific event */
const EPISODE_TAGS = new Set(["bug", "fix", "deploy", "incident", "release", "merge", "event"]);

/**
 * Classify a memory fact as "episode" (time-specific event) or "note"
 * (stable belief/preference/decision).
 *
 * @param content   - The memory's text content
 * @param tags      - Tags from extraction (checked for episode/note signals)
 * @param category  - Category from extraction
 * @returns "episode" | "note"
 */
export function classifyMemoryKind(
  content: string,
  tags: string[],
  category: string,
): MemoryKind {
  const lowerContent = content.toLowerCase();
  const lowerCategory = category.toLowerCase();

  // 1. True temporal markers — unambiguous date/time references override everything.
  //    These are safe at highest priority because genuine date/time phrases cannot
  //    appear in a stable-belief sentence without making it episodic.
  for (const re of TEMPORAL_SIGNALS) {
    if (re.test(lowerContent)) return "episode";
  }

  // 2. Category-level override — strong semantic signal from extraction
  if (NOTE_CATEGORIES.has(lowerCategory)) return "note";
  if (EPISODE_CATEGORIES.has(lowerCategory)) return "episode";

  // 3. Tag-level signals — lower priority than category; note tags win over episode tags
  //    to avoid non-deterministic results when tag order varies across LLM runs.
  let tagMatchesNote = false;
  let tagMatchesEpisode = false;
  for (const tag of tags) {
    const lowerTag = tag.toLowerCase();
    if (NOTE_TAGS.has(lowerTag)) tagMatchesNote = true;
    if (EPISODE_TAGS.has(lowerTag)) tagMatchesEpisode = true;
  }
  if (tagMatchesNote) return "note";
  if (tagMatchesEpisode) return "episode";

  // 3.5. Verb-based episode signals — run after category so that stable categories
  //      (preference, principle, etc.) are not overridden by common narrative verbs
  //      like "mentioned" or "said" (e.g. "User mentioned they always prefer X").
  for (const re of VERB_EPISODE_SIGNALS) {
    if (re.test(lowerContent)) return "episode";
  }

  // 4. Non-temporal note signals in content
  for (const re of NOTE_SIGNALS) {
    if (re.test(lowerContent)) return "note";
  }

  // 5. Default: episode (preserves fidelity, safer to not promote to stable note)
  return "episode";
}

