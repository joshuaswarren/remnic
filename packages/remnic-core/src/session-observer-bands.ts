import type { SessionObserverBandConfig } from "./types.js";

export const DEFAULT_SESSION_OBSERVER_BANDS: SessionObserverBandConfig[] = [
  { maxBytes: 50_000, triggerDeltaBytes: 4_800, triggerDeltaTokens: 1_200 },
  { maxBytes: 200_000, triggerDeltaBytes: 9_600, triggerDeltaTokens: 2_400 },
  { maxBytes: 1_000_000_000, triggerDeltaBytes: 19_200, triggerDeltaTokens: 4_800 },
];

export function cloneDefaultSessionObserverBands(): SessionObserverBandConfig[] {
  return DEFAULT_SESSION_OBSERVER_BANDS.map((band) => ({ ...band }));
}
