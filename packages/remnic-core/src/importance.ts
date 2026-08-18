/**
 * Local Importance Scoring (Phase 1B)
 *
 * Zero-LLM heuristic system that evaluates each memory's significance.
 * Analyzes content for markers like explicit importance statements,
 * personal information, instructions, emotional content, and factual density.
 */

import type { ImportanceLevel, ImportanceScore, MemoryCategory, MemoryFile } from "./types.js";
import { cjkBigrams, hasLatinWord, informationalLength } from "./utils/script-aware-text.js";

// ---------------------------------------------------------------------------
// Marker patterns for each tier
// ---------------------------------------------------------------------------

/** Critical importance markers (0.9-1.0) */
const CRITICAL_PATTERNS = [
  // Explicit importance
  /\b(critical|crucial|essential|must|always|never)\b/i,
  /\b(important|remember this|don't forget)\b/i,
  // Personal identity
  /\b(my name is|i am|i'm called)\b/i,
  /\b(my (birthday|phone|email|address|ssn|password))\b/i,
  // Strong preferences
  /\b(i (hate|love|despise|adore))\b/i,
  /\b(absolutely|definitely|certainly) (not|must|should)\b/i,
  // Corrections (high weight)
  /\b(actually|no,? that's wrong|correction:?|let me correct)\b/i,
  /\b(i said|i meant|i was wrong)\b/i,
];

/** High importance markers (0.7-0.9) */
const HIGH_PATTERNS = [
  // Decisions
  /\b(decided|decision|chose|choosing|picked|selected)\b/i,
  /\b(we('ll| will) (go with|use|implement))\b/i,
  // Instructions
  /\b(make sure|ensure|always|don't|do not|never|avoid)\b/i,
  /\b(you (should|must|need to))\b/i,
  // Temporal references (deadlines, schedules)
  /\b(by (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
  /\b(deadline|due (date|by)|by (end of|next))\b/i,
  /\b(tomorrow|next week|this week|today)\b/i,
  // Preferences
  /\b(i (prefer|like|want|need|dislike))\b/i,
  /\b(my (preference|style|approach|way))\b/i,
  // Commitments
  /\b(i('ll| will)|promise|commit|guarantee)\b/i,
  /\b(scheduled|appointment|meeting|call)\b/i,
];


/** Low importance markers (0.2-0.4) */
const LOW_PATTERNS = [
  // Uncertainty
  /\b(maybe|perhaps|possibly|might|could be)\b/i,
  /\b(i think|i guess|not sure|uncertain)\b/i,
  /\b(probably|likely|seems like)\b/i,
  // Hedging
  /\b(kind of|sort of|somewhat|a bit)\b/i,
  /\b(in a way|to some extent)\b/i,
];

/** Trivial content markers (0.0-0.2) */
const TRIVIAL_PATTERNS = [
  // Greetings and filler
  /^(hi|hello|hey|yo|sup|greetings)[.!,]?\s*$/i,
  /^(ok|okay|k|sure|yes|no|yep|nope|yeah|nah)[.!]?\s*$/i,
  /^(thanks|thank you|thx|ty|cheers)[.!]?\s*$/i,
  /^(got it|understood|roger|copy|noted)[.!]?\s*$/i,
  /^(bye|goodbye|later|see ya|ttyl)[.!]?\s*$/i,
  /^(lol|haha|hehe|lmao|rofl)[.!]?\s*$/i,
  /^(hmm+|uhh*|ahh*|err*|umm*)[.!]?\s*$/i,
];

// ---------------------------------------------------------------------------
// Category-based importance boosts
// ---------------------------------------------------------------------------

const CATEGORY_BOOSTS: Record<MemoryCategory, number> = {
  correction: 0.15,        // Corrections are always important
  principle: 0.12,         // Durable rules/values
  rule: 0.11,              // Causal IF→THEN rules
  procedure: 0.10,         // Repeatable workflows (issue #519)
  preference: 0.10,        // User preferences matter
  commitment: 0.10,        // Promises/obligations
  reasoning_trace: 0.09,   // Stored reasoning chains (issue #564)
  decision: 0.08,          // Decisions with rationale
  relationship: 0.05,      // Entity relationships
  skill: 0.05,             // Capabilities
  moment: 0.03,            // Emotional milestones
  entity: 0.02,            // Entity facts
  fact: 0.00,              // Base facts, no boost
};

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/** Common stop words to filter out */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "dare",
  "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by",
  "from", "as", "into", "through", "during", "before", "after", "above",
  "below", "between", "under", "again", "further", "then", "once",
  "here", "there", "when", "where", "why", "how", "all", "each", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only",
  "own", "same", "so", "than", "too", "very", "just", "and", "but",
  "or", "if", "because", "until", "while", "this", "that", "these",
  "those", "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves", "he", "him", "his",
  "himself", "she", "her", "hers", "herself", "it", "its", "itself",
  "they", "them", "their", "theirs", "themselves", "what", "which",
  "who", "whom", "whose", "am", "been", "being", "about", "against",
]);

/**
 * Extract salient keywords from content.
 * Returns top N keywords sorted by relevance.
 */
function extractKeywords(content: string, maxKeywords: number = 5): string[] {
  // Latin words plus CJK bigrams, so non-Latin content still yields
  // keywords (pure-CJK prose returned none before #2192).
  const candidates = [
    ...content
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
    ...cjkBigrams(content),
  ];

  // Count frequencies
  const freq = new Map<string, number>();
  for (const word of candidates) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  // Sort by frequency, take top N
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

/**
 * Calculate importance score for a memory.
 * Pure local heuristics, zero LLM calls.
 */
export function scoreImportance(
  content: string,
  category: MemoryCategory,
  tags: string[] = [],
): ImportanceScore {
  const reasons: string[] = [];
  let score = 0.5; // Start at normal baseline

  const contentLength = content.length;

  // Check for trivial content first (short-circuit)
  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(content)) {
      return {
        score: 0.1,
        level: "trivial",
        reasons: ["Trivial content (greeting, filler, or very short)"],
        keywords: [],
      };
    }
  }

  // Very short content. informationalLength weights CJK/Hangul 3:1, so a
  // dense non-Latin sentence ("予約しました") is not trivial for being
  // under 10 raw characters while its English equivalent is not (#2192).
  const weightedLength = informationalLength(content);
  if (weightedLength >= 1 && weightedLength <= 10) {
    return {
      score: 0.1,
      level: "trivial",
      reasons: ["Trivial content (greeting, filler, or very short)"],
      keywords: [],
    };
  }

  // Documented non-Latin fallback (#2192): the English keyword tiers below
  // cannot fire without Latin words, so the score rests on the 0.5 baseline
  // plus script-agnostic signals (category boost, length, digits, tags).
  if (!hasLatinWord(content)) {
    reasons.push("Non-Latin script: keyword tiers not applicable; script-agnostic signals only");
  }

  // Check critical patterns
  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(content)) {
      score += 0.20;
      reasons.push(`Critical marker: ${pattern.source.slice(0, 30)}`);
      break; // Only count once per tier
    }
  }

  // Check high patterns
  for (const pattern of HIGH_PATTERNS) {
    if (pattern.test(content)) {
      score += 0.12;
      reasons.push(`High importance marker detected`);
      break;
    }
  }

  // Check low patterns (reduces score)
  for (const pattern of LOW_PATTERNS) {
    if (pattern.test(content)) {
      score -= 0.15;
      reasons.push(`Uncertainty/hedging detected`);
      break;
    }
  }

  // Category boost
  const categoryBoost = CATEGORY_BOOSTS[category] ?? 0;
  if (categoryBoost > 0) {
    score += categoryBoost;
    reasons.push(`Category boost: ${category}`);
  }

  // Length bonus (longer = more substance, capped)
  if (contentLength > 200) {
    const lengthBonus = Math.min((contentLength - 200) / 1000, 0.1);
    score += lengthBonus;
    if (lengthBonus > 0.05) {
      reasons.push("Substantial content length");
    }
  }

  // Check for personal pronouns (signals personal relevance)
  if (/\b(my|mine|i|i'm|i've|i'd|i'll)\b/i.test(content)) {
    score += 0.05;
    reasons.push("Personal reference");
  }

  // Check for numbers/specifics (concrete details)
  if (/\b\d{2,}\b/.test(content) || /\b(version|v\d|api|config)\b/i.test(content)) {
    score += 0.03;
    reasons.push("Contains specific details");
  }

  // Tag-based boosts
  const importantTags = tags.filter((t) =>
    ["important", "critical", "preference", "decision", "rule", "principle"].includes(t.toLowerCase())
  );
  if (importantTags.length > 0) {
    score += 0.05 * importantTags.length;
    reasons.push(`Important tags: ${importantTags.join(", ")}`);
  }

  // Clamp score to 0-1 range
  score = Math.max(0, Math.min(1, score));

  // Determine level from score
  let level: ImportanceLevel;
  if (score >= 0.9) {
    level = "critical";
  } else if (score >= 0.7) {
    level = "high";
  } else if (score >= 0.4) {
    level = "normal";
  } else if (score >= 0.2) {
    level = "low";
  } else {
    level = "trivial";
  }

  // Extract keywords
  const keywords = extractKeywords(content);

  return {
    score: Math.round(score * 100) / 100, // Round to 2 decimal places
    level,
    reasons: reasons.slice(0, 5), // Cap at 5 reasons
    keywords,
  };
}

/**
 * Recompute importance for an existing memory file using current local heuristics.
 */
export function rescoreMemoryImportance(memory: MemoryFile): ImportanceScore {
  return scoreImportance(memory.content, memory.frontmatter.category, memory.frontmatter.tags ?? []);
}

/**
 * Get importance level from numeric score.
 */
export function importanceLevel(score: number): ImportanceLevel {
  if (score >= 0.9) return "critical";
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "normal";
  if (score >= 0.2) return "low";
  return "trivial";
}

// ---------------------------------------------------------------------------
// Importance threshold helper (issue #372)
// ---------------------------------------------------------------------------

/**
 * Ordering for importance levels used by the extraction write gate.
 * Higher indices mean more important.
 */
const IMPORTANCE_LEVEL_RANK: Record<ImportanceLevel, number> = {
  trivial: 0,
  low: 1,
  normal: 2,
  high: 3,
  critical: 4,
};

/**
 * Return true if `candidate` meets or exceeds `threshold`. Used by the
 * extraction write gate in orchestrator.persistExtraction() to drop trivial
 * content before it is written to the memory store.
 *
 * Note: callers should pass the ALREADY-BOOSTED level returned by
 * scoreImportance(), because category boosts (e.g. corrections) are applied
 * inside scoreImportance() before the level is derived.
 */
export function isAboveImportanceThreshold(
  candidate: ImportanceLevel,
  threshold: ImportanceLevel,
): boolean {
  return IMPORTANCE_LEVEL_RANK[candidate] >= IMPORTANCE_LEVEL_RANK[threshold];
}
