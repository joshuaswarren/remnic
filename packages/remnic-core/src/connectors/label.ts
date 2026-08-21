/**
 * connectors/label.ts — shared constants for rendering a connector identity
 * into model-visible surfaces (issue #2183).
 *
 * `CONNECTOR_ID_PATTERN` is the canonical persisted-ID charset (re-exported from
 * index.ts so callers don't depend on the registry module's internals).
 * `CONNECTOR_LABEL_MAX_LENGTH` is the display bound shared by the recall
 * renderer and the extraction-side helper (#2184) so the two cannot drift.
 *
 * The recall renderer TRUNCATES past the bound (attribution survives); #2184
 * SUPPRESSES instead, because a truncated id in a prompt could collide with a
 * different connector whereas a truncated display label cannot mislead the same
 * way. Kept in its own module so the capped registry file (connectors/index.ts)
 * stays at its ratchet ceiling.
 */
export { CONNECTOR_ID_PATTERN } from "./index.js";
import { loadRegistry, BUILTIN_CONNECTORS } from "./index.js";

export const CONNECTOR_LABEL_MAX_LENGTH = 64;

let knownIds: ReadonlySet<string> | null = null;
let knownIdsAt = 0;
const KNOWN_IDS_TTL_MS = 60_000;

export function knownConnectorIds(): ReadonlySet<string> {
  const now = Date.now();
  if (knownIds !== null && now - knownIdsAt < KNOWN_IDS_TTL_MS) return knownIds;
  try {
    const ids = new Set(loadRegistry().connectors.map((c: { id: string }) => c.id));
    knownIds = ids;
    knownIdsAt = now;
    return knownIds;
  } catch {
    return new Set(BUILTIN_CONNECTORS.map((c: { id: string }) => c.id));
  }
}
