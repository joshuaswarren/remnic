/**
 * Wearable transcript redaction — privacy guard applied before any
 * transcript text is persisted or fed to extraction.
 *
 * Always-on recorders capture things nobody intended to store: card
 * numbers read aloud, SSNs dictated to a pharmacy line. Built-in
 * patterns cover the unambiguous, high-sensitivity cases; users can add
 * their own regexes via `wearables.redactionPatterns` (validated at
 * config parse — invalid patterns are rejected loudly, never ignored).
 *
 * All built-in patterns are simple linear scans (no nested quantifiers)
 * to stay safely outside polynomial-ReDoS territory.
 */

import { buildPhraseMatcher } from "./text-language.js";
import type {
  OffTheRecordMarkerSettings,
  WearableConversation,
} from "./types.js";

export const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * Built-in patterns. Conservative by design — false positives erase
 * real transcript content, so each pattern targets formats that are
 * near-certain PII:
 *  - US SSN with separators (123-45-6789). Bare 9-digit runs are NOT
 *    matched (too many false positives: ids, tracking numbers).
 *  - Payment-card-like runs: 13–19 digits in groups separated by
 *    spaces/dashes (4111 1111 1111 1111) or contiguous 15–16 digits.
 */
const BUILT_IN_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  // Starts and ENDS on a digit so a trailing separator is never
  // consumed (replacing it would glue the placeholder to the next word).
  /\b\d(?:[ -]?\d){12,18}\b/g,
];

/** Minimum digit count before a digit-run is treated as a card number. */
const CARD_MIN_DIGITS = 13;

export interface RedactionResult {
  text: string;
  redactions: number;
}

export function redactText(
  text: string,
  userPatterns: RegExp[],
): RedactionResult {
  let redactions = 0;
  let result = text;

  // SSN pattern first (more specific than the digit-run pattern).
  result = result.replace(BUILT_IN_PATTERNS[0], () => {
    redactions += 1;
    return REDACTION_PLACEHOLDER;
  });

  // Digit-run pattern with a post-match digit-count check so short
  // grouped numbers ("call 555 0125 today") survive.
  result = result.replace(BUILT_IN_PATTERNS[1], (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < CARD_MIN_DIGITS || digits.length > 19) {
      return match;
    }
    redactions += 1;
    return REDACTION_PLACEHOLDER;
  });

  for (const pattern of userPatterns) {
    result = result.replace(pattern, () => {
      redactions += 1;
      return REDACTION_PLACEHOLDER;
    });
  }

  return { text: result, redactions };
}

/**
 * Compile user-supplied redaction patterns. Throws with a descriptive
 * message on the first invalid pattern — config parsing surfaces this
 * to the operator instead of silently skipping the rule.
 */
export function compileRedactionPatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern, index) => {
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
      throw new Error(
        `wearables.redactionPatterns[${index}] must be a non-empty string`,
      );
    }
    if (pattern.length > 256) {
      throw new Error(
        `wearables.redactionPatterns[${index}] exceeds 256 characters — redaction patterns must stay short`,
      );
    }
    try {
      // Operator-supplied regexes from the operator's own config —
      // length-capped above; never request input.
      return new RegExp(pattern, "gi");
    } catch (err) {
      throw new Error(
        `wearables.redactionPatterns[${index}] is not a valid regular expression: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

/**
 * Built-in phrases that BEGIN an off-the-record span.
 *
 * Conservative by design: a false positive elides real transcript
 * content. Every phrase is a fixed multi-word expression, or a loanword
 * that only means "off the record" (issue #2196). Operators extend this
 * list through `wearables.offTheRecordMarkers.start`.
 */
export const BUILT_IN_OFF_THE_RECORD_START: readonly string[] = [
  "off the record",
  "fuera de registro",
  "extraoficialmente",
  "fora de registro",
  "fora do registro",
  "hors micro",
  "nicht fürs protokoll",
  "nicht für das protokoll",
  "fuori registro",
  "オフレコ",
  "오프더레코드",
  "不要记录",
  "не для протокола",
  "بدون تسجيل",
];

/**
 * Built-in phrases that END an off-the-record span.
 *
 * Shorter than the start list on purpose. A start phrase with no
 * matching end phrase elides through the end of the conversation, which
 * is the fail-closed direction; an over-eager end phrase would leak. So
 * a language only appears here when the phrase is unambiguous.
 */
export const BUILT_IN_OFF_THE_RECORD_END: readonly string[] = [
  "back on the record",
  "on the record",
  "de nuevo en registro",
  "de volta ao registro",
  "wieder fürs protokoll",
  "wieder für das protokoll",
  "オンレコ",
  "온더레코드",
];

/**
 * Loose form of the parsed `OffTheRecordMarkerSettings`: callers that
 * only override one field pass a partial, so every property is
 * optional and read-only here.
 */
export type OffTheRecordMarkerInput = {
  readonly [K in keyof OffTheRecordMarkerSettings]?: K extends "useBuiltIns"
    ? boolean
    : readonly string[];
};

export interface CompiledOffTheRecordMarkers {
  start: RegExp | null;
  end: RegExp | null;
}

/**
 * Compile marker settings into matchers. Omitting `settings` yields the
 * built-in lists, so callers that never configured markers keep the
 * previous behavior plus the new languages.
 */
export function compileOffTheRecordMarkers(
  settings?: OffTheRecordMarkerInput,
): CompiledOffTheRecordMarkers {
  const useBuiltIns = settings?.useBuiltIns !== false;
  const start = [
    ...(useBuiltIns ? BUILT_IN_OFF_THE_RECORD_START : []),
    ...(settings?.start ?? []),
  ];
  const end = [
    ...(useBuiltIns ? BUILT_IN_OFF_THE_RECORD_END : []),
    ...(settings?.end ?? []),
  ];
  return {
    start: buildPhraseMatcher(start),
    end: buildPhraseMatcher(end),
  };
}

export interface OffTheRecordResult {
  conversation: WearableConversation;
  droppedSegments: number;
}

/**
 * Drop segments between a spoken off-the-record marker and the next
 * back-on-the-record marker (or conversation end). The marker segments
 * themselves are kept, with the off-record span replaced by a visible
 * placeholder so the transcript shows that content was elided by
 * request rather than lost.
 */
export function applyOffTheRecord(
  conversation: WearableConversation,
  markers: CompiledOffTheRecordMarkers = compileOffTheRecordMarkers(),
): OffTheRecordResult {
  if (!markers.start) {
    return { conversation, droppedSegments: 0 };
  }
  let offRecord = false;
  let droppedSegments = 0;
  const segments = [];
  for (const segment of conversation.segments) {
    // Matched in NFC, stored as written: the transcript keeps the ASR's
    // own bytes while a decomposed spelling still reaches the marker.
    const probe = segment.text.normalize("NFC");
    if (!offRecord && markers.start.test(probe)) {
      offRecord = true;
      segments.push({
        ...segment,
        text: "[off the record — segment elided]",
      });
      continue;
    }
    if (offRecord) {
      if (markers.end?.test(probe)) {
        offRecord = false;
        segments.push({
          ...segment,
          text: "[back on the record]",
        });
      } else {
        droppedSegments += 1;
      }
      continue;
    }
    segments.push(segment);
  }
  return {
    conversation: { ...conversation, segments },
    droppedSegments,
  };
}
