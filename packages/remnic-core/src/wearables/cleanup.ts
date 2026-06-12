/**
 * Wearable transcript cleanup — deterministic, zero-LLM normalization.
 *
 * ASR output from always-on wearables is noisy: fragmented utterances,
 * filler tokens, stuttered repeats, and occasional pure garbage. This
 * module cleans a conversation in place-order without changing meaning:
 * everything here is conservative and reversible by re-syncing.
 */

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
 * Standalone filler tokens stripped when `stripFillers` is on. Matched
 * case-insensitively on word boundaries, only as whole tokens — "um"
 * inside "umbrella" is never touched. Deliberately short, low-risk
 * list; meaning-bearing hedges ("like", "well") are NOT stripped.
 */
const FILLER_TOKENS = ["um", "uh", "uhm", "umm", "uhh", "erm", "hmm", "mhm"];

const FILLER_PATTERN = new RegExp(
  // Leading/trailing punctuation around the filler collapses with it so
  // "Um, so we should" -> "so we should" rather than ", so we should".
  `(?:^|\\s)(?:${FILLER_TOKENS.join("|")})[,.]?(?=\\s|$)`,
  "gi",
);

/** Apply configured cleanup passes to one conversation. */
export function cleanConversation(
  conversation: WearableConversation,
  settings: WearableCleanupSettings,
): CleanupResult {
  let segments = conversation.segments.map((segment) => ({ ...segment }));
  let droppedSegments = 0;
  let mergedSegments = 0;

  if (settings.stripFillers) {
    for (const segment of segments) {
      segment.text = stripFillerTokens(segment.text);
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
      if (previous && canMerge(previous, segment)) {
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
): boolean {
  if (previous.speakerKey !== next.speakerKey) return false;
  const previousEnd = previous.endIso ? Date.parse(previous.endIso) : NaN;
  const nextStart = next.startIso ? Date.parse(next.startIso) : NaN;
  // Without timestamps, adjacency is the only signal — still merge.
  if (Number.isNaN(previousEnd) || Number.isNaN(nextStart)) return true;
  return nextStart - previousEnd <= MERGE_GAP_MS;
}

export function stripFillerTokens(text: string): string {
  return normalizeWhitespace(text.replace(FILLER_PATTERN, " "));
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
