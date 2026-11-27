
import { activityDayWindow as coreDayWindow } from "@remnic/core/activity/digest";

import { CaptureInputError } from "./errors.js";

/** Half-open [startUtc, endUtc) UTC ISO bounds of a local day. */
export function activityDayWindow(date: string, timezone: string): { startUtc: string; endUtc: string } {
  try {
    return coreDayWindow(date, timezone);
  } catch (error) {
    // capture-screen's public contract maps those to CaptureInputError (HTTP
    // 400). Anything else is a backend fault and propagates unmasked.
    if (error instanceof RangeError) throw new CaptureInputError(error.message);
    throw error;
  }
}
