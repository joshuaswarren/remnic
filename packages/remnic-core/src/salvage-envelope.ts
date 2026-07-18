import {
  composeMemoryEnvelope,
  type MemoryWriteInput,
  type SealedMemoryEnvelope,
  type WriteContext,
} from "./write-envelope.js";
import { log } from "./logger.js";

/**
 * Shared salvage-compose helper for MACHINE-GENERATED or replayed-from-store
 * write input (issue #1989 PR4): one malformed optional field must not abort
 * the surrounding batch/action, and every drop is warn-logged with the
 * caller's label — visible, never silent (rule 34).
 *
 * Operator/system-built input must NOT use this — compose strict so caller
 * bugs surface (see AGENTS.md "Sealed memory-write envelope").
 */
export function composeSalvagedEnvelope(
  label: string,
  input: MemoryWriteInput,
  ctx: WriteContext,
): SealedMemoryEnvelope {
  const envelope = composeMemoryEnvelope(input, ctx, { salvage: true });
  if (envelope.salvageNotes.length > 0) {
    log.warn(`${label} write salvaged invalid fields: ${envelope.salvageNotes.join("; ")}`);
  }
  return envelope;
}
