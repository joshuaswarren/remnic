/**
 * Error taxonomy for @remnic/capture-audio.
 *
 * Two authored-message classes, mirroring the wearables split
 * (packages/remnic-core/src/wearables/errors.ts): configuration problems
 * and caller-correctable input. Both carry operator-safe messages (never
 * foreign error text, never credentials). The HTTP layer maps
 * CaptureInputError to 400; anything else is a backend fault (500).
 */

/** Config load/validation failure — surfaced loudly, never silently defaulted (rule 39). */
export class CaptureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureConfigError";
  }
}

/** Caller-correctable request/CLI input — maps to HTTP 400. */
export class CaptureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureInputError";
  }
}
