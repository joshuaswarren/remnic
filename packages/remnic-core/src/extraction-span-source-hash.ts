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

/**
 * Hash the exact string. No trimming, no newline normalization.
 *
 * The digest covers UTF-16LE code units, not UTF-8 bytes: Node's UTF-8
 * encoder replaces an unpaired surrogate with U+FFFD before hashing, so
 * "\ud800", "\ud801", and "\ufffd" all produce ONE digest under utf8 and
 * drift between them would verify as unchanged. Unpaired surrogates reach
 * real memory text through JSON escapes, and this stamp exists to catch
 * exactly that class of silent substitution, so it hashes a lossless
 * representation of the string instead.
 */
export function stampSpanSource(text: string): SpanSourceStamp {
  requireText(text);
  const hash = createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex");
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
  // Project the caller's stamp down to exactly the two stamp fields. Echoing
  // the original object would re-export any extra property it carries — a
  // `source` field holding the text defeats the whole point of a stamp, which
  // exists so the content does not have to travel.
  const safeExpected: SpanSourceStamp = { hash: expected.hash, length: expected.length };
  if (actual.length !== safeExpected.length) {
    return { ok: false, error: "length_mismatch", expected: safeExpected, actual };
  }
  if (actual.hash !== safeExpected.hash) {
    return { ok: false, error: "hash_mismatch", expected: safeExpected, actual };
  }
  return { ok: true };
}
