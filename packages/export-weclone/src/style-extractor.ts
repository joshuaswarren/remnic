/**
 * Communication style marker extraction.
 *
 * Analyzes text samples using simple heuristics to produce
 * a StyleMarkers profile.  No LLM calls — pure regex and
 * counting.
 */

export interface StyleMarkers {
  avgSentenceLength: number;
  usesEmoji: boolean;
  formality: "formal" | "casual" | "mixed";
  usesLowercase: boolean;
  commonPhrases: string[];
}

/**
 * Regex matching most common emoji code-point ranges.
 * Covers Emoticons, Dingbats, Transport/Map symbols,
 * Misc symbols, and supplemental blocks.
 */
const EMOJI_RE =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{2702}-\u{27B0}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2328}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{200D}\u{20E3}\u{FE0F}\u{E0020}-\u{E007F}\u{2B50}\u{2B55}\u{2934}\u{2935}\u{25AA}-\u{25FE}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{231A}\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25FB}-\u{25FE}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{2934}\u{2935}]/u;

/** Words/phrases that signal formal register. */
const FORMAL_MARKERS = [
  "furthermore",
  "however",
  "therefore",
  "moreover",
  "consequently",
  "nevertheless",
  "in addition",
  "accordingly",
  "subsequently",
  "regarding",
  "pertaining",
  "shall",
  "hereby",
  "whereas",
  "notwithstanding",
  "henceforth",
  "aforementioned",
  "please consider",
  "would like to",
  "i would",
  "appreciation",
  "recommendations",
  "thoroughly",
  "documentation",
];

/** Words/phrases that signal casual register. */
const CASUAL_MARKERS = [
  "gonna",
  "wanna",
  "kinda",
  "sorta",
  "gotta",
  "dunno",
  "lemme",
  "yeah",
  "yep",
  "nah",
  "lol",
  "omg",
  "tbh",
  "imo",
  "btw",
  "nope",
  "cuz",
  "tho",
  "ain't",
  "y'all",
  "awesome",
  "cool",
  "dude",
  "bro",
  "bruh",
];

/** Minimum occurrences for a phrase to count as "common". */
const MIN_PHRASE_FREQUENCY = 2;

/** Maximum number of common phrases to return. */
const MAX_COMMON_PHRASES = 10;

/**
 * Analyse text samples and extract communication style markers.
 */
export function extractStyleMarkers(samples: string[]): StyleMarkers {
  if (samples.length === 0) {
    return {
      avgSentenceLength: 0,
      usesEmoji: false,
      formality: "mixed",
      usesLowercase: false,
      commonPhrases: [],
    };
  }

  const joined = samples.join(" ");

  return {
    avgSentenceLength: calcAvgSentenceLength(joined),
    usesEmoji: detectEmoji(joined),
    formality: detectFormality(joined),
    usesLowercase: detectLowercase(joined),
    commonPhrases: findCommonPhrases(samples),
  };
}

// ── Internals ────────────────────────────────────────────

function calcAvgSentenceLength(text: string): number {
  // Split on sentence-ending punctuation, filter empties
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) return 0;

  const totalWords = sentences.reduce((sum, s) => {
    const words = s.split(/\s+/).filter((w) => w.length > 0);
    return sum + words.length;
  }, 0);

  return Math.round((totalWords / sentences.length) * 10) / 10;
}

function detectEmoji(text: string): boolean {
  return EMOJI_RE.test(text);
}

function detectFormality(text: string): "formal" | "casual" | "mixed" {
  const lower = text.toLowerCase();

  let formalScore = 0;
  for (const marker of FORMAL_MARKERS) {
    // Word-boundary matching prevents false positives
    // (e.g., "tho" matching inside "those" or "method")
    if (new RegExp(`\\b${marker}\\b`, "i").test(lower)) formalScore++;
  }

  let casualScore = 0;
  for (const marker of CASUAL_MARKERS) {
    if (new RegExp(`\\b${marker}\\b`, "i").test(lower)) casualScore++;
  }

  // Threshold: need at least 2 markers to declare a style
  const THRESHOLD = 2;

  if (formalScore >= THRESHOLD && formalScore > casualScore) return "formal";
  if (casualScore >= THRESHOLD && casualScore > formalScore) return "casual";
  return "mixed";
}

function detectLowercase(text: string): boolean {
  // Split into sentences and check what fraction start with lowercase
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) return false;

  const lowercaseStarts = sentences.filter((s) => {
    const firstChar = s.charAt(0);
    return firstChar === firstChar.toLowerCase() && firstChar !== firstChar.toUpperCase();
  }).length;

  // Majority (>50%) of sentences start lowercase
  return lowercaseStarts / sentences.length > 0.5;
}

/**
 * Check whether a character is alphanumeric (ASCII a-z, A-Z, 0-9) using
 * code-point comparison. Pure function — no regex, no backtracking.
 */
function isAlnum(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) // a-z
  );
}

/**
 * Strip leading and trailing non-alphanumeric characters from `word` using
 * a single linear scan on each side. This replaces the previous
 * `/^[^a-zA-Z0-9]+/` / `/[^a-zA-Z0-9]+$/` regexes, which CodeQL flagged as
 * polynomial ReDoS on uncontrolled input (e.g. long `///...///` runs).
 */
function trimNonAlnum(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && !isAlnum(word.charAt(start))) start++;
  while (end > start && !isAlnum(word.charAt(end - 1))) end--;
  return start === 0 && end === word.length ? word : word.slice(start, end);
}

function findCommonPhrases(samples: string[]): string[] {
  const phraseCount = new Map<string, number>();

  for (const sample of samples) {
    // Tokenize: split on whitespace, strip edge punctuation with a linear
    // scan (no regex) to eliminate the polynomial backtracking that the
    // previous `replace(/^[^a-zA-Z0-9]+/, "")` chain exposed.
    const words = sample
      .split(/\s+/)
      .map((w) => trimNonAlnum(w))
      .filter((w) => w.length > 0);

    // Build 2-gram and 3-gram phrases
    const seenInSample = new Set<string>();
    for (let ngramSize = 2; ngramSize <= 3; ngramSize++) {
      for (let i = 0; i <= words.length - ngramSize; i++) {
        const phrase = words.slice(i, i + ngramSize).join(" ").toLowerCase();
        // Only count once per sample to avoid inflating from repetition within one sample
        if (!seenInSample.has(phrase)) {
          seenInSample.add(phrase);
          phraseCount.set(phrase, (phraseCount.get(phrase) ?? 0) + 1);
        }
      }
    }
  }

  // Filter by minimum frequency and sort by count descending, then alphabetical for stability
  return [...phraseCount.entries()]
    .filter(([, count]) => count >= MIN_PHRASE_FREQUENCY)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, MAX_COMMON_PHRASES)
    .map(([phrase]) => phrase);
}
