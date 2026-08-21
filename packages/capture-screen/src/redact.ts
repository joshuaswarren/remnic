/**
 * Daemon-side redaction, applied to snapshot text BEFORE it is hashed or
 * written to the spool. Built-in patterns catch US SSNs and payment-card
 * numbers (13–19 digits, optionally space/dash grouped, Luhn-valid); the user's
 * `redactionPatterns` (regex source strings) are applied in addition. Every
 * match is replaced with a fixed placeholder so the redacted text is stable
 * (identical inputs dedup identically).
 */

import { CaptureConfigError } from "./errors.js";

export const REDACTION_PLACEHOLDER = "[REDACTED]";

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
/** Candidate card runs: 13–19 digits with optional single space/dash separators. */
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactCards(text: string): string {
  return text.replace(CARD_RE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
    return REDACTION_PLACEHOLDER;
  });
}

/** Compile user regex source strings once; an invalid pattern fails loudly. */
export function compileRedactionPatterns(sources: readonly string[]): RegExp[] {
  return sources.map((source) => {
    try {
      return new RegExp(source, "g");
    } catch {
      throw new CaptureConfigError(`redactionPatterns: '${source}' is not a valid regular expression`);
    }
  });
}

/** Apply built-in (SSN, card) then user redactions to `text`. */
export function redactText(text: string, userPatterns: readonly RegExp[] = []): string {
  let out = text.replace(SSN_RE, REDACTION_PLACEHOLDER);
  out = redactCards(out);
  for (const pattern of userPatterns) {
    // Reset lastIndex: a shared global RegExp carries state between calls.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return out;
}
