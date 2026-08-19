/**
 * Drop listed keys from one activity item (issue #2053).
 */

export interface ActivityRedactOptions {
  dropKeys: readonly string[];
}

/**
 * Return a shallow copy without `dropKeys`.
 * Unknown keys are ignored. Empty `dropKeys` is a shallow copy.
 * Does not mutate `item`.
 */
export function redactActivityFields<T extends Record<string, unknown>>(
  item: T,
  options: ActivityRedactOptions,
): T {
  const result: Record<string, unknown> = { ...item };
  for (const key of options.dropKeys) {
    delete result[key];
  }
  return result as T;
}
