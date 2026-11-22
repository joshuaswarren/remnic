
export const DEFAULT_NAVIGATION_WINDOW_SNAPSHOTS = 3;

/** Ids served by one recall snapshot, newest snapshot first when passed in. */
export interface NavigationSnapshot {
  servedIds: readonly string[];
}

export type NavigationAuthorityResult =
  | { ok: true; memoryId: string }
  | { ok: false; error: "empty_id" | "not_served" };

export function assertIdInNavigationWindow(input: {
  snapshots: readonly NavigationSnapshot[];
  memoryId: unknown;
  windowSnapshots?: number;
}): NavigationAuthorityResult {
  const windowSnapshots = input.windowSnapshots ?? DEFAULT_NAVIGATION_WINDOW_SNAPSHOTS;
  if (!Number.isInteger(windowSnapshots) || windowSnapshots < 1) {
    throw new RangeError(
      `windowSnapshots must be a positive integer; got ${JSON.stringify(windowSnapshots)}`,
    );
  }
  if (typeof input.memoryId !== "string" || input.memoryId.trim() === "") {
    return { ok: false, error: "empty_id" };
  }
  const wanted = input.memoryId.trim();
  for (const snapshot of input.snapshots.slice(0, windowSnapshots)) {
    if (!snapshot || !Array.isArray(snapshot.servedIds)) {
      continue;
    }
    for (const served of snapshot.servedIds) {
      if (typeof served === "string" && served.trim() === wanted) {
        return { ok: true, memoryId: wanted };
      }
    }
  }
  return { ok: false, error: "not_served" };
}
