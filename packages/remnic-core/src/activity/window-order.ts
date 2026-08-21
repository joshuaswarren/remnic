/**
 * Assert a half-open activity window [fromMs, toMs) (issue #2053 leftover).
 *
 * Non-finite bounds throw. `toMs <= fromMs` is empty_window.
 */

export type AssertHalfOpenWindowResult =
  | { ok: true }
  | { ok: false; error: "empty_window" };

/** Validate `[fromMs, toMs)`. Empty or inverted windows fail closed. */
export function assertHalfOpenWindow(window: {
  fromMs: number;
  toMs: number;
}): AssertHalfOpenWindowResult {
  const { fromMs, toMs } = window;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new RangeError(
      `activity window bounds must be finite; got fromMs=${fromMs} toMs=${toMs}`,
    );
  }
  if (toMs <= fromMs) return { ok: false, error: "empty_window" };
  return { ok: true };
}
