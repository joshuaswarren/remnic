/**
 * Span source stamp/verify (issue #2333).
 *
 * Offsets index the exact normalized string sent to the model. If that string
 * drifts before materialization, the offsets point at different characters and
 * a wrong quote is persisted as verbatim source. The stamp lets materialization
 * detect the drift without carrying the source text alongside it.
 *
 * Pure apart from hashing: no I/O, no clock, no randomness. The input text is
 * never mutated and never appears in a result or error message.
 */

import { createHash } from "node:crypto";

export interface SpanSourceStamp {
  /** Hex digest of the exact string the model was shown. */
  hash: string;
  /** Length of that string, so a mismatch reports which dimension drifted. */
  length: number;
}

export type SpanSourceCheck =
  | { ok: true }
  | {
      ok: false;
      error: "length_mismatch" | "hash_mismatch";
      expected: SpanSourceStamp;
      actual: SpanSourceStamp;
    };

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function requireText(text: string): void {
  if (typeof text !== "string") {
    throw new TypeError(`text must be a string, got ${typeof text}`);
  }
}

function requireStamp(expected: SpanSourceStamp): void {
  if (!Object.hasOwn(expected, "hash")) {
    throw new RangeError("expected stamp is missing field hash");
  }
  if (!Object.hasOwn(expected, "length")) {
    throw new RangeError("expected stamp is missing field length");
  }
  const { hash, length } = expected;
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
    throw new RangeError(
      "expected stamp field hash must be 64 lowercase hex characters",
    );
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(
      "expected stamp field length must be a non-negative integer",
    );
  }
}

/** Hash the exact string. No trimming, no newline normalization. */
export function stampSpanSource(text: string): SpanSourceStamp {
  requireText(text);
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return { hash, length: text.length };
}

/**
 * Verify the materialized string against its stamp. Length is compared first:
 * it is the cheaper, more diagnostic dimension. Mismatch results carry both
 * stamps and never the text itself.
 */
export function verifySpanSource(
  text: string,
  expected: SpanSourceStamp,
): SpanSourceCheck {
  requireText(text);
  requireStamp(expected);
  const actual = stampSpanSource(text);
  if (actual.length !== expected.length) {
    return { ok: false, error: "length_mismatch", expected, actual };
  }
  if (actual.hash !== expected.hash) {
    return { ok: false, error: "hash_mismatch", expected, actual };
  }
  return { ok: true };
}
