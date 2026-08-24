/**
 * Normalize a journal section heading (issue #1987 leftover).
 *
 * Trim. Empty is empty_heading. Newline is invalid_heading.
 */

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
