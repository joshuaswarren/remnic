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

import type { WearableConversation } from "./types.js";

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

const OFF_THE_RECORD = /\boff\s+the\s+record\b/i;
const BACK_ON_THE_RECORD = /\b(?:back\s+)?on\s+the\s+record\b/i;

export interface OffTheRecordResult {
  conversation: WearableConversation;
  droppedSegments: number;
}

/**
 * Drop segments between a spoken "off the record" marker and the next
 * "(back) on the record" marker (or conversation end). The marker
 * segments themselves are kept, with the off-record span replaced by a
 * visible placeholder so the transcript shows that content was elided
 * by request rather than lost.
 */
export function applyOffTheRecord(
  conversation: WearableConversation,
): OffTheRecordResult {
  let offRecord = false;
  let droppedSegments = 0;
  const segments = [];
  for (const segment of conversation.segments) {
    if (!offRecord && OFF_THE_RECORD.test(segment.text)) {
      offRecord = true;
      segments.push({
        ...segment,
        text: "[off the record — segment elided]",
      });
      continue;
    }
    if (offRecord) {
      if (BACK_ON_THE_RECORD.test(segment.text)) {
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
