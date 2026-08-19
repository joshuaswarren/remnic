/**
 * Shared-item provenance stamp (issue #1957).
 *
 * First slice: stamp actor + at onto a new object. Curation wiring
 * comes later. Does not mutate the input.
 */

export interface ProvenanceStamp {
  actor: string;
  at: string;
}

export interface StampProvenanceOptions {
  actor: string;
  at: string;
}

// Linear ISO instant. No nested quantifiers.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isStrictIsoTimestamp(value: string): boolean {
  const match = ISO_INSTANT.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    Number.isFinite(Date.parse(value)) &&
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day &&
    utc.getUTCHours() === hour &&
    utc.getUTCMinutes() === minute &&
    utc.getUTCSeconds() === second
  );
}

function requireActor(actor: string): string {
  if (typeof actor !== "string" || actor.trim().length === 0) {
    throw new Error("stampProvenance: actor must be a non-empty string");
  }
  return actor;
}

function requireAt(at: unknown): string {
  if (typeof at !== "string" || !isStrictIsoTimestamp(at)) {
    throw new Error("stampProvenance: at must be a valid ISO-8601 timestamp");
  }
  return at;
}

export function stampProvenance<T extends object>(
  item: T,
  stamp: StampProvenanceOptions,
): T & { provenance: ProvenanceStamp } {
  return {
    ...item,
    provenance: {
      actor: requireActor(stamp.actor),
      at: requireAt(stamp.at),
    },
  };
}
