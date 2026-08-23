/**
 * DST-aware local-day window — thin adapter over @remnic/core's canonical
 * `activityDayWindow` (issue #2821). capture-screen previously carried an
 * inlined copy of the offset-probe algorithm; it drifted behind core's
 * second-granularity transition fixes (#2814), so the copy is deleted and the
 * DST math is core's. The public API and the CaptureInputError mapping are
 * unchanged.
 */

import { activityDayWindow as coreDayWindow } from "@remnic/core/activity/digest";

import { CaptureInputError } from "./errors.js";

/** Half-open [startUtc, endUtc) UTC ISO bounds of a local day. */
export function activityDayWindow(date: string, timezone: string): { startUtc: string; endUtc: string } {
  try {
    return coreDayWindow(date, timezone);
  } catch (error) {
    // core signals caller-correctable date/timezone problems with RangeError;
    // capture-screen's public contract maps those to CaptureInputError (HTTP
    // 400). Anything else is a backend fault and propagates unmasked.
    if (error instanceof RangeError) throw new CaptureInputError(error.message);
    throw error;
  }
}
