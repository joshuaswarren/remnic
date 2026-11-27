
export type MemoryKind = "episode" | "note";

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

const TEMPORAL_SIGNALS = [
  /\byesterday\b/i,
  /\btoday\b/i,
  /\blast\s+(?:week|month|year|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\bon\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\b(?:recently|earlier|this morning|this afternoon)\b/i,
];

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

const EPISODE_CATEGORIES = new Set(["event", "action", "observation", "issue", "bug", "incident", "moment"]);

const NOTE_TAGS = new Set(["preference", "constraint", "goal", "habit", "policy", "belief"]);

const EPISODE_TAGS = new Set(["bug", "fix", "deploy", "incident", "release", "merge", "event"]);

export function classifyMemoryKind(
  content: string,
  tags: string[],
  category: string,
): MemoryKind {
  const lowerContent = content.toLowerCase();
  const lowerCategory = category.toLowerCase();

  for (const re of TEMPORAL_SIGNALS) {
    if (re.test(lowerContent)) return "episode";
  }

  if (NOTE_CATEGORIES.has(lowerCategory)) return "note";
  if (EPISODE_CATEGORIES.has(lowerCategory)) return "episode";

  let tagMatchesNote = false;
  let tagMatchesEpisode = false;
  for (const tag of tags) {
    const lowerTag = tag.toLowerCase();
    if (NOTE_TAGS.has(lowerTag)) tagMatchesNote = true;
    if (EPISODE_TAGS.has(lowerTag)) tagMatchesEpisode = true;
  }
  if (tagMatchesNote) return "note";
  if (tagMatchesEpisode) return "episode";

  for (const re of VERB_EPISODE_SIGNALS) {
    if (re.test(lowerContent)) return "episode";
  }

  for (const re of NOTE_SIGNALS) {
    if (re.test(lowerContent)) return "note";
  }

  return "episode";
}

