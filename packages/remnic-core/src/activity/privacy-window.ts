/**
 * Half-open activity privacy window (issue #2053).
 */
import { shouldRetain } from "./privacy.js";

export interface PrivacyWindowItem {
  capturedAtMs: number;
}

export interface PrivacyWindowOptions {
  fromMs: number;
  toMs: number;
  retainDays: number;
}

/**
 * Keep items in `[fromMs, toMs)`.
 * `retainDays` 0 keeps all ages. `retainDays` N drops older than N days before `toMs`.
 * `toMs <= fromMs` returns `[]`.
 */
export function filterPrivacyWindow<T extends PrivacyWindowItem>(
  items: readonly T[],
  options: PrivacyWindowOptions,
): T[] {
  const { fromMs, toMs, retainDays } = options;
  if (toMs <= fromMs) return [];
  return items.filter((item) => {
    const capturedAtMs = item.capturedAtMs;
    if (capturedAtMs < fromMs || capturedAtMs >= toMs) return false;
    return shouldRetain(capturedAtMs, toMs, retainDays);
  });
}
