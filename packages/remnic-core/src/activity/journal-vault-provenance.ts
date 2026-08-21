/**
 * Build provenance for journal-derived memories (issue #1987).
 *
 * Pure: no I/O, no clock — the day comes from the caller. The source is
 * validated through the journal-source parser, so `structuredAttributes.
 * journalSource` is always a canonical journal source value ("file" |
 * "vault"), never a re-declared copy of the allow-list. Exported helper;
 * caller wiring into journal memory generation is a later slice.
 */
import { resolveJournalSource } from "./journal-source.js";

export interface JournalMemoryProvenance {
  tags: string[];
  structuredAttributes: Record<string, string>;
  validAt: string;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function buildJournalMemoryProvenance(input: {
  /** Journal source; must be one of the journal-source allow-list values. */
  source: string;
  /** Journal day, YYYY-MM-DD. */
  date: string;
}): JournalMemoryProvenance {
  if (typeof input.source !== "string") {
    throw new RangeError("journal provenance source must be a string");
  }
  const resolved = resolveJournalSource({
    source: input.source,
    // Provenance never consumes the heading; vault mode just requires a
    // non-empty one to resolve.
    heading: "journal",
  });
  if (!resolved.ok) {
    throw new RangeError(
      `journal provenance source must be one of "file", "vault": ${JSON.stringify(input.source)}`,
    );
  }

  if (typeof input.date !== "string" || !DAY_PATTERN.test(input.date)) {
    throw new RangeError(
      `journal provenance date must be exactly YYYY-MM-DD: ${JSON.stringify(input.date)}`,
    );
  }
  const [year, month, day] = input.date
    .split("-")
    .map(Number) as [number, number, number];
  // Round-trip through UTC rejects non-calendar days (2026-02-30) and the
  // two-digit-year Date.UTC remap (0026 -> 1926) without reading a clock.
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new RangeError(
      `journal provenance date must be a real calendar day: ${input.date}`,
    );
  }

  return {
    tags: ["journal", `journal-day:${input.date}`],
    structuredAttributes: { journalSource: resolved.mode },
    validAt: `${input.date}T00:00:00.000Z`,
  };
}
