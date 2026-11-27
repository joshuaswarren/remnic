
/** Product gates that must be SUCCESS when present-or-required. */
export const REQUIRED_PRODUCT_CHECKS = ["build", "tests (root)", "tests (packages-1)", "tests (packages-2)"];

/** Present-only gate: blocks when it exists and is not SUCCESS. */
export const PRESENT_ONLY_GATES = ["unresolved-review-threads"];


const isSuccess = (check) => String(check?.state ?? "").toUpperCase() === "SUCCESS";

/**
 * Newest row per context name. A ruleset evaluates the LATEST check-run for a
 * context, so a stale SUCCESS must never mask the current FAILURE. A plain
 * `Map` keeps the last row for a duplicate name, which is input order —
 * arbitrary — so prefer the greater `completedAt` when the caller supplies it.
 *
 * @param {Array<{name: string, state: string, completedAt?: string}>} rows
 */
function newestByName(rows) {
  const byName = new Map();
  for (const row of rows) {
    const name = String(row?.name ?? "");
    const previous = byName.get(name);
    if (previous === undefined) {
      byName.set(name, row);
      continue;
    }
    if (String(row?.completedAt ?? "") >= String(previous?.completedAt ?? "")) {
      byName.set(name, row);
    }
  }
  return byName;
}

/**
 * @param {Array<{name: string, state: string, bucket?: string, completedAt?: string}>} checks
 * @returns {{ready: boolean, blockers: string[]}}
 */
export function evaluateMergeReadiness(checks) {
  const rows = Array.isArray(checks) ? checks : [];
  const byName = newestByName(rows);
  const blockers = [];

  for (const name of REQUIRED_PRODUCT_CHECKS) {
    const check = byName.get(name);
    if (!check) {
      blockers.push(`${name}: missing (required product gate)`);
    } else if (!isSuccess(check)) {
      blockers.push(`${name}: ${check.state ?? "unknown"}`);
    }
  }

  for (const name of PRESENT_ONLY_GATES) {
    const check = byName.get(name);
    if (check && !isSuccess(check)) blockers.push(`${name}: ${check.state ?? "unknown"}`);
  }


  return { ready: blockers.length === 0, blockers };
}
