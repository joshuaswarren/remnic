/**
 * Shared-item provenance stamp (issue #1957).
 *
 * First slice: stamp actor + at onto a new object. Curation wiring
 * comes later. Does not mutate the input.
 */

import { isStrictIsoInstant } from "./iso-instant.js";

export interface ProvenanceStamp {
  actor: string;
  at: string;
}

export interface StampProvenanceOptions {
  actor: string;
  at: string;
}

function requireActor(actor: string): string {
  if (typeof actor !== "string" || actor.trim().length === 0) {
    throw new Error("stampProvenance: actor must be a non-empty string");
  }
  return actor;
}

function requireAt(at: unknown): string {
  if (typeof at !== "string" || !isStrictIsoInstant(at)) {
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
