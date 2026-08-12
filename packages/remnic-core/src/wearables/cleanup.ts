/**
 * Wearable transcript cleanup — deterministic, zero-LLM normalization.
 *
 * ASR output from always-on wearables is noisy: fragmented utterances,
 * filler tokens, stuttered repeats, and occasional pure garbage. This
 * module cleans a conversation in place-order without changing meaning:
 * everything here is conservative and reversible by re-syncing.
 */

import { detectScriptHints, type ScriptHint } from "./text-language.js";
import type {
  WearableCleanupSettings,
  WearableConversation,
  WearableTranscriptSegment,
} from "./types.js";

export interface CleanupResult {
  conversation: WearableConversation;
  /** Segments removed by the low-quality heuristic. */
  droppedSegments: number;
  /** Segments merged into a predecessor. */
  mergedSegments: number;
}

/** Merge consecutive same-speaker segments when gaps are below this. */
const MERGE_GAP_MS = 30_000;

/**
 * Speaker labels that carry no real diarization signal. Bee (and other
 * providers that fall back to a placeholder) emit "Unknown"/"unknown"
 * or an empty string when diarization is unavailable; merging on such a
 * label would collapse an entire conversation into one segment (issue #1811).
 */
const GENERIC_SPEAKER_PATTERN = /^unknown$/i;

/**
 * Standalone filler tokens stripped when `stripFillers` is on, for
 * scripts that separate words with spaces. Matched case-insensitively
 * as whole tokens — "um" inside "umbrella" is never touched.
 * Deliberately short and low-risk: meaning-bearing hedges ("like",
 * "well", Spanish "este", Arabic "يعني") are NOT stripped, and neither
 * is "mm", which is also a unit of length.
 */
const TOKEN_FILLERS: Readonly<Partial<Record<ScriptHint, readonly string[]>>> = {
  latin: [
    "um",
    "uh",
    "uhm",
    "umm",
    "uhh",
    "erm",
    "hmm",
    "mhm",
    "ähm",
    "äh",
    "ehm",
    "euh",
    "mmm",
  ],
  korean: ["음", "으음", "엄", "어어"],
  arabic: ["امم", "اممم", "اه"],
  cyrillic: ["эм", "ээ", "ммм"],
};

/**
 * Filler tokens for scripts without word spaces. These are removed
 * inline, so each entry must be unambiguous on its own: the elongated
 * Japanese hesitation forms and the two Chinese hesitation particles
 * qualify, while a bare 「あの」 ("that") does not (issue #2196).
 */
const INLINE_FILLERS: Readonly<Partial<Record<ScriptHint, readonly string[]>>> = {
  japanese: ["えーと", "えっと", "ええと", "あのー", "あのう", "うーん"],
  han: ["呃", "嗯"],
};

/**
 * Punctuation that trails a filler and collapses with it, so
 * 「えーと、では」 becomes 「では」 rather than 「、では」. Arabic sentence
 * punctuation is included: an Arabic filler is normally followed by
 * `،`, and without it the token survives the pass.
 */
const TRAILING_FILLER_PUNCTUATION = "[,.、。،؛؟!?]?";

interface FillerMatchers {
  token: RegExp | null;
  inline: RegExp | null;
}

/**
 * Compiled matchers are cached per (script hints + extra tokens) key.
 * A day of transcripts is thousands of segments over a handful of
 * scripts, so this compiles a few regexes instead of one per segment.
 */
const FILLER_MATCHER_CACHE = new Map<string, FillerMatchers>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build one alternation from `tokens`, or `null` when none remain.
 *
 * JavaScript alternation is first-match, not longest-match, so the
 * tokens are sorted longest-first. Without that a built-in prefix such
 * as 「あのー」 would match ahead of a longer operator token that starts
 * with it and leave the tail in the transcript. Ties break on the token
 * itself so the pattern is stable across runs.
 */
function buildAlternation(
  tokens: readonly string[],
  shape: (pattern: string) => { source: string; flags: string },
): RegExp | null {
  const unique = [...new Set(tokens)].sort(
    (left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0),
  );
  if (unique.length === 0) return null;
  const { source, flags } = shape(unique.map((token) => escapeRegExp(token)).join("|"));
  return new RegExp(source, flags);
}

function buildFillerMatchers(
  hints: readonly ScriptHint[],
  extraTokens: readonly string[],
): FillerMatchers {
  // Structural key: comma-joining collapses `["a,b"]` and `["a","b"]`
  // onto one entry, and the first caller's regex would then clean the
  // second caller's transcripts.
  const key = JSON.stringify([hints, extraTokens]);
  const cached = FILLER_MATCHER_CACHE.get(key);
  if (cached) return cached;

  const tokens: string[] = [];
  const inline: string[] = [];
  for (const hint of hints) {
    tokens.push(...(TOKEN_FILLERS[hint] ?? []));
    inline.push(...(INLINE_FILLERS[hint] ?? []));
  }
  // Operator tokens apply to every script: the operator knows their own
  // language, and routing them by script hint would silently drop them.
  for (const extra of extraTokens) {
    const trimmed = extra.trim();
    if (trimmed.length === 0) continue;
    if (SPACE_DELIMITED_TOKEN.test(trimmed)) tokens.push(trimmed);
    else inline.push(trimmed);
  }

  const matchers: FillerMatchers = {
    token: buildAlternation(tokens, (pattern) => ({
      source: `(?:^|\\s)(?:${pattern})${TRAILING_FILLER_PUNCTUATION}(?=\\s|$)`,
      flags: "giu",
    })),
    inline: buildAlternation(inline, (pattern) => ({
      source: `(?:${pattern})${TRAILING_FILLER_PUNCTUATION}`,
      flags: "gu",
    })),
  };
  FILLER_MATCHER_CACHE.set(key, matchers);
  return matchers;
}

/**
 * A token whose first character belongs to a space-delimited script.
 *
 * Anything outside this set is removed INLINE, so a script that does
 * space its words must appear here. Hebrew `אה` routed to the inline
 * matcher would strip the suffix of `נראה` and corrupt the transcript.
 */
const SPACE_DELIMITED_TOKEN =
  /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{N}]/u;

/** Apply configured cleanup passes to one conversation. */
export function cleanConversation(
  conversation: WearableConversation,
  settings: WearableCleanupSettings,
  extraFillerTokens: readonly string[] = [],
): CleanupResult {
  let segments = conversation.segments.map((segment) => ({ ...segment }));
  let droppedSegments = 0;
  let mergedSegments = 0;
  // Optional on the type so other connectors keep the legacy no-op
  // default; absent means "off" (unchanged merge behavior).
  const preserveBoundaries = settings.preserveUtteranceBoundaries === true;

  if (settings.stripFillers) {
    for (const segment of segments) {
      segment.text = stripFillerTokens(segment.text, extraFillerTokens);
    }
  }

  if (settings.collapseRepeats) {
    for (const segment of segments) {
      segment.text = collapseImmediateRepeats(segment.text);
    }
  }

  for (const segment of segments) {
    segment.text = normalizeWhitespace(segment.text);
  }

  if (settings.dropLowQuality) {
    const kept: WearableTranscriptSegment[] = [];
    for (const segment of segments) {
      if (isLowQualitySegment(segment.text)) {
        droppedSegments += 1;
      } else {
        kept.push(segment);
      }
    }
    segments = kept;
  } else {
    // Even without the quality heuristic, segments whose text became
    // empty after filler stripping carry no information.
    const kept = segments.filter((segment) => segment.text.length > 0);
    droppedSegments += segments.length - kept.length;
    segments = kept;
  }

  if (settings.mergeSameSpeaker) {
    const merged: WearableTranscriptSegment[] = [];
    for (const segment of segments) {
      const previous = merged[merged.length - 1];
      if (previous && canMerge(previous, segment, preserveBoundaries)) {
        previous.text = `${previous.text} ${segment.text}`.trim();
        if (segment.endIso) previous.endIso = segment.endIso;
        mergedSegments += 1;
      } else {
        merged.push(segment);
      }
    }
    segments = merged;
  }

  return {
    conversation: { ...conversation, segments },
    droppedSegments,
    mergedSegments,
  };
}

function canMerge(
  previous: WearableTranscriptSegment,
  next: WearableTranscriptSegment,
  preserveUtteranceBoundaries: boolean,
): boolean {
  if (previous.speakerKey !== next.speakerKey) return false;
  // A generic/low-confidence speaker label ("Unknown", empty) carries no
  // real diarization: merging on it collapses unrelated utterances. When
  // the source opts into boundary preservation, refuse to merge across
  // such a label (issue #1811). The keys are equal here, so checking one
  // suffices; diarized labels still merge normally.
  if (preserveUtteranceBoundaries) {
    const label = previous.speakerKey.trim();
    if (label.length === 0 || GENERIC_SPEAKER_PATTERN.test(label)) return false;
  }
  const previousEnd = previous.endIso
    ? Date.parse(previous.endIso)
    : Number.NaN;
  const nextStart = next.startIso ? Date.parse(next.startIso) : Number.NaN;
  // Without timestamps, adjacency is the only signal — still merge.
  if (Number.isNaN(previousEnd) || Number.isNaN(nextStart)) return true;
  return nextStart - previousEnd <= MERGE_GAP_MS;
}

/**
 * Remove filler tokens from `text`. The built-in token set is chosen
 * from the scripts present in the text, so a Japanese or Korean segment
 * is cleaned by its own list instead of silently keeping every filler
 * (issue #2196). Operator tokens apply to every script.
 */
export function stripFillerTokens(
  text: string,
  extraTokens: readonly string[] = [],
): string {
  const matchers = buildFillerMatchers(detectScriptHints(text), extraTokens);
  let result = text;
  if (matchers.token) result = result.replace(matchers.token, " ");
  if (matchers.inline) result = result.replace(matchers.inline, "");
  return normalizeWhitespace(result);
}

/**
 * Collapse immediate word/phrase stutters: "I I I think" -> "I think",
 * "we should we should go" -> "we should go". Only collapses *adjacent*
 * repeats (up to 4-word phrases) so intentional repetition across a
 * sentence is preserved.
 */
export function collapseImmediateRepeats(text: string): string {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length < 2) return text.trim();
  const out: string[] = [];
  let index = 0;
  while (index < words.length) {
    out.push(words[index]);
    index += 1;
    // Greedily consume every adjacent repeat of the phrase that just
    // ended at the output tail (largest phrase first, then re-check so
    // "I I I think" fully collapses to "I think").
    let matched = true;
    while (matched) {
      matched = false;
      for (let size = 4; size >= 1; size--) {
        if (out.length < size || index + size > words.length) continue;
        const tail = out.slice(-size).join(" ").toLowerCase();
        // Spoken digit sequences legitimately repeat ("555 555 1234");
        // never collapse a phrase that carries no letters.
        if (!/\p{L}/u.test(tail)) continue;
        const ahead = words.slice(index, index + size).join(" ").toLowerCase();
        if (tail === ahead) {
          index += size;
          matched = true;
          break;
        }
      }
    }
  }
  return out.join(" ");
}

/**
 * Heuristic ASR-garbage detector. Intentionally conservative: it only
 * drops segments that carry no plausible information.
 */
export function isLowQualitySegment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Single repeated character runs ("aaaaaa", "######").
  if (/^(.)\1{4,}$/.test(trimmed)) return true;
  // Mostly non-letter content with no digits (timestamps/amounts are
  // information; "%$#@!" is not).
  const letters = trimmed.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length === 0) return true;
  if (trimmed.length >= 12 && letters.length / trimmed.length < 0.3) {
    return true;
  }
  // One identical token repeated many times ("yeah yeah yeah yeah yeah").
  const words = trimmed.toLowerCase().split(/\s+/);
  if (words.length >= 5) {
    const unique = new Set(words);
    if (unique.size === 1) return true;
  }
  return false;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
