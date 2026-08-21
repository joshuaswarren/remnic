/**
 * PII privacy sweep for training export records.
 *
 * Belt-and-suspenders check that runs after Remnic's own
 * privacy controls.  Scans instruction, input, and output
 * fields for common PII patterns and replaces matches with
 * [REDACTED].
 */

import type { TrainingExportRecord } from "@remnic/core";

export interface PrivacySweepResult {
  cleanRecords: TrainingExportRecord[];
  redactedCount: number;
  redactionDetails: { index: number; field: string; pattern: string }[];
}

interface PiiPattern {
  name: string;
  regex: RegExp;
  validate?: (match: string) => boolean;
}

function normalizeCardCandidate(value: string): string {
  return value.replace(/[-\s]/g, "");
}

function passesLuhn(value: string): boolean {
  let sum = 0;
  let doubleDigit = false;

  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = Number(value[i]);
    if (!Number.isInteger(digit)) return false;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }

  return sum > 0 && sum % 10 === 0;
}

function isCreditCardCandidate(match: string): boolean {
  const digits = normalizeCardCandidate(match);
  return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
}

const CREDIT_CARD_PATTERNS: PiiPattern[] = [19, 18, 17, 16, 15, 14, 13].map(
  (digitCount) => ({
    name: "credit_card",
    regex: new RegExp(`\\b\\d(?:[-\\s]?\\d){${digitCount - 1}}\\b`, "g"),
    validate: isCreditCardCandidate,
  }),
);

/**
 * Ordered list of PII patterns.
 *
 * Order matters: more specific patterns (SSN, credit card)
 * come before broader ones (phone) to avoid partial matches.
 */
const PII_PATTERNS: PiiPattern[] = [
  {
    // Email: user@domain.tld
    name: "email",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  {
    // SSN: 123-45-6789 (exactly 3-2-4 digit groups)
    name: "ssn",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  // Credit card: 13-19 digits, optionally separated by dashes or spaces.
  // Try longest candidates first so valid 19-digit cards are preserved while
  // shorter cards next to numeric metadata can still be reconsidered.
  ...CREDIT_CARD_PATTERNS,
  {
    // IP address: four octets 0-255
    name: "ip_address",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },
  {
    // Phone: optional +1- prefix, then 3-3-4 with dashes, dots, or spaces
    // Also matches (555) 123-4567 format
    name: "phone",
    regex: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
  },
];

const SCANNED_FIELDS: (keyof Pick<TrainingExportRecord, "instruction" | "input" | "output">)[] = [
  "instruction",
  "input",
  "output",
];

/**
 * Scan and redact PII from training export records.
 *
 * Returns a new array of cleaned records, leaving the originals
 * unmodified.  The `redactedCount` is the number of records that
 * had at least one redaction.  `redactionDetails` lists every
 * individual match with its record index, field, and pattern name.
 */
export function sweepPii(records: TrainingExportRecord[]): PrivacySweepResult {
  const redactionDetails: PrivacySweepResult["redactionDetails"] = [];
  const recordHasRedaction = new Set<number>();

  const cleanRecords = records.map((record, idx) => {
    const cleaned: TrainingExportRecord = { ...record };

    for (const field of SCANNED_FIELDS) {
      let value = record[field];
      if (!value) continue;

      for (const pattern of PII_PATTERNS) {
        // Reset lastIndex for global regex reuse
        pattern.regex.lastIndex = 0;
        value = value.replace(pattern.regex, (match) => {
          if (pattern.validate && !pattern.validate(match)) return match;
          recordHasRedaction.add(idx);
          redactionDetails.push({
            index: idx,
            field,
            pattern: pattern.name,
          });
          return "[REDACTED]";
        });
      }

      cleaned[field] = value;
    }

    return cleaned;
  });

  return {
    cleanRecords,
    redactedCount: recordHasRedaction.size,
    redactionDetails,
  };
}
