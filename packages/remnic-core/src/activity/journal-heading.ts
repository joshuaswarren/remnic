/**
 * Normalize a journal section heading (issue #1987 leftover).
 *
 * Trim. Empty is empty_heading. Newline is invalid_heading.
 */

import { parseAtxHeading } from "./journal-section.js";

export type NormalizeJournalHeadingResult =
  | { ok: true; heading: string }
  | { ok: false; error: "empty_heading" | "invalid_heading" };

export function normalizeJournalHeading(value: string): NormalizeJournalHeadingResult {
  const heading = value.trim();
  if (heading.length === 0) return { ok: false, error: "empty_heading" };
  if (heading.includes("\n") || heading.includes("\r")) {
    return { ok: false, error: "invalid_heading" };
  }
  return { ok: true, heading };
}

/**
 * The accepted config domain of `vault.readback.journalSection` must equal
 * what the shared heading parser can produce (issue #2894): the read path
 * compares `parseAtxHeading(line).text` to the configured value with `===`.
 * A name the parser can never return — leading/trailing whitespace it
 * trims, line breaks it cannot see (a heading is one line), other control
 * characters, or a trailing `#` run it strips as a closing sequence —
 * loads today but makes every `show` and `extract` report
 * `missing_heading`. Reject those at parse time instead.
 */
export type ValidateJournalSectionNameResult =
  | { ok: true }
  | { ok: false; error: "empty_heading" | "untrimmed_heading" | "control_character" | "unmatchable_heading" };

export function validateJournalSectionName(value: string): ValidateJournalSectionNameResult {
  if (value.trim().length === 0) return { ok: false, error: "empty_heading" };
  if (value !== value.trim()) return { ok: false, error: "untrimmed_heading" };
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return { ok: false, error: "control_character" };
    }
  }
  const parsed = parseAtxHeading(`## ${value}`);
  if (parsed === null || parsed.text !== value) return { ok: false, error: "unmatchable_heading" };
  return { ok: true };
}

/**
 * Legacy `activity.timeline.journal.heading` → `vault.readback.journalSection`.
 * The new key wins when both are present; the legacy key is still validated.
 */
export function applyLegacyJournalHeading(input: {
  journalSection: string;
  heading: unknown;
}): { journalSection: string; usedLegacyHeading: boolean; ignoredLegacyHeading: boolean } {
  if (input.heading === undefined) {
    return { journalSection: input.journalSection, usedLegacyHeading: false, ignoredLegacyHeading: false };
  }
  if (typeof input.heading !== "string") {
    throw new TypeError("activity.timeline.journal.heading must be a string");
  }
  const normalized = normalizeJournalHeading(input.heading);
  if (!normalized.ok) {
    throw new RangeError(
      normalized.error === "empty_heading"
        ? "activity.timeline.journal.heading must be a non-empty string"
        : "activity.timeline.journal.heading must not contain a newline",
    );
  }
  if (input.journalSection.trim().length > 0) {
    return {
      journalSection: input.journalSection,
      usedLegacyHeading: false,
      ignoredLegacyHeading: true,
    };
  }
  return {
    journalSection: normalized.heading,
    usedLegacyHeading: true,
    ignoredLegacyHeading: false,
  };
}
